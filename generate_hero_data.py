"""
Regenerate all hero data using HeroesDataParser, which downloads the game build
straight from Blizzard's CDN. No HotS install is required.

Outputs:
  - data/hero-info.json           (full per-hero reference: stats, abilities, talents)
  - data/talent-names.json        (talent name lookup by hero slug and tier_choice key)
  - data/talent-descriptions.json (talent description lookup, same structure)
  - img/hero/{slug}/avatar.png    (hero select portrait icon, 64x64)
  - img/hero/{slug}/talent{tier}_{choice}.png (talent icons, 64x64)
  - img/hero/{slug}/abilities/{id-slug}.png (ability icons, 64x64)

Source: HeroesDataParser (https://github.com/HeroesToolChest/HeroesDataParser)
extracts JSON + images from Blizzard's game files. HDP emits images at 128x128;
this script downscales them to 64x64 and re-encodes the PNGs with optimisation
enabled to roughly halve dashboard payload size.

Channels:
  -release (default) reads the live build, -ptr the Public Test build, each into
  its own HDP output directory. A PTR run only writes heroes missing from
  data/hero-info.json plus ones it previously tagged "ptr": true; a release run
  owns every hero the live build has and drops the tag when one ships.

Prerequisites: none beyond Python. The self-contained HeroesDataParser build is
downloaded and checksum-verified on first run after a y/N prompt, as is Pillow.

Usage:
  python generate_hero_data.py                 # full pipeline: HDP + translate + sync
  python generate_hero_data.py -ptr            # same, against the PTR build
  python generate_hero_data.py --skip-parser   # skip HDP, translate existing output
  python generate_hero_data.py --dry-run       # report actions, no writes
"""

import argparse
import glob
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from typing import NamedTuple

from pipeline.herodata import FEMALE_HEROES, HERO_NAMES, HERO_ROLES

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

SCRATCH_DIR = os.path.join(_PROJECT_ROOT, ".scratch")
DEFAULT_DATA_DIR = os.path.join(_PROJECT_ROOT, "data")
DEFAULT_IMG_DIR = os.path.join(_PROJECT_ROOT, "img", "hero")

CHANNEL_RELEASE = "release"
CHANNEL_PTR = "ptr"

# Separate roots: a shared one would let the PTR build win the newest-build
# selection in discover_hero_data_file and replace the live dataset.
DEFAULT_HDP_OUTPUTS = {
    CHANNEL_RELEASE: os.path.join(SCRATCH_DIR, "hots-data-output"),
    CHANNEL_PTR: os.path.join(SCRATCH_DIR, "hots-data-output-ptr"),
}

HERO_INFO_FILENAME = "hero-info.json"
TALENT_NAMES_FILENAME = "talent-names.json"
TALENT_DESCRIPTIONS_FILENAME = "talent-descriptions.json"
HERO_COLORS_FILENAME = "hero-colors.json"

# Hand-written data for heroes the game files describe incompletely, keyed by slug
# then by ability or talent id. Delete an entry once the build carries the real data.
HERO_OVERRIDES_FILENAME = "hero-overrides.json"

# Marks a hero-info.json record as PTR-sourced; the talent files derive theirs from it.
PTR_FLAG = "ptr"

HDP_VERSION = "5.0.4"
HDP_DIR = os.path.join(SCRATCH_DIR, "hdp")
HDP_RELEASE_URL = "https://github.com/HeroesToolChest/HeroesDataParser/releases/download/v{version}/{asset}"

# Self-contained builds, so no .NET runtime has to be installed. Each archive
# unpacks into a directory named after its runtime id. The SHA-256 is checked
# before unpacking, so a tampered or truncated download never runs.
HDP_ASSETS = {
    "linux-x64": (
        f"HeroesDataParser.{HDP_VERSION}-scd-linux-x64.tar.gz",
        "8ee8afaa4df6add6c3710e0527435558bcc94a6a14d60f783a0deb3948404850",
    ),
    "win-x64": (
        f"HeroesDataParser.{HDP_VERSION}-scd-win-x64.zip",
        "beb28570de818e63d1eee4ca990b402aa208ae5932f3b6a5fe4cb44a1ad6e014",
    ),
}

HDP_THREADS = 4

# Ability categories kept in hero-info.json, HDP's name mapped to the frontend's.
# Mount/Activable/Hearth are generic and rarely consulted, so they are excluded
# to keep the JSON small.
ABILITY_CATEGORIES = (("Basic", "basic"), ("Heroic", "heroic"), ("Trait", "trait"))

