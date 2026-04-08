"""
Regenerate all talent data from the heroespatchnotes/heroes-talents repo.

Outputs:
  - data/talent-names.json        (talent name lookup by hero slug and tier_choice key)
  - data/talent-descriptions.json (talent description lookup, same structure)
  - img/hero/{slug}/avatar.png    (hero portrait icons)
  - img/hero/{slug}/talent{level}_{choice}.png (talent icons)

Source: https://github.com/heroespatchnotes/heroes-talents
The repo tracks HotS game data files and is updated to the final patch (2.55.3).

Usage:
  python generate_talent_data.py              # clones repo to /tmp/heroes-talents
  python generate_talent_data.py --repo-path /path/to/heroes-talents  # use existing clone
  python generate_talent_data.py --dry-run    # report changes without writing
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

REPO_URL = "https://github.com/heroespatchnotes/heroes-talents.git"
DEFAULT_REPO_PATH = "/tmp/heroes-talents"

TALENT_NAMES_PATH = os.path.join(_PROJECT_ROOT, "data", "talent-names.json")
TALENT_DESCRIPTIONS_PATH = os.path.join(_PROJECT_ROOT, "data", "talent-descriptions.json")
HERO_IMAGES_DIR = os.path.join(_PROJECT_ROOT, "img", "hero")

# Slug mapping: our slug -> repo filename (without .json).
# Only entries that differ need to be listed.
SLUG_MAP = {
    "cho": "chogall",
    "li-li": "lili",
    "li-ming": "liming",
    "lt-morales": "ltmorales",
    "lúcio": "lucio",
    "sgt-hammer": "sgthammer",
    "the-butcher": "thebutcher",
    "the-lost-vikings": "lostvikings",
}

# Heroes in our dataset. Generated from herodata.py HERO_NAMES values,
# slugified the same way the frontend does it (lowercase, spaces to dashes,
# strip apostrophes and dots).
# If a hero exists in the repo but not here, it is skipped (not in our replays).
# This list is populated dynamically from the existing img/hero/ directories.


def slugify(name: str) -> str:
    """Match the frontend slugify: lowercase, spaces to dashes, strip ' and ."""
    return name.lower().replace(" ", "-").replace("'", "").replace(".", "")


def strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def file_hash(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def ensure_repo(repo_path: str) -> None:
    """Clone or update the heroes-talents repo."""
    if os.path.exists(os.path.join(repo_path, ".git")):
        print(f"Repo exists at {repo_path}, pulling latest...")
        subprocess.run(["git", "-C", repo_path, "pull", "--ff-only"],
                       check=True, capture_output=True)
    else:
        print(f"Cloning {REPO_URL} to {repo_path}...")
        subprocess.run(["git", "clone", "--depth", "1", REPO_URL, repo_path],
                       check=True, capture_output=True)


def get_our_heroes() -> list[str]:
    """Get hero slugs from existing img/hero/ directories."""
    if not os.path.isdir(HERO_IMAGES_DIR):
        return []
    return sorted(d for d in os.listdir(HERO_IMAGES_DIR)
                  if os.path.isdir(os.path.join(HERO_IMAGES_DIR, d)))


def load_repo_hero(repo_path: str, hero_slug: str) -> dict | None:
    repo_slug = SLUG_MAP.get(hero_slug, hero_slug)
    filepath = os.path.join(repo_path, "hero", f"{repo_slug}.json")
    if not os.path.exists(filepath):
        return None
    with open(filepath) as f:
        return json.load(f)


def generate_names(repo_path: str, heroes: list[str]) -> tuple[dict, int]:
    """Generate talent-names.json content. Returns (data, missing_count)."""
    output = {}
    missing = 0

    for hero_slug in heroes:
        hero_data = load_repo_hero(repo_path, hero_slug)
        if not hero_data:
            print(f"  WARNING: No repo file for '{hero_slug}'")
            missing += 1
            continue

        hero_output = {}
        for tier, talent_list in hero_data.get("talents", {}).items():
            for i, talent in enumerate(talent_list, 1):
                key = f"{tier}_{i}"
                hero_output[key] = talent["name"]

        output[hero_slug] = hero_output

    return output, missing


def generate_descriptions(repo_path: str, heroes: list[str],
                          names: dict) -> tuple[dict, int]:
    """Generate talent-descriptions.json content. Returns (data, missing_count)."""
    output = {}
    missing = 0

    for hero_slug in heroes:
        if hero_slug not in names:
            continue

        hero_data = load_repo_hero(repo_path, hero_slug)
        if not hero_data:
            continue

        # Build {tier: {name: description}} lookup
        repo_by_tier = {}
        for tier, talent_list in hero_data.get("talents", {}).items():
            repo_by_tier[tier] = {
                t["name"]: strip_html(t.get("description", ""))
                for t in talent_list
            }

        hero_output = {}
        for key, talent_name in names[hero_slug].items():
            level = key.split("_")[0]
            tier_talents = repo_by_tier.get(level, {})

            if talent_name in tier_talents:
                hero_output[key] = tier_talents[talent_name]
            else:
                # Case-insensitive fallback
                for repo_name, repo_desc in tier_talents.items():
                    if repo_name.lower() == talent_name.lower():
                        hero_output[key] = repo_desc
                        break
                else:
                    missing += 1
                    print(f"  WARNING: No description for {hero_slug}/{key} "
                          f"'{talent_name}'")

        output[hero_slug] = hero_output

    return output, missing


def sync_icons(repo_path: str, heroes: list[str],
               dry_run: bool = False) -> tuple[int, int]:
    """Sync talent icons and hero portraits. Returns (talents_fixed, portraits_fixed)."""
    repo_talent_images = os.path.join(repo_path, "images", "talents")
    repo_hero_images = os.path.join(repo_path, "images", "heroes")

    talents_fixed = 0
    portraits_fixed = 0

    for hero_slug in heroes:
        hero_data = load_repo_hero(repo_path, hero_slug)
        if not hero_data:
            continue

        hero_dir = os.path.join(HERO_IMAGES_DIR, hero_slug)
        os.makedirs(hero_dir, exist_ok=True)

        # Talent icons
        for tier, talent_list in hero_data.get("talents", {}).items():
            for i, talent in enumerate(talent_list, 1):
                key = f"{tier}_{i}"
                repo_icon = talent.get("icon", "")
                repo_icon_path = os.path.join(repo_talent_images, repo_icon)
                our_icon_path = os.path.join(hero_dir, f"talent{key}.png")

                if not os.path.exists(repo_icon_path):
                    continue

                if file_hash(our_icon_path) != file_hash(repo_icon_path):
                    if not dry_run:
                        shutil.copy2(repo_icon_path, our_icon_path)
                    talents_fixed += 1

        # Hero portrait
        repo_slug = SLUG_MAP.get(hero_slug, hero_slug)
        repo_portrait = os.path.join(repo_hero_images, f"{repo_slug}.png")
        our_portrait = os.path.join(hero_dir, "avatar.png")

        if os.path.exists(repo_portrait):
            if file_hash(our_portrait) != file_hash(repo_portrait):
                if not dry_run:
                    shutil.copy2(repo_portrait, our_portrait)
                portraits_fixed += 1

    return talents_fixed, portraits_fixed


def main():
    parser = argparse.ArgumentParser(description="Regenerate talent data from heroes-talents repo")
    parser.add_argument("--repo-path", default=DEFAULT_REPO_PATH,
                        help=f"Path to heroes-talents repo (default: {DEFAULT_REPO_PATH})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report changes without writing files")
    parser.add_argument("--skip-icons", action="store_true",
                        help="Skip icon sync (names and descriptions only)")
    args = parser.parse_args()

    ensure_repo(args.repo_path)
    heroes = get_our_heroes()
    print(f"Processing {len(heroes)} heroes...")

    # Generate names
    names, names_missing = generate_names(args.repo_path, heroes)
    total_talents = sum(len(v) for v in names.values())
    print(f"\nNames: {total_talents} talents, {names_missing} heroes missing from repo")

    if not args.dry_run:
        with open(TALENT_NAMES_PATH, "w") as f:
            json.dump(names, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  Written: {TALENT_NAMES_PATH}")

    # Generate descriptions
    descriptions, desc_missing = generate_descriptions(args.repo_path, heroes, names)
    total_descs = sum(len(v) for v in descriptions.values())
    print(f"\nDescriptions: {total_descs} matched, {desc_missing} missing")

    if not args.dry_run:
        with open(TALENT_DESCRIPTIONS_PATH, "w") as f:
            json.dump(descriptions, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  Written: {TALENT_DESCRIPTIONS_PATH}")

    # Sync icons
    if not args.skip_icons:
        talents_fixed, portraits_fixed = sync_icons(
            args.repo_path, heroes, dry_run=args.dry_run)
        action = "Would fix" if args.dry_run else "Fixed"
        print(f"\nIcons: {action} {talents_fixed} talent icons, "
              f"{portraits_fixed} hero portraits")

    if names_missing or desc_missing:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
