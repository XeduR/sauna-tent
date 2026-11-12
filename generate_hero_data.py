"""
Regenerate all hero data using HeroesDataParser, which downloads the game build
straight from Blizzard's CDN. No HotS install is required.

Outputs:
  - data/hero-info.json           (full per-hero reference: stats, abilities, talents)
  - data/talent-names.json        (talent name lookup by hero slug and tier_choice key)
  - data/talent-descriptions.json (talent description lookup, same structure)
  - data/gamedata/versions.json   (every ingested game version, ordered by build)
  - data/gamedata/{live|ptr}/heroes/{slug}.json (structured hero record, fixed key order)
  - data/gamedata/{live|ptr}/common-abilities.json (Mount and Hearthstone most heroes share)
  - data/gamedata/{live|ptr}/units/{UnitId}.json (non-hero unit with gameplay content)
  - data/gamedata/{live|ptr}/maps/{map id}/map.json (map name, size and objectives)
  - data/gamedata/{live|ptr}/maps/{map id}/{units|heroes}/*.json and common-abilities.json
    (full records that the map's own data changes from the files above)
  - data/gamedata/snapshots/{version id}/{heroes|units|maps}.json (minified snapshot per dataset)
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
from collections import Counter
from typing import NamedTuple

from pipeline.gamedata import (
    CHANNEL_LIVE, CHANNEL_PTR as GAMEDATA_CHANNEL_PTR, PASSIVE_ABILITY_ID,
    Dataset, MapData, ability_id, apply_json_patch, build_hero_dataset, build_hero_record,
    build_map_record, build_maps_dataset, build_unit_record, build_unit_records,
    build_units_dataset, changed_records, check_unit_id_case, hero_unit_label,
    index_abilities_by_id, is_cancel_button, parse_version, report_unrecognised,
    split_common_abilities, strip_html, write_gamedata, write_text_if_changed,
)
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

GAMEDATA_CHANNELS = {CHANNEL_RELEASE: CHANNEL_LIVE, CHANNEL_PTR: GAMEDATA_CHANNEL_PTR}

# Ability categories kept in hero-info.json, HDP's name mapped to the frontend's.
# Mount/Activable/Hearth are generic and rarely consulted, so they are excluded
# to keep the JSON small.
ABILITY_CATEGORIES = (("Basic", "basic"), ("Heroic", "heroic"), ("Trait", "trait"))

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


def same_pixels(png_bytes: bytes, path: str) -> bool:
    """True when path decodes to the same mode, size and pixels as png_bytes."""
    from PIL import Image
    if not os.path.exists(path):
        return False
    try:
        with Image.open(io.BytesIO(png_bytes)) as new, Image.open(path) as old:
            return (new.mode, new.size, new.tobytes()) == (old.mode, old.size, old.tobytes())
    except (OSError, ValueError):
        return False


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
    """Resize+re-encode src and write to dst unless dst already holds the same pixels.

    Bytes are not compared: zlib builds encode identical pixels differently.
    """
    if not os.path.exists(src):
        return False
    new_bytes = encode_resized_png(src)
    if same_pixels(new_bytes, dst):
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
    cmd += ["-e", "hero:i", "-e", "unit", "-e", "map", "-o", output_dir, "-t", str(HDP_THREADS)]

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


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def hero_entries(data: dict) -> list[tuple[str, str, dict]]:
    """(slug, item id, hero) for every hero in an HDP hero data document, sorted by slug."""
    heroes = [
        (slugify(hero["name"]), item_id, hero)
        for item_id, hero in data.get("items", {}).items()
        if isinstance(hero, dict) and hero.get("name")
    ]
    return sorted(heroes, key=lambda entry: entry[0])


def build_structured_heroes(
    entries: list[tuple[str, str, dict]], overrides: dict, unrecognised: Counter,
) -> dict[str, dict]:
    """Structured hero records by slug, before the common abilities are split out."""
    return {
        slug: build_hero_record(
            item_id, hero, collect_talents_by_tier(hero), overrides.get(slug, {}), unrecognised,
        )
        for slug, item_id, hero in entries
    }


def companion_data_file(hero_data_file: str, kind: str) -> str:
    """Path of HDP's <kind>data file for the same build and locale as the hero data file."""
    folder, name = os.path.split(hero_data_file)
    return os.path.join(folder, name.replace("herodata_", f"{kind}data_", 1))