# A passive ability has no activatable ability behind it, so HDP gives it this id
# in place of one. The button it was built from carries a usable id.
PASSIVE_ABILITY_ID = ":PASSIVE:"

# The game's shared "stop channelling" button art. Every ability that can be
# interrupted has one, and it repeats the parent ability's tooltip.
CANCEL_ICON = "hud_btn_bg_ability_cancel.png"

# HDP groups talents under LevelN keys. Tiers map level# -> tier index used in our keys.
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


class AbilityEntry(NamedTuple):
    """One ability card: its output category, unique id, HDP record, and owner.

    parent is the ability, form or stance the game nests this one under, empty
    for an ability the hero has outright.
    """

    category: str
    entry_id: str
    source: dict
    parent: str


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


def prompt_yes_no(message: str) -> bool:
    """Read a y/N answer from stdin. Default no; only 'y'/'Y' counts as yes."""
    try:
        answer = input(f"{message} [y/N]: ").strip().lower()
    except EOFError:
        return False
    return answer == "y"


def hdp_runtime_id() -> str:
    """Return the .NET runtime id matching this machine, e.g. linux-x64."""
    systems = {"linux": "linux", "windows": "win", "darwin": "osx"}
    machines = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}

    system = systems.get(platform.system().lower())
    machine = machines.get(platform.machine().lower())
    if not system or not machine:
        raise SystemExit(
            f"ERROR: unsupported platform {platform.system()} {platform.machine()} "
            "for HeroesDataParser."
        )
    return f"{system}-{machine}"


def hdp_executable_path(runtime_id: str) -> str:
    name = "HeroesDataParser.exe" if runtime_id.startswith("win") else "HeroesDataParser"
    return os.path.join(HDP_DIR, runtime_id, name)


def download_verified(url: str, sha256: str, dst: str) -> None:
    """Download url to dst, aborting unless the payload matches sha256."""
    print(f"Downloading {url} ...")
    with urllib.request.urlopen(url) as response, open(dst, "wb") as f:
        shutil.copyfileobj(response, f)

    digest = hashlib.sha256()
    with open(dst, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)

    if digest.hexdigest() != sha256:
        raise SystemExit(
            f"ERROR: checksum mismatch for {os.path.basename(url)}.\n"
            f"  expected {sha256}\n"
            f"  got      {digest.hexdigest()}"
        )


