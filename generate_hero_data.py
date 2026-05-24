"""
Regenerate all hero data from a local HotS install using HeroesDataParser.

Outputs:
  - data/hero-info.json           (full per-hero reference: stats, abilities, talents)
  - data/talent-names.json        (talent name lookup by hero slug and tier_choice key)
  - data/talent-descriptions.json (talent description lookup, same structure)
  - img/hero/{slug}/avatar.png    (hero select portrait icon)
  - img/hero/{slug}/talent{tier}_{choice}.png (talent icons)
  - img/hero/{slug}/abilities/{nameId-slug}.png (ability icons)

Source: HeroesDataParser (https://github.com/HeroesToolChest/HeroesDataParser)
extracts JSON + images directly from the live HotS game files.

Prerequisites (one-time, on the machine that runs HDP):
  1. Install .NET 8.0 SDK or Runtime: https://dotnet.microsoft.com/download/dotnet/8.0
  2. dotnet tool install --global HeroesDataParser

In the dev container, dotnet is not installed. Use --skip-parser to translate
pre-extracted HDP output (e.g. from a Windows run, or the bundled test samples
under .scratch/HeroesDataParser-main/Tests/...).

Usage:
  python generate_hero_data.py                 # full pipeline: HDP + translate + sync
  python generate_hero_data.py --skip-parser   # skip HDP, translate existing output
  python generate_hero_data.py --dry-run       # report actions, no writes
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

DEFAULT_GAME_PATH = os.path.join(_PROJECT_ROOT, ".scratch", "Heroes of the Storm")
DEFAULT_HDP_OUTPUT = os.path.join(_PROJECT_ROOT, ".scratch", "hots-data-output")
DEFAULT_DATA_DIR = os.path.join(_PROJECT_ROOT, "data")
DEFAULT_IMG_DIR = os.path.join(_PROJECT_ROOT, "img", "hero")

HERO_INFO_FILENAME = "hero-info.json"
TALENT_NAMES_FILENAME = "talent-names.json"
TALENT_DESCRIPTIONS_FILENAME = "talent-descriptions.json"

# Ability categories kept in hero-info.json. mount/activable/hearth are generic and
# rarely consulted, so they are excluded to keep the JSON small.
ABILITY_CATEGORIES = ("basic", "heroic", "trait")

# HDP groups talents under levelN keys. Tiers map level# -> tier index used in our keys.
TALENT_LEVELS = (1, 4, 7, 10, 13, 16, 20)


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


def copy_if_changed(src: str, dst: str, dry_run: bool) -> bool:
    """Copy src -> dst if hashes differ. Returns True if a copy happened/would happen."""
    if not os.path.exists(src):
        return False
    if file_hash(src) == file_hash(dst):
        return False
    if not dry_run:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    return True


def run_hdp(game_path: str, output_dir: str) -> None:
    """Invoke HeroesDataParser. Raises CalledProcessError on failure."""
    if shutil.which("dotnet") is None:
        raise SystemExit(
            "ERROR: 'dotnet' not found in PATH. Install .NET 8.0 and run\n"
            "  dotnet tool install --global HeroesDataParser\n"
            "Or pass --skip-parser to translate an existing HDP output directory."
        )
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        "dotnet", "heroes-data", game_path,
        "-e", "herodata",
        "-i", "herodata-split",
        "--json",
        "--file-split",
        "-o", output_dir,
    ]
    print(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def discover_hero_files(hdp_output: str) -> list[str]:
    """Return absolute paths to per-hero JSON files in HDP output."""
    # HDP writes to either <output>/json/ (default) or directly into <output>
    # depending on version. Check both.
    candidates = (
        os.path.join(hdp_output, "json"),
        hdp_output,
    )
    for d in candidates:
        if not os.path.isdir(d):
            continue
        files = sorted(
            os.path.join(d, f) for f in os.listdir(d)
            if f.endswith(".json") and not f.startswith("jsongamestring")
            and not f.startswith("jsonoutput")
        )
        if files:
            return files
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


def build_talent_names(talents_by_tier: dict[int, list[dict]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for tier, talents in talents_by_tier.items():
        for i, talent in enumerate(talents, 1):
            out[f"{tier}_{i}"] = talent.get("name", "")
    return out


def build_talent_descriptions(talents_by_tier: dict[int, list[dict]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for tier, talents in talents_by_tier.items():
        for i, talent in enumerate(talents, 1):
            out[f"{tier}_{i}"] = strip_html(talent.get("fullTooltip", ""))
    return out


def build_abilities(hero: dict) -> dict[str, list[dict]]:
    src = hero.get("abilities", {})
    out: dict[str, list[dict]] = {}
    for category in ABILITY_CATEGORIES:
        entries = []
        for ability in src.get(category, []):
            name_id = ability.get("nameId", "")
            entries.append({
                "id": name_id,
                "name": ability.get("name", ""),
                "icon": slugify(name_id) + ".png" if name_id else "",
                "abilityType": ability.get("abilityType", ""),
                "cooldown": ability.get("cooldownTooltip", ""),
                "manaCost": ability.get("energyTooltip", ""),
                "description": strip_html(ability.get("fullTooltip", "")),
            })
        out[category] = entries
    return out


def build_hero_info(hero: dict, talents_by_tier: dict[int, list[dict]]) -> dict:
    weapons = hero.get("weapons") or []
    primary = weapons[0] if weapons else {}
    life = hero.get("life") or {}
    armor_hero = (hero.get("armor") or {}).get("hero") or {}

    talents_out: dict[str, dict] = {}
    for tier, talents in talents_by_tier.items():
        for i, talent in enumerate(talents, 1):
            key = f"{tier}_{i}"
            talents_out[key] = {
                "name": talent.get("name", ""),
                "icon": f"talent{key}.png",
                "description": strip_html(talent.get("fullTooltip", "")),
                "abilityType": talent.get("abilityType", ""),
                "isQuest": talent.get("isQuest", False),
                "isActive": talent.get("isActive", False),
            }

    return {
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
        "armor": {
            "basic": armor_hero.get("basic", 0),
            "ability": armor_hero.get("ability", 0),
            "splash": armor_hero.get("splash", 0),
        },
        "attackRange": primary.get("range"),
        "attackSpeed": primary.get("period"),
        "attackDamage": primary.get("damage"),
        "attackDamageScale": primary.get("damageScale"),
        "weapons": weapons,
        "abilities": build_abilities(hero),
        "talents": talents_out,
        "heroUnits": hero.get("heroUnits", []),
    }


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

    # Portrait (heroSelect variant, per user choice in plan).
    portrait_file = (hero.get("portraits") or {}).get("heroSelect")
    if portrait_file:
        src = os.path.join(portraits_dir, portrait_file)
        dst = os.path.join(hero_dir, "avatar.png")
        if os.path.exists(src):
            if copy_if_changed(src, dst, dry_run):
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
                if copy_if_changed(src, dst, dry_run):
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
                if copy_if_changed(src, dst, dry_run):
                    abilities_synced += 1
            else:
                missing += 1

    return portraits_synced, talents_synced, abilities_synced, missing


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
    parser.add_argument("--game-path", default=DEFAULT_GAME_PATH,
                        help=f"Path to HotS install (default: {DEFAULT_GAME_PATH})")
    parser.add_argument("--hdp-output", default=DEFAULT_HDP_OUTPUT,
                        help=f"HDP raw output dir (default: {DEFAULT_HDP_OUTPUT})")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR,
                        help=f"Final JSON output dir (default: {DEFAULT_DATA_DIR})")
    parser.add_argument("--img-dir", default=DEFAULT_IMG_DIR,
                        help=f"Per-hero image dir (default: {DEFAULT_IMG_DIR})")
    parser.add_argument("--skip-parser", action="store_true",
                        help="Skip HDP invocation; use existing --hdp-output content")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report actions without writing")
    args = parser.parse_args()

    if not args.skip_parser:
        run_hdp(args.game_path, args.hdp_output)

    hero_files = discover_hero_files(args.hdp_output)
    if not hero_files:
        print(f"ERROR: no hero JSON files found under {args.hdp_output}", file=sys.stderr)
        return 1
    print(f"Found {len(hero_files)} hero JSON file(s) in {args.hdp_output}")

    hero_info: dict[str, dict] = {}
    talent_names: dict[str, dict] = {}
    talent_descriptions: dict[str, dict] = {}

    total_portraits = total_talents = total_abilities = total_missing = 0

    for path in hero_files:
        loaded = load_hero(path)
        if loaded is None:
            print(f"  Skipped (no name field): {os.path.basename(path)}")
            continue
        slug, hero = loaded

        talents_by_tier = collect_talents_by_tier(hero)

        hero_info[slug] = build_hero_info(hero, talents_by_tier)
        talent_names[slug] = build_talent_names(talents_by_tier)
        talent_descriptions[slug] = build_talent_descriptions(talents_by_tier)

        p, t, a, m = sync_hero_images(
            hero, slug, talents_by_tier, args.hdp_output, args.img_dir, args.dry_run,
        )
        total_portraits += p
        total_talents += t
        total_abilities += a
        total_missing += m

    write_json(os.path.join(args.data_dir, HERO_INFO_FILENAME), hero_info, args.dry_run)
    write_json(os.path.join(args.data_dir, TALENT_NAMES_FILENAME), talent_names, args.dry_run)
    write_json(
        os.path.join(args.data_dir, TALENT_DESCRIPTIONS_FILENAME),
        talent_descriptions,
        args.dry_run,
    )

    verb = "Would sync" if args.dry_run else "Synced"
    print(
        f"\nImages: {verb} {total_portraits} portrait(s), {total_talents} talent icon(s), "
        f"{total_abilities} ability icon(s). {total_missing} source image(s) missing."
    )
    print(f"Heroes processed: {len(hero_info)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