def load_map_patch(hero_data_file: str, map_id: str, kind: str) -> list[dict]:
    """A map's JSON patch against the base <kind>data file, or [] when the map has none."""
    folder, name = os.path.split(companion_data_file(hero_data_file, kind))
    path = os.path.join(folder, "maps", map_id, name.replace(".json", ".patch.json"))
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_map_data(
    raw_map: dict,
    hero_data_file: str,
    base_docs: tuple[dict, dict],
    base_datasets: tuple[Dataset, Dataset],
    overrides: dict,
    unrecognised: Counter,
) -> MapData:
    """Apply a map's patches to the base documents and keep the records that change."""
    map_id = raw_map["normalizedId"]
    hero_doc, unit_doc = base_docs
    heroes_dataset, units_dataset = base_datasets
    record = build_map_record(raw_map, unrecognised)

    unit_patch = load_map_patch(hero_data_file, map_id, "unit")
    patched_units = apply_json_patch(unit_doc, unit_patch).get("items", {}) if unit_patch else {}
    check_unit_id_case(list(patched_units), f"map {map_id}")
    base_units = unit_doc.get("items", {})
    base_unit_records = units_dataset.snapshot["units"]

    # The builders are deterministic, so only items the patch touched can change.
    touched = {
        unit_id: unit for unit_id, unit in patched_units.items()
        if unit is not base_units.get(unit_id)
    }
    unit_records, _ = build_unit_records(touched, unrecognised)
    unit_records.update(
        (unit_id, build_unit_record(unit_id, touched[unit_id], include_abilities=True))
        for unit_id in touched
        if unit_id not in unit_records and unit_id in base_unit_records
    )
    units = changed_records(unit_records, base_unit_records)

    heroes: dict[str, dict] = {}
    common: list[dict] | None = None
    hero_patch = load_map_patch(hero_data_file, map_id, "hero")
    if hero_patch:
        patched_heroes = hero_entries(apply_json_patch(hero_doc, hero_patch))
        map_heroes = build_structured_heroes(patched_heroes, overrides, unrecognised)
        map_common = split_common_abilities(map_heroes)
        heroes = changed_records(map_heroes, heroes_dataset.snapshot["heroes"])
        if map_common != heroes_dataset.snapshot["commonAbilities"]:
            common = map_common

    return MapData(map_id, record, units, heroes, common)


def build_world_datasets(
    hero_data_file: str,
    hero_doc: dict,
    heroes_dataset: Dataset,
    overrides: dict,
    unrecognised: Counter,
) -> list[Dataset]:
    """The units and maps datasets for the hero data file's build. Raises ValueError on bad input."""
    unit_doc = load_json(companion_data_file(hero_data_file, "unit"))
    map_doc = load_json(companion_data_file(hero_data_file, "map"))

    unit_items = unit_doc.get("items", {})
    check_unit_id_case(list(unit_items), os.path.basename(companion_data_file(hero_data_file, "unit")))
    unit_records, skipped = build_unit_records(unit_items, unrecognised)
    units_dataset = build_units_dataset(unit_records)
    print(f"Units: {len(unit_records)} written, {skipped} skipped without gameplay content")

    maps = [
        build_map_data(
            raw_map, hero_data_file, (hero_doc, unit_doc), (heroes_dataset, units_dataset),
            overrides, unrecognised,
        )
        for raw_map in map_doc.get("items", {}).values()
    ]
    print(
        f"Maps: {len(maps)}, {sum(len(entry.units) for entry in maps)} map unit record(s), "
        f"{sum(len(entry.heroes) for entry in maps)} map hero record(s)"
    )
    return [units_dataset, build_maps_dataset(maps)]


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


def collect_abilities(hero: dict) -> list[AbilityEntry]:
    """Return the hero's ability cards, including the ones HDP nests.

    An ability that only exists in another form, stance or unit (Deathwing's
    World Breaker set, Greymane's Worgen attacks, D.Va's pilot kit) is nested
    under its owner rather than listed with the rest. Each is its own card here,
    minus cancel buttons, the primed/active states that only repeat their parent,
    and the talent-granted abilities that already have a talent card.
    """
    source = hero.get("abilities") or {}
    by_id = index_abilities_by_id([hero])
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
    """Minified JSON with sorted keys; data/gamedata/ holds the diffable copy."""
    text = json.dumps(data, ensure_ascii=False, sort_keys=True) + "\n"
    if write_text_if_changed(path, text, dry_run):
        print(f"  {'Would write' if dry_run else 'Written'}: {path}")


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

    for kind in ("unit", "map"):
        companion = companion_data_file(data_file, kind)
        if not os.path.exists(companion):
            print(
                f"ERROR: {os.path.basename(companion)} is missing next to {os.path.basename(data_file)}; "
                "run without --skip-parser to extract it. Nothing was written.",
                file=sys.stderr,
            )
            return 1

    hero_doc = load_json(data_file)
    meta = hero_doc.get("meta", {})
    loaded_heroes = hero_entries(hero_doc)
    print(f"Found {len(loaded_heroes)} hero record(s) in {os.path.basename(data_file)}")
    if not loaded_heroes:
        print(f"ERROR: {os.path.basename(data_file)} holds no heroes; nothing was written", file=sys.stderr)
        return 1

    try:
        version = parse_version(meta.get("heroesVersion", ""), GAMEDATA_CHANNELS[args.channel])
    except ValueError as error:
        print(f"ERROR: {os.path.basename(data_file)}: {error}", file=sys.stderr)
        return 1

    unrecognised: Counter = Counter()
    heroes_dataset = build_hero_dataset(build_structured_heroes(loaded_heroes, overrides, unrecognised))
    try:
        world_datasets = build_world_datasets(data_file, hero_doc, heroes_dataset, overrides, unrecognised)
    except ValueError as error:
        print(f"ERROR: {error}; nothing was written", file=sys.stderr)
        return 1

    for slug, _, hero in loaded_heroes:
        talents_by_tier = collect_talents_by_tier(hero)
        abilities = collect_abilities(hero)
        heroes[slug] = hero
        talents_by_slug[slug] = talents_by_tier
        abilities_by_slug[slug] = abilities

        override = overrides.get(slug, {})
        record = build_hero_info(hero, talents_by_tier, abilities, override)
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
    write_gamedata(args.data_dir, version, [heroes_dataset, *world_datasets], args.dry_run)

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
    report_unrecognised(unrecognised)
    return 0


if __name__ == "__main__":
    sys.exit(main())
