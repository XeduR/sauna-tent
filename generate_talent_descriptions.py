"""
Generate data/talent-descriptions.json from heroespatchnotes/heroes-talents repo data.

Maps talent descriptions to the same {heroSlug: {"level_choice": "description"}} structure
used by data/talent-names.json.

Expects the heroes-talents repo at /tmp/heroes-talents/ (cloned beforehand).
"""

import json
import os
import re
import sys

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

TALENT_NAMES_PATH = os.path.join(_PROJECT_ROOT, "data", "talent-names.json")
REPO_HERO_DIR = "/tmp/heroes-talents/hero/"
OUTPUT_PATH = os.path.join(_PROJECT_ROOT, "data", "talent-descriptions.json")

# Slug mapping: our slug -> repo filename (without .json)
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


def strip_html(text: str) -> str:
    """Remove HTML tags from text, just in case."""
    return re.sub(r"<[^>]+>", "", text)


def load_repo_talents(hero_slug: str) -> dict[str, dict[str, str]]:
    """Load talents from repo, returning {tier: {name: description}}."""
    repo_slug = SLUG_MAP.get(hero_slug, hero_slug)
    filepath = os.path.join(REPO_HERO_DIR, f"{repo_slug}.json")

    if not os.path.exists(filepath):
        print(f"  WARNING: No repo file for '{hero_slug}' (tried '{repo_slug}.json')")
        return {}

    with open(filepath) as f:
        data = json.load(f)

    result = {}
    for tier, talent_list in data.get("talents", {}).items():
        result[tier] = {}
        for talent in talent_list:
            name = talent.get("name", "")
            desc = strip_html(talent.get("description", ""))
            result[tier][name] = desc

    return result


def main():
    with open(TALENT_NAMES_PATH) as f:
        talent_names = json.load(f)

    output = {}
    total_matched = 0
    total_missing = 0
    missing_details = []

    for hero_slug in sorted(talent_names.keys()):
        hero_talents = talent_names[hero_slug]
        repo_talents = load_repo_talents(hero_slug)

        if not repo_talents:
            total_missing += len(hero_talents)
            for key in hero_talents:
                missing_details.append(f"  {hero_slug}/{key}: {hero_talents[key]} (no repo file)")
            continue

        hero_output = {}
        for key, talent_name in hero_talents.items():
            # key is "level_choice", extract the level part
            level = key.split("_")[0]
            tier_talents = repo_talents.get(level, {})

            if talent_name in tier_talents:
                hero_output[key] = tier_talents[talent_name]
                total_matched += 1
            else:
                # Try case-insensitive match as fallback
                matched = False
                for repo_name, repo_desc in tier_talents.items():
                    if repo_name.lower() == talent_name.lower():
                        hero_output[key] = repo_desc
                        total_matched += 1
                        matched = True
                        break

                if not matched:
                    total_missing += 1
                    available = list(tier_talents.keys()) if tier_talents else ["(empty tier)"]
                    missing_details.append(
                        f"  {hero_slug}/{key}: '{talent_name}' not in tier {level} {available}"
                    )

        output[hero_slug] = hero_output

    # Write output
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\nMatched: {total_matched}")
    print(f"Missing: {total_missing}")
    print(f"Heroes:  {len(output)}")
    print(f"Output:  {OUTPUT_PATH}")

    if missing_details:
        print(f"\nMissing talent details ({len(missing_details)}):")
        for detail in missing_details:
            print(detail)

    if total_missing > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