def ensure_hdp() -> str:
    """Return the path to the HDP executable, downloading it if needed."""
    runtime_id = hdp_runtime_id()
    executable = hdp_executable_path(runtime_id)
    if os.path.exists(executable):
        return executable

    if runtime_id not in HDP_ASSETS:
        raise SystemExit(
            f"ERROR: no pinned HeroesDataParser {HDP_VERSION} archive for {runtime_id}.\n"
            f"Add its filename and SHA-256 to HDP_ASSETS from\n"
            f"  https://github.com/HeroesToolChest/HeroesDataParser/releases/tag/v{HDP_VERSION}"
        )

    asset, sha256 = HDP_ASSETS[runtime_id]
    url = HDP_RELEASE_URL.format(version=HDP_VERSION, asset=asset)
    print(f"HeroesDataParser {HDP_VERSION} ({runtime_id}) is not present in {HDP_DIR}.")
    print("It is a self-contained build, so no .NET runtime is needed.")
    if not prompt_yes_no("Download it now?"):
        raise SystemExit(f"Aborted. To install manually, unpack {url} into {HDP_DIR}.")

    os.makedirs(HDP_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = os.path.join(tmp, asset)
        download_verified(url, sha256, archive)

        # Both archive kinds already carry a top-level directory named after the
        # runtime id, so they unpack straight into HDP_DIR.
        print(f"Unpacking into {HDP_DIR} ...")
        if asset.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(HDP_DIR)
        else:
            with tarfile.open(archive) as tf:
                tf.extractall(HDP_DIR, filter="data")

    if not os.path.exists(executable):
        raise SystemExit(f"ERROR: {asset} did not contain {executable}")
    os.chmod(executable, 0o755)

    print(f"HeroesDataParser {HDP_VERSION} ready.")
    return executable


def run_hdp(channel: str, output_dir: str) -> None:
    """Invoke HeroesDataParser against Blizzard's CDN. Raises CalledProcessError on failure."""
    executable = ensure_hdp()

    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(SCRATCH_DIR, exist_ok=True)

    cmd = [executable, "online"]
    if channel == CHANNEL_PTR:
        cmd.append("--download-ptr")
    cmd += ["-e", "hero:i", "-o", output_dir, "-t", str(HDP_THREADS)]

    print(f"Running: {' '.join(cmd)}")
    print("Downloading and parsing the build takes several minutes.")
    # HDP writes its CASC scratch files relative to the process CWD, so run it
    # from .scratch/ to keep them out of the project root.
    subprocess.run(cmd, check=True, cwd=SCRATCH_DIR)


def data_build_number(data_file: str) -> int:
    """Return the build number embedded in a herodata_{build}_{loc}.json filename."""
    match = re.match(r"herodata_(\d+)_", os.path.basename(data_file))
    return int(match.group(1)) if match else -1


def discover_hero_data_file(hdp_output: str) -> str | None:
    """Return the newest <output>/data/herodata_{build}_{loc}.json, or None."""
    candidates = glob.glob(os.path.join(hdp_output, "data", "herodata_*.json"))
    if not candidates:
        return None
    newest = max(candidates, key=data_build_number)
    print(f"Using build {data_build_number(newest)} ({os.path.basename(newest)})")
    return newest


def load_heroes(path: str) -> list[tuple[str, dict]]:
    """Load HDP's hero data file. Returns (slug, hero_dict) pairs sorted by slug."""
    with open(path, encoding="utf-8") as f:
        items = json.load(f).get("items", {})
    heroes = [
        (slugify(hero["name"]), hero)
        for hero in items.values()
        if isinstance(hero, dict) and hero.get("name")
    ]
    return sorted(heroes, key=lambda pair: pair[0])


def ability_id(entry: dict) -> str:
    """Return the id HDP gives an ability, or its button's when it has none."""
    value = entry.get("abilityId", "")
    return entry.get("buttonId", "") if value == PASSIVE_ABILITY_ID else value


def is_cancel_button(ability: dict) -> bool:
    return (
        ability.get("icon") == CANCEL_ICON
        or "cancel" in (ability.get("name") or "").lower()
    )


def sub_ability_groups(hero: dict) -> list[tuple[str, dict]]:
    """Return (parent link id, {category: [abilities]}) for the hero's own abilities.

    A link id carries a trailing LevelN segment when a talent is what grants the
    ability. Those already have a talent card, so they are left out.
    """
    return [
        (link, groups)
        for link, groups in (hero.get("subAbilities") or {}).items()
        if link.count("|") == 2
    ]


def index_abilities_by_id(hero: dict) -> dict[str, dict]:
    """Map the hero's abilities by both of their ids, nested ones included.

    Nested abilities are in here because one can be another's parent: Deathwing's
    Onslaught hangs off World Breaker, which itself hangs off Dragonflight.
    """
    index: dict[str, dict] = {}
    groups = list((hero.get("abilities") or {}).values())
    for _, nested in (hero.get("subAbilities") or {}).items():
        groups.extend(nested.values())

    for abilities in groups:
        for ability in abilities:
            for key in (ability.get("abilityId"), ability.get("buttonId")):
                if key and key != PASSIVE_ABILITY_ID:
                    index.setdefault(key, ability)
    return index


def talent_granted(hero: dict) -> tuple[set[str], set[str]]:
    """Return the ability ids and names the hero only has when a talent is picked."""
    ids, names = set(), set()
    for talents in (hero.get("talents") or {}).values():
        for talent in talents:
            ability = talent.get("abilityId", "")
            if ability and ability != PASSIVE_ABILITY_ID:
                ids.add(ability)
            names.add(talent.get("name", ""))
    return ids, names


def hero_unit_label(hero: dict, unit_id: str, unit: dict) -> str:
    """Name the form a unit represents, for labelling the abilities it owns.

    Units that transform the hero rather than accompany them are named after the
    hero (Alexstrasza's dragon, D.Va's pilot), so their id supplies the form:
    HeroDVaPilot -> Pilot, RagnarosBigRag -> Big Rag.
    """
    name = unit.get("name", "")
    if name != hero.get("name"):
        return name

    hero_id = re.sub(r"^Hero", "", hero.get("unitId", ""))
    form = re.sub(r"^Hero", "", unit_id)
    shared = os.path.commonprefix([hero_id, form])
    form = form[len(shared):] or form
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", form) or name


def collect_abilities(hero: dict) -> list[AbilityEntry]:
    """Return the hero's ability cards, including the ones HDP nests.

    An ability that only exists in another form, stance or unit (Deathwing's
    World Breaker set, Greymane's Worgen attacks, D.Va's pilot kit) is nested
    under its owner rather than listed with the rest. Each is its own card here,
    minus cancel buttons, the primed/active states that only repeat their parent,
    and the talent-granted abilities that already have a talent card.
    """
    source = hero.get("abilities") or {}
    by_id = index_abilities_by_id(hero)
    entries: list[AbilityEntry] = []
    used_ids: set[str] = set()
    used_names: set[str] = set()

    def add(category: str, ability: dict, parent: str) -> None:
        entry_id = ability_id(ability)
        # Samuro's Image Transmission shares its abilityId with the heroic that
        # grants it, and an id decides the icon filename, so fall back to the
        # button that actually carries this ability's name and art.
        if entry_id in used_ids:
            entry_id = ability.get("buttonId", "")
        if not entry_id or entry_id in used_ids:
            return
        used_ids.add(entry_id)
        used_names.add(ability.get("name", ""))
        entries.append(AbilityEntry(category, entry_id, ability, parent))

    for source_category, category in ABILITY_CATEGORIES:
        for ability in source.get(source_category, []):
            add(category, ability, "")

    for link, groups in sub_ability_groups(hero):
        parent = by_id.get(link.split("|")[0]) or by_id.get(link.split("|")[1]) or {}
        for source_category, category in ABILITY_CATEGORIES:
            for ability in groups.get(source_category, []):
                if is_cancel_button(ability):
                    continue
                if ability.get("name") in used_names:
                    continue
                if ability.get("fullText") == parent.get("fullText"):
                    continue
                add(category, ability, parent.get("name", ""))

    talent_ids, talent_names = talent_granted(hero)
    for unit_id, unit in (hero.get("heroUnits") or {}).items():
        label = hero_unit_label(hero, unit_id, unit)
        for source_category, category in ABILITY_CATEGORIES:
            for ability in (unit.get("abilities") or {}).get(source_category, []):
                if is_cancel_button(ability):
                    continue
                if ability.get("name") in used_names:
                    continue
                if ability.get("abilityId") in talent_ids or ability.get("name") in talent_names:
                    continue
                add(category, ability, label)

    return entries


def collect_talents_by_tier(hero: dict) -> dict[int, list[dict]]:
    """Return {tier: [talents sorted by HDP sort field]}."""
    talents = hero.get("talents", {})
    result: dict[int, list[dict]] = {}
    for tier in TALENT_LEVELS:
        tier_talents = talents.get(f"Level{tier}", [])
        result[tier] = sorted(tier_talents, key=lambda t: t.get("sort", 0))
    return result


def build_talent_names(talents_out: dict[str, dict]) -> dict[str, str]:
    return {key: talent["name"] for key, talent in talents_out.items()}


def build_talent_descriptions(talents_out: dict[str, dict]) -> dict[str, str]:
    return {key: talent["description"] for key, talent in talents_out.items()}


def build_abilities(abilities: list[AbilityEntry], overrides: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {category: [] for _, category in ABILITY_CATEGORIES}
    for entry in abilities:
        ability = entry.source
        override = overrides.get(entry.entry_id, {})
        out[entry.category].append({
            "id": entry.entry_id,
            "name": override.get("name") or ability.get("name", ""),
            "icon": slugify(entry.entry_id) + ".png" if ability.get("icon") else "",
            "parent": entry.parent,
            "abilityType": ability.get("abilityType", ""),
            "cooldown": ability.get("cooldownText", ""),
            "manaCost": ability.get("energyText", ""),
            "description": override.get("description") or strip_html(ability.get("fullText", "")),
        })
    return out


def enabled_weapons(unit: dict) -> list[dict]:
    """Return a unit's active weapons in source order.

    HDP also lists the alternative weapons talents can swap in, ahead of the real
    one, so an unfiltered weapons[0] reports a weapon the hero does not have
    (Stukov's Spine Launcher, Nova's Anti-Armor Shells).
    """
    weapons = []
    for weapon in unit.get("weapons") or []:
        if weapon.get("isDisabled"):
            continue
        weapon = dict(weapon)
        weapon.pop("isDisabled", None)
        weapons.append(weapon)
    return weapons


def build_hero_units(hero: dict) -> list[dict]:
    """Return alternate hero forms as one single-key object each, keyed by unit id."""
    units = hero.get("heroUnits") or {}
    out = []
    for unit_id, unit in units.items():
        unit = dict(unit)
        if "weapons" in unit:
            unit["weapons"] = enabled_weapons(unit)
        out.append({unit_id: unit})
    return out


def build_hero_info(
    hero: dict,
    talents_by_tier: dict[int, list[dict]],
    abilities: list[AbilityEntry],
    override: dict,
) -> dict:
    weapons = enabled_weapons(hero)
    primary = weapons[0] if weapons else {}
    life = hero.get("life") or {}
    talent_overrides = override.get("talents", {})

    # Unnamed talents would render as blank cards. Numbering stays tier-ordered
    # regardless, because replay talent choices index into it.
    talents_out: dict[str, dict] = {}
    for tier, talents in talents_by_tier.items():
        for i, talent in enumerate(talents, 1):
            talent = talent | talent_overrides.get(talent.get("talentId", ""), {})
            if not talent.get("name"):
                continue
            key = f"{tier}_{i}"
            talents_out[key] = {
                "name": talent.get("name", ""),
                "icon": f"talent{key}.png" if talent.get("icon") else "",
                "description": talent.get("description") or strip_html(talent.get("fullText", "")),
                "abilityType": talent.get("abilityType", ""),
                "isQuest": talent.get("isQuest", False),
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
        "abilities": build_abilities(abilities, override.get("abilities", {})),
        "talents": talents_out,
        "heroUnits": build_hero_units(hero),
    }

    for key, value in override.items():
        if key not in ("abilities", "talents"):
            record[key] = value

    return record


def sync_hero_images(
    hero: dict,
    slug: str,
    talents_by_tier: dict[int, list[dict]],
    abilities: list[AbilityEntry],
    hdp_output: str,
    img_dir: str,
    dry_run: bool,
) -> tuple[int, int, int, int]:
    """Sync portrait + talent + ability images for one hero.

    Returns (portraits_synced, talents_synced, abilities_synced, missing_sources).
    """
    portraits_dir = os.path.join(hdp_output, "images", "heroportraits")
    # HDP emits ability and talent icons into one directory; talents reuse their
    # ability's icon file.
    icons_dir = os.path.join(hdp_output, "images", "abilitytalents")
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
            src = os.path.join(icons_dir, icon)
            dst = os.path.join(hero_dir, f"talent{tier}_{i}.png")
            if os.path.exists(src):
                if process_image_if_changed(src, dst, dry_run):
                    talents_synced += 1
            else:
                missing += 1

    # Ability icons.
    for entry in abilities:
        icon = entry.source.get("icon")
        if not icon:
            continue
        src = os.path.join(icons_dir, icon)
        dst = os.path.join(hero_dir, "abilities", slugify(entry.entry_id) + ".png")
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
                               help="Read the live build (default)")
    channel_group.add_argument("-ptr", dest="channel", action="store_const",
                               const=CHANNEL_PTR,
                               help="Read the Public Test build, adding heroes the "
                                    "live build does not have yet")
    parser.set_defaults(channel=CHANNEL_RELEASE)

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

    if args.hdp_output is None:
        args.hdp_output = DEFAULT_HDP_OUTPUTS[args.channel]

    print(f"Channel: {args.channel}")

    ensure_pillow()

    if not args.skip_parser:
        run_hdp(args.channel, args.hdp_output)

    data_file = discover_hero_data_file(args.hdp_output)
    if data_file is None:
        print(f"ERROR: no hero data file found under {args.hdp_output}", file=sys.stderr)
        return 1

    overrides = load_existing_json(os.path.join(args.data_dir, HERO_OVERRIDES_FILENAME))

    heroes: dict[str, dict] = {}
    talents_by_slug: dict[str, dict[int, list[dict]]] = {}
    abilities_by_slug: dict[str, list[AbilityEntry]] = {}
    parsed = HeroDataSet({}, {}, {})

    loaded_heroes = load_heroes(data_file)
    print(f"Found {len(loaded_heroes)} hero record(s) in {os.path.basename(data_file)}")

    for slug, hero in loaded_heroes:
        talents_by_tier = collect_talents_by_tier(hero)
        abilities = collect_abilities(hero)
        heroes[slug] = hero
        talents_by_slug[slug] = talents_by_tier
        abilities_by_slug[slug] = abilities

        record = build_hero_info(hero, talents_by_tier, abilities, overrides.get(slug, {}))
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
            heroes[slug], slug, talents_by_slug[slug], abilities_by_slug[slug],
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
