"""
Regenerate all hero data from a local HotS install using HeroesDataParser.

Outputs:
  - data/hero-info.json           (full per-hero reference: stats, abilities, talents)
  - data/talent-names.json        (talent name lookup by hero slug and tier_choice key)
  - data/talent-descriptions.json (talent description lookup, same structure)
  - img/hero/{slug}/avatar.png    (hero select portrait icon, 64x64)
  - img/hero/{slug}/talent{tier}_{choice}.png (talent icons, 64x64)
  - img/hero/{slug}/abilities/{nameId-slug}.png (ability icons, 64x64)

Source: HeroesDataParser (https://github.com/HeroesToolChest/HeroesDataParser)
extracts JSON + images directly from the HotS game files. HDP emits images
at 128x128; this script downscales them to 64x64 and re-encodes the PNGs with
optimisation enabled to roughly halve dashboard payload size.

Channels:
  -release (default) reads the live install, -ptr the Public Test install, each
  with its own game path and HDP output directory. A PTR run only writes heroes
  missing from data/hero-info.json plus ones it previously tagged "ptr": true; a
  release run owns every hero the live build has and drops the tag when one ships.

Prerequisites (one-time, on the machine that runs HDP):
  1. Install the .NET 8.0 SDK manually: https://dotnet.microsoft.com/download/dotnet/8.0
     The Runtime alone is not enough; the SDK is required to install global tools.
     This script intentionally does not auto-install the SDK (system-wide, needs admin).
  2. HeroesDataParser itself is auto-installed on first run after a y/N prompt.
     To install manually:  dotnet tool install --global HeroesDataParser --version 4.14.4
  3. Pillow (Python imaging) is auto-installed on first run after a y/N prompt.
     To install manually:  pip install Pillow

In the dev container, dotnet is not installed. Use --skip-parser to translate
pre-extracted HDP output (e.g. from a Windows run, or the bundled test samples
under .scratch/HeroesDataParser-main/Tests/...).

Usage:
  python generate_hero_data.py                 # full pipeline: HDP + translate + sync
  python generate_hero_data.py -ptr            # same, against the PTR install
  python generate_hero_data.py --skip-parser   # skip HDP, translate existing output
  python generate_hero_data.py --dry-run       # report actions, no writes
"""

import argparse
import glob
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
from typing import NamedTuple

from pipeline.herodata import FEMALE_HEROES, HERO_NAMES, HERO_ROLES

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

SCRATCH_DIR = os.path.join(_PROJECT_ROOT, ".scratch")
DEFAULT_DATA_DIR = os.path.join(_PROJECT_ROOT, "data")
DEFAULT_IMG_DIR = os.path.join(_PROJECT_ROOT, "img", "hero")

CHANNEL_RELEASE = "release"
CHANNEL_PTR = "ptr"

# The .bat wrappers pass the real Windows install paths; these are container-side
# snapshot locations for --skip-parser work.
DEFAULT_GAME_PATHS = {
    CHANNEL_RELEASE: os.path.join(SCRATCH_DIR, "Heroes of the Storm"),
    CHANNEL_PTR: os.path.join(SCRATCH_DIR, "Heroes of the Storm Public Test"),
}

# Separate roots: a shared one would let the PTR build win the selection in
# discover_hero_files and replace the live dataset.
DEFAULT_HDP_OUTPUTS = {
    CHANNEL_RELEASE: os.path.join(SCRATCH_DIR, "hots-data-output"),
    CHANNEL_PTR: os.path.join(SCRATCH_DIR, "hots-data-output-ptr"),
}

HERO_INFO_FILENAME = "hero-info.json"
TALENT_NAMES_FILENAME = "talent-names.json"
TALENT_DESCRIPTIONS_FILENAME = "talent-descriptions.json"
HERO_COLORS_FILENAME = "hero-colors.json"

# Hand-written data for heroes the game files describe incompletely, keyed by slug
# then by ability/talent nameId. Delete an entry once the build carries the real data.
HERO_OVERRIDES_FILENAME = "hero-overrides.json"

# Marks a hero-info.json record as PTR-sourced; the talent files derive theirs from it.
PTR_FLAG = "ptr"

# HDP 5 renamed the tool command and changed the CLI, so the auto-install stays on 4.x.
HDP_VERSION = "4.14.4"

# Ability categories kept in hero-info.json. mount/activable/hearth are generic and
# rarely consulted, so they are excluded to keep the JSON small.
ABILITY_CATEGORIES = ("basic", "heroic", "trait")

# HDP groups talents under levelN keys. Tiers map level# -> tier index used in our keys.
TALENT_LEVELS = (1, 4, 7, 10, 13, 16, 20)

# HDP emits 128x128 icons; the dashboard uses 64x64. Downscale + re-encode with
# Pillow's optimize flag (light, lossless) cuts each PNG to roughly the size of
# the pre-HDP icons that previously shipped in img/hero/.
TARGET_IMAGE_SIZE = (64, 64)


class HeroDataSet(NamedTuple):
    """The three hero data files, each keyed by hero slug."""

    info: dict[str, dict]
    names: dict[str, dict]
    descriptions: dict[str, dict]


def slugify(name: str) -> str:
    """Match the frontend slugify in js/app.js: lowercase, dashes, strip ' ’ ."""
    return (
        name.lower()
        .replace(" ", "-")
        .replace("'", "")
        .replace("’", "")
        .replace(".", "")
    )


def strip_html(text: str) -> str:
    """Strip Blizzard's SC2-style markup. Preserve <n/> as real newlines."""
    if not text:
        return ""
    text = text.replace("<n/>", "\n")
    return re.sub(r"<[^>]+>", "", text)


def file_hash(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def encode_resized_png(src: str) -> bytes:
    """Load src, downscale to TARGET_IMAGE_SIZE, return optimised PNG bytes."""
    from PIL import Image
    with Image.open(src) as im:
        if im.mode not in ("RGBA", "RGB", "LA", "L"):
            im = im.convert("RGBA")
        if im.size != TARGET_IMAGE_SIZE:
            im = im.resize(TARGET_IMAGE_SIZE, Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        return buf.getvalue()


def process_image_if_changed(src: str, dst: str, dry_run: bool) -> bool:
    """Resize+re-encode src and write to dst if the resulting bytes differ from dst."""
    if not os.path.exists(src):
        return False
    new_bytes = encode_resized_png(src)
    if hashlib.md5(new_bytes).hexdigest() == file_hash(dst):
        return False
    if not dry_run:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(new_bytes)
    return True


def ensure_pillow() -> None:
    """Import Pillow, prompting to pip-install it if missing."""
    try:
        import PIL  # noqa: F401
        return
    except ImportError:
        pass
    print("Pillow (PIL) is not installed. It is required to downscale and re-encode icons.")
    if not prompt_yes_no("Install Pillow now?"):
        raise SystemExit(
            "Aborted. To install manually:\n"
            "  pip install Pillow"
        )
    print("Installing Pillow ...")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "Pillow"],
        check=True,
    )
    print("Pillow installed.")


SDK_GUIDANCE = (
    "The .NET 8.0 SDK must be installed manually before HeroesDataParser can be installed\n"
    "or run. The SDK is system-wide and requires admin elevation, so this script does\n"
    "not auto-install it.\n"
    "\n"
    "Download (pick 'SDK', x64 Windows installer):\n"
    "  https://dotnet.microsoft.com/download/dotnet/8.0\n"
    "\n"
    "After install, open a NEW terminal and re-run this script."
)


def list_dotnet_sdks() -> list[str]:
    """Return installed .NET SDK version lines, or empty if runtime-only or dotnet missing."""
    try:
        result = subprocess.run(
            ["dotnet", "--list-sdks"], capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def is_hdp_installed() -> bool:
    """Check whether HeroesDataParser is registered as a global dotnet tool."""
    try:
        result = subprocess.run(
            ["dotnet", "tool", "list", "--global"],
            capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False
    return any("heroesdataparser" in line.lower() for line in result.stdout.splitlines())


def prompt_yes_no(message: str) -> bool:
    """Read a y/N answer from stdin. Default no; only 'y'/'Y' counts as yes."""
    try:
        answer = input(f"{message} [y/N]: ").strip().lower()
    except EOFError:
        return False
    return answer == "y"


def install_hdp() -> None:
    """Install HeroesDataParser as a global dotnet tool. Raises CalledProcessError on failure."""
    print(f"Installing HeroesDataParser {HDP_VERSION} ...")
    subprocess.run(
        ["dotnet", "tool", "install", "--global", "HeroesDataParser", "--version", HDP_VERSION],
        check=True,
    )
    print("HeroesDataParser installed.")


def run_hdp(game_path: str, output_dir: str) -> None:
    """Invoke HeroesDataParser. Raises CalledProcessError on failure."""
    if shutil.which("dotnet") is None:
        raise SystemExit("ERROR: 'dotnet' was not found on PATH.\n\n" + SDK_GUIDANCE)

    if not list_dotnet_sdks():
        raise SystemExit(
            "ERROR: no .NET SDK is installed (the runtime alone cannot install global tools).\n\n"
            + SDK_GUIDANCE
        )

    if not is_hdp_installed():
        print("HeroesDataParser is not installed as a global dotnet tool.")
        print(r"It will be installed into %USERPROFILE%\.dotnet\tools (user-scoped, no admin).")
        if not prompt_yes_no("Install HeroesDataParser now?"):
            raise SystemExit(
                "Aborted. To install manually:\n"
                f"  dotnet tool install --global HeroesDataParser --version {HDP_VERSION}"
            )
        install_hdp()

    # Resolve to absolute paths so the cwd switch below doesn't break them.
    game_path = os.path.abspath(game_path)
    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(SCRATCH_DIR, exist_ok=True)

    cmd = [
        "dotnet", "heroes-data", game_path,
        "-e", "herodata",
        "-i", "herodata-split",
        "--json",
        "--file-split",
        "-o", output_dir,
    ]
    print(f"Running: {' '.join(cmd)}")
    # CASCExplorer (inside HDP) writes debug.log via a relative path, so it lands
    # in the process CWD. Run HDP from .scratch/ to keep that log out of the
    # project root.
    subprocess.run(cmd, check=True, cwd=SCRATCH_DIR)


def split_build_number(split_dir: str) -> int:
    """Return the build number embedded in a splitfiles-{build}-{loc} directory name."""
    match = re.match(r"splitfiles-(\d+)-", os.path.basename(split_dir))
    return int(match.group(1)) if match else -1


def discover_hero_files(hdp_output: str) -> list[str]:
    """Return absolute paths to per-hero JSON files in HDP output.

    Real HDP CLI output with --file-split lands at:
      <output>/json/splitfiles-{build}-{loc}/herodata/{hero}.json
    Earlier patches are left behind there, so only the highest build is read.
    The bundled HDP test samples use a flat <output>/*.json layout.
    """
    split_dirs = sorted(
        glob.glob(os.path.join(hdp_output, "json", "splitfiles-*")),
        key=split_build_number,
    )
    if split_dirs:
        newest = split_dirs[-1]
        split_files = sorted(glob.glob(os.path.join(newest, "herodata", "*.json")))
        if split_files:
            print(f"Using build {split_build_number(newest)} ({os.path.basename(newest)})")
            return split_files

    for d in (os.path.join(hdp_output, "json"), hdp_output):
        if not os.path.isdir(d):
            continue
        flat = sorted(
            os.path.join(d, f) for f in os.listdir(d)
            if f.endswith(".json") and not f.startswith("jsongamestring")
            and not f.startswith("jsonoutput")
        )
        if flat:
            return flat
    return []


def load_hero(path: str) -> tuple[str, dict] | None:
    """Load a per-hero HDP JSON file. Returns (slug, hero_dict) or None."""
    with open(path, encoding="utf-8") as f:
        outer = json.load(f)
    if not outer:
        return None
    # File has a single top-level key (hero ID like "Alarak"); body is the hero dict.
    _, hero = next(iter(outer.items()))
    if not isinstance(hero, dict) or "name" not in hero:
        return None
    return slugify(hero["name"]), hero


def collect_talents_by_tier(hero: dict) -> dict[int, list[dict]]:
    """Return {tier: [talents sorted by HDP sort field]}."""
    talents = hero.get("talents", {})
    result: dict[int, list[dict]] = {}
    for tier in TALENT_LEVELS:
        level_key = f"level{tier}"
        tier_talents = talents.get(level_key, [])
        result[tier] = sorted(tier_talents, key=lambda t: t.get("sort", 0))
    return result


def build_talent_names(talents_out: dict[str, dict]) -> dict[str, str]:
    return {key: talent["name"] for key, talent in talents_out.items()}


def build_talent_descriptions(talents_out: dict[str, dict]) -> dict[str, str]:
    return {key: talent["description"] for key, talent in talents_out.items()}


def build_abilities(hero: dict, overrides: dict) -> dict[str, list[dict]]:
    src = hero.get("abilities", {})
    out: dict[str, list[dict]] = {}
    for category in ABILITY_CATEGORIES:
        entries = []
        for ability in src.get(category, []):
            name_id = ability.get("nameId", "")
            override = overrides.get(name_id, {})
            has_icon = bool(name_id and ability.get("icon"))
            entries.append({
                "id": name_id,
                "name": override.get("name") or ability.get("name", ""),
                "icon": slugify(name_id) + ".png" if has_icon else "",
                "abilityType": ability.get("abilityType", ""),
                "cooldown": ability.get("cooldownTooltip", ""),
                "manaCost": ability.get("energyTooltip", ""),
                "description": override.get("description") or strip_html(ability.get("fullTooltip", "")),
            })
        out[category] = entries
    return out


def build_hero_info(hero: dict, talents_by_tier: dict[int, list[dict]], override: dict) -> dict:
    weapons = hero.get("weapons") or []
    primary = weapons[0] if weapons else {}
    life = hero.get("life") or {}
    talent_overrides = override.get("talents", {})

    # Unnamed talents would render as blank cards. Numbering stays tier-ordered
    # regardless, because replay talent choices index into it.
    talents_out: dict[str, dict] = {}
    for tier, talents in talents_by_tier.items():
        for i, talent in enumerate(talents, 1):
            talent = talent | talent_overrides.get(talent.get("nameId", ""), {})
            if not talent.get("name"):
                continue
            key = f"{tier}_{i}"
            talents_out[key] = {
                "name": talent.get("name", ""),
                "icon": f"talent{key}.png" if talent.get("icon") else "",
                "description": talent.get("description") or strip_html(talent.get("fullTooltip", "")),
                "abilityType": talent.get("abilityType", ""),
                "isQuest": talent.get("isQuest", False),
                "isActive": talent.get("isActive", False),
            }

    record = {
        "name": hero.get("name", ""),
        "franchise": hero.get("franchise", ""),
        "roles": hero.get("roles", []),
        "expandedRole": hero.get("expandedRole", ""),
        "releaseDate": hero.get("releaseDate", ""),
        "radius": hero.get("radius", 0),
        "health": life.get("amount", 0),
        "healthScale": life.get("scale", 0),
        "healthRegen": life.get("regenRate", 0),
        "healthRegenScale": life.get("regenScale", 0),
        "attackRange": primary.get("range"),
        "attackSpeed": primary.get("period"),
        "attackDamage": primary.get("damage"),
        "attackDamageScale": primary.get("damageScale"),
        "weapons": weapons,
        "abilities": build_abilities(hero, override.get("abilities", {})),
        "talents": talents_out,
        "heroUnits": hero.get("heroUnits", []),
    }

    for key, value in override.items():
        if key not in ("abilities", "talents"):
            record[key] = value

    return record


def sync_hero_images(
    hero: dict,
    slug: str,
    talents_by_tier: dict[int, list[dict]],
    hdp_output: str,
    img_dir: str,
    dry_run: bool,
) -> tuple[int, int, int, int]:
    """Sync portrait + talent + ability images for one hero.

    Returns (portraits_synced, talents_synced, abilities_synced, missing_sources).
    """
    portraits_dir = os.path.join(hdp_output, "images", "heroportraits")
    talents_dir = os.path.join(hdp_output, "images", "talents")
    abilities_dir = os.path.join(hdp_output, "images", "abilities")
    hero_dir = os.path.join(img_dir, slug)

    portraits_synced = 0
    talents_synced = 0
    abilities_synced = 0
    missing = 0

    # Target portrait: rectangular framed headshot used in-game when a unit is selected.
    # Chosen over heroSelect (circular hero-pick button) for the dashboard avatar.
    portrait_file = (hero.get("portraits") or {}).get("target")
    if portrait_file:
        src = os.path.join(portraits_dir, portrait_file)
        dst = os.path.join(hero_dir, "avatar.png")
        if os.path.exists(src):
            if process_image_if_changed(src, dst, dry_run):
                portraits_synced += 1
        else:
            missing += 1

    # Talent icons.
    for tier, talents in talents_by_tier.items():
        for i, talent in enumerate(talents, 1):
            icon = talent.get("icon")
            if not icon:
                continue
            src = os.path.join(talents_dir, icon)
            dst = os.path.join(hero_dir, f"talent{tier}_{i}.png")
            if os.path.exists(src):
                if process_image_if_changed(src, dst, dry_run):
                    talents_synced += 1
            else:
                missing += 1

    # Ability icons.
    src_abilities = hero.get("abilities") or {}
    for category in ABILITY_CATEGORIES:
        for ability in src_abilities.get(category, []):
            icon = ability.get("icon")
            name_id = ability.get("nameId")
            if not icon or not name_id:
                continue
            src = os.path.join(abilities_dir, icon)
            dst = os.path.join(hero_dir, "abilities", slugify(name_id) + ".png")
            if os.path.exists(src):
                if process_image_if_changed(src, dst, dry_run):
                    abilities_synced += 1
            else:
                missing += 1

    return portraits_synced, talents_synced, abilities_synced, missing


def load_existing_json(path: str) -> dict:
    """Load a data file already on disk. A missing file means a first run."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def merge_channel_data(
    channel: str, parsed: HeroDataSet, existing: HeroDataSet,
) -> tuple[HeroDataSet, set[str]]:
    """Combine a channel's extract with the data already on disk.

    Returns the dataset to write and the slugs whose icons need syncing.
    """
    ptr_slugs = {slug for slug, record in existing.info.items() if record.get(PTR_FLAG)}

    if channel == CHANNEL_PTR:
        merged = HeroDataSet(
            dict(existing.info), dict(existing.names), dict(existing.descriptions),
        )
        written = {
            slug for slug in parsed.info
            if slug not in existing.info or slug in ptr_slugs
        }
        for slug in written:
            record = dict(parsed.info[slug])
            record[PTR_FLAG] = True
            merged.info[slug] = record
            merged.names[slug] = parsed.names[slug]
            merged.descriptions[slug] = parsed.descriptions[slug]
        return merged, written

    merged = HeroDataSet(dict(parsed.info), dict(parsed.names), dict(parsed.descriptions))
    written = set(parsed.info)

    # Heroes the live build does not have yet stay as the PTR run left them.
    for slug in ptr_slugs - written:
        merged.info[slug] = existing.info[slug]
        if slug in existing.names:
            merged.names[slug] = existing.names[slug]
        if slug in existing.descriptions:
            merged.descriptions[slug] = existing.descriptions[slug]

    return merged, written


def report_missing_static_entries(heroes: dict[str, dict], data_dir: str) -> None:
    """Print the static lookup entries a hero still needs, ready to paste in."""
    colors = load_existing_json(os.path.join(data_dir, HERO_COLORS_FILENAME))
    missing: list[tuple[str, str, list[str]]] = []

    for slug in sorted(heroes):
        hero = heroes[slug]
        name = hero.get("name", "")
        unit_id = hero.get("unitId", "")
        internal = unit_id[len("Hero"):] if unit_id.startswith("Hero") else unit_id
        role = hero.get("expandedRole", "")
        entries = []

        if internal and internal not in HERO_NAMES:
            entries.append(f'pipeline/herodata.py HERO_NAMES: "{internal}": "{name}",')
        if name not in HERO_ROLES:
            entries.append(f'pipeline/herodata.py HERO_ROLES: "{name}": "{role}",')
        if hero.get("gender") == "Female" and name not in FEMALE_HEROES:
            entries.append(f'pipeline/herodata.py FEMALE_HEROES: "{name}",')
        if name not in colors:
            entries.append(f'data/{HERO_COLORS_FILENAME}: "{name}": "#RRGGBB",')

        if entries:
            missing.append((name, slug, entries))

    if not missing:
        return

    print(f"\n{len(missing)} hero(es) missing from the static lookup tables:")
    for name, slug, entries in missing:
        print(f"  {name} ({slug})")
        for entry in entries:
            print(f"    {entry}")
    print(
        "  Replays featuring them parse with the internal hero id and role Unknown\n"
        "  until these are added. Alternate unit forms need their own HERO_NAMES keys."
    )


def write_json(path: str, data: dict, dry_run: bool) -> None:
    """Compact JSON write matching the existing format (no indent, ensure_ascii=False)."""
    if dry_run:
        print(f"  Would write: {path}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"  Written: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)

    channel_group = parser.add_mutually_exclusive_group()
    channel_group.add_argument("-release", dest="channel", action="store_const",
                               const=CHANNEL_RELEASE,
                               help="Read the live install (default)")
    channel_group.add_argument("-ptr", dest="channel", action="store_const",
                               const=CHANNEL_PTR,
                               help="Read the Public Test install, adding heroes the "
                                    "live build does not have yet")
    parser.set_defaults(channel=CHANNEL_RELEASE)

    parser.add_argument("--game-path", default=None,
                        help=f"Path to HotS install (default: {DEFAULT_GAME_PATHS[CHANNEL_RELEASE]}, "
                             f"or {DEFAULT_GAME_PATHS[CHANNEL_PTR]} with -ptr)")
    parser.add_argument("--hdp-output", default=None,
                        help=f"HDP raw output dir (default: {DEFAULT_HDP_OUTPUTS[CHANNEL_RELEASE]}, "
                             f"or {DEFAULT_HDP_OUTPUTS[CHANNEL_PTR]} with -ptr)")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR,
                        help=f"Final JSON output dir (default: {DEFAULT_DATA_DIR})")
    parser.add_argument("--img-dir", default=DEFAULT_IMG_DIR,
                        help=f"Per-hero image dir (default: {DEFAULT_IMG_DIR})")
    parser.add_argument("--skip-parser", action="store_true",
                        help="Skip HDP invocation; use existing --hdp-output content")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report actions without writing")
    args = parser.parse_args()

    if args.game_path is None:
        args.game_path = DEFAULT_GAME_PATHS[args.channel]
    if args.hdp_output is None:
        args.hdp_output = DEFAULT_HDP_OUTPUTS[args.channel]

    print(f"Channel: {args.channel}")

    ensure_pillow()

    if not args.skip_parser:
        run_hdp(args.game_path, args.hdp_output)

    hero_files = discover_hero_files(args.hdp_output)
    if not hero_files:
        print(f"ERROR: no hero JSON files found under {args.hdp_output}", file=sys.stderr)
        return 1
    print(f"Found {len(hero_files)} hero JSON file(s) in {args.hdp_output}")

    overrides = load_existing_json(os.path.join(args.data_dir, HERO_OVERRIDES_FILENAME))

    heroes: dict[str, dict] = {}
    talents_by_slug: dict[str, dict[int, list[dict]]] = {}
    parsed = HeroDataSet({}, {}, {})

    for path in hero_files:
        loaded = load_hero(path)
        if loaded is None:
            print(f"  Skipped (no name field): {os.path.basename(path)}")
            continue
        slug, hero = loaded

        talents_by_tier = collect_talents_by_tier(hero)
        heroes[slug] = hero
        talents_by_slug[slug] = talents_by_tier

        record = build_hero_info(hero, talents_by_tier, overrides.get(slug, {}))
        parsed.info[slug] = record
        parsed.names[slug] = build_talent_names(record["talents"])
        parsed.descriptions[slug] = build_talent_descriptions(record["talents"])

    applied = sorted(slug for slug in overrides if slug in parsed.info)
    if applied:
        print(f"Overrides applied from {HERO_OVERRIDES_FILENAME}: {', '.join(applied)}")

    info_path = os.path.join(args.data_dir, HERO_INFO_FILENAME)
    names_path = os.path.join(args.data_dir, TALENT_NAMES_FILENAME)
    descriptions_path = os.path.join(args.data_dir, TALENT_DESCRIPTIONS_FILENAME)

    existing = HeroDataSet(
        load_existing_json(info_path),
        load_existing_json(names_path),
        load_existing_json(descriptions_path),
    )
    merged, written = merge_channel_data(args.channel, parsed, existing)

    total_portraits = total_talents = total_abilities = total_missing = 0

    for slug in sorted(written):
        p, t, a, m = sync_hero_images(
            heroes[slug], slug, talents_by_slug[slug],
            args.hdp_output, args.img_dir, args.dry_run,
        )
        total_portraits += p
        total_talents += t
        total_abilities += a
        total_missing += m

    write_json(info_path, merged.info, args.dry_run)
    write_json(names_path, merged.names, args.dry_run)
    write_json(descriptions_path, merged.descriptions, args.dry_run)

    verb = "Would sync" if args.dry_run else "Synced"
    print(
        f"\nImages: {verb} {total_portraits} portrait(s), {total_talents} talent icon(s), "
        f"{total_abilities} ability icon(s). {total_missing} source image(s) missing."
    )
    print(f"Heroes parsed: {len(parsed.info)}, written: {len(written)}, in dataset: {len(merged.info)}")

    ptr_slugs = sorted(slug for slug, record in merged.info.items() if record.get(PTR_FLAG))
    if ptr_slugs:
        print(f"PTR-only heroes: {', '.join(ptr_slugs)}")

    report_missing_static_entries(heroes, args.data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
