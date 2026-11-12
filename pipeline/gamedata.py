"""Structured game data: one JSON file per item in a fixed key order, so a game
patch shows up in git diff line by line, plus a minified snapshot per version."""

import copy
import datetime
import json
import os
import re
from collections import Counter
from typing import Any, NamedTuple

GAMEDATA_DIRNAME = "gamedata"
VERSIONS_FILENAME = "versions.json"
SNAPSHOTS_DIRNAME = "snapshots"
COMMON_ABILITIES_FILENAME = "common-abilities.json"
HEROES_DATASET = "heroes"
UNITS_DATASET = "units"
MAPS_DATASET = "maps"
MAP_FILENAME = "map.json"

CHANNEL_LIVE = "live"
CHANNEL_PTR = "ptr"
PTR_SUFFIX = "_ptr"

# heroesVersion is major.minor.patch.build, with _ptr appended on the test build.
VERSION_ID_PATTERN = re.compile(r"^(\d+(?:\.\d+)*)\.(\d+)(_ptr)?$")

# HDP's id for a passive ability; the button it was built from carries a usable one.
PASSIVE_ABILITY_ID = ":PASSIVE:"

# The shared "stop channelling" button art; such a button repeats its parent's tooltip.
CANCEL_ICON = "hud_btn_bg_ability_cancel.png"

# HDP's ability categories mapped to record lists; the hearthstone counts as an activable.
HERO_ABILITY_CATEGORIES = (
	("Basic", "basic"),
	("Heroic", "heroic"),
	("Trait", "trait"),
	("Mount", "mount"),
	("Activable", "activable"),
	("Hearth", "activable"),
)
ABILITY_LIST_KEYS = ("basic", "heroic", "trait", "mount", "activable")

# Cosmetic and internal categories, left out of every record.
DROPPED_ABILITY_CATEGORIES = frozenset(("Hidden", "Taunt", "Dance", "Spray", "Voice"))

# Generic abilities written once to common-abilities.json; a hero keeps its own
# copy only when it differs from the one most heroes share.
COMMON_ABILITY_IDS = ("Mount", "Hearthstone")

HERO_KEYS = (
	"id", "name", "title", "unitId", "franchise", "roles", "expandedRole",
	"difficulty", "isMelee", "releaseDate", "ratings", "playstyles", "stats",
	"weapons", "abilities", "talents", "units", "summonedUnitIds",
)
HERO_PLAIN_FIELDS = (
	"unitId", "franchise", "roles", "expandedRole", "difficulty", "isMelee",
	"releaseDate", "playstyles", "summonedUnitIds",
)
HERO_KEPT = frozenset((
	"name", "title", "unitId", "franchise", "roles", "expandedRole", "difficulty",
	"isMelee", "releaseDate", "ratings", "playstyles", "life", "shield", "energy",
	"speed", "sight", "radius", "innerRadius", "weapons", "abilities",
	"subAbilities", "talents", "heroUnits", "summonedUnitIds",
))
HERO_DROPPED = frozenset((
	"hyperlinkId", "attributeId", "rarity", "gender", "attributes",
	"scalingLinkIds", "portraits", "searchText", "description", "infoText",
	"skinIds", "variationSkinIds", "voiceLineIds", "defaultMountId",
	"mountCategoryIds", "sortName",
))

RATING_KEYS = ("complexity", "damage", "survivability", "utility")

VITAL_NAMES = ("life", "shield", "energy")
VITAL_KEYS = ("type", "amount", "scale", "regenRate", "regenScale", "regenDelay")
HERO_STAT_KEYS = ("speed", "sight", "radius", "innerRadius")
UNIT_STAT_KEYS = ("armor",) + HERO_STAT_KEYS

WEAPON_VALUE_KEYS = (
	"nameId", "range", "minimumRange", "period", "damage", "damageScale", "damageFactors", "vitalCost",
)
WEAPON_KEPT = frozenset(WEAPON_VALUE_KEYS + ("isDisabled",))

ABILITY_KEYS = (
	"id", "name", "type", "parent", "cooldown", "cost", "lifeCost", "charges",
	"toggleCooldown", "description",
)
ABILITY_KEPT = frozenset((
	"abilityId", "name", "abilityType", "cooldownText", "energyText", "lifeText",
	"charges", "toggleCooldown", "fullText",
))
CHARGE_KEYS = ("countMax", "countStart", "countUse", "recastCooldown", "isCountHidden")

TALENT_KEYS = (
	"id", "name", "type", "isQuest", "ability", "cooldown", "cost",
	"toggleCooldown", "prerequisites", "description",
)
TALENT_KEPT = frozenset((
	"talentId", "name", "abilityType", "isQuest", "abilityId", "cooldownText",
	"energyText", "toggleCooldown", "prerequisiteTalentIds", "fullText",
))
ABILITY_DROPPED = frozenset((
	"linkId", "buttonId", "icon", "shortText", "upgradesAbilityType", "hasHotkey",
	"sort", "tooltipAbilityLinkIds",
))

UNIT_KEYS = (
	"id", "name", "damageType", "attributes", "description", "killXP", "stats",
	"weapons", "abilities", "playstyles", "summonedUnitIds",
)
UNIT_PLAIN_FIELDS = ("damageType", "attributes", "killXP", "playstyles", "summonedUnitIds")
UNIT_KEPT = frozenset((
	"name", "damageType", "attributes", "description", "killXP", "life", "shield",
	"energy", "armor", "speed", "sight", "radius", "innerRadius", "weapons",
	"abilities", "subAbilities", "playstyles", "summonedUnitIds",
))
UNIT_DROPPED = frozenset(("portraits", "scalingLinkIds", "gender"))

# Raw unit keys that make a unit worth a file even with no ability left.
UNIT_CONTENT_KEYS = ("damageType", "weapons", "killXP", "energy", "shield", "armor", "description")

MAP_KEYS = ("id", "name", "size", "objectives")
MAP_KEPT = frozenset(("normalizedId", "name", "mapId", "mapSize", "mapObjectives"))
MAP_DROPPED = frozenset(("mapLink", "replayPreviewImage", "loadingScreenImage"))
MAP_SIZE_KEYS = ("x", "y")
OBJECTIVE_KEYS = ("title", "description")
OBJECTIVE_DROPPED = frozenset(("icons",))

# JSON patch operations HDP's per-map files use; any other aborts the run.
PATCH_OPERATIONS = frozenset(("add", "replace", "remove"))

# Text fields of abilities and talents: (record key, HDP key).
COST_FIELDS = (("cooldown", "cooldownText"), ("cost", "energyText"), ("lifeCost", "lifeText"))

# Record keys that say where an ability sits rather than what it does.
ABILITY_PLACEMENT_KEYS = ("id", "parent")


class Dataset(NamedTuple):
	"""One kind of game data in one version.

	files maps a path relative to the channel directory to its record; the
	channel's <name>/ folder mirrors the entries under it. snapshot holds the
	keys that follow "id" in snapshots/<id>/<name>.json.
	"""

	name: str
	files: dict[str, Any]
	snapshot: dict[str, Any]


class GameVersion(NamedTuple):
	id: str
	channel: str
	version: str
	build: int


class AbilitySource(NamedTuple):
	"""One raw ability, the record list it goes to, and the name of what owns it."""

	category: str
	ability: dict
	parent: str


class MapData(NamedTuple):
	"""One map's record and the full records its patch changes from the base datasets."""

	id: str
	record: dict
	units: dict[str, dict]
	heroes: dict[str, dict]
	# None when the map's common abilities equal the base list.
	common_abilities: list[dict] | None


def strip_html(text: str) -> str:
	"""Strip Blizzard's SC2-style markup. Preserve <n/> as real newlines."""
	if not text:
		return ""
	text = text.replace("<n/>", "\n")
	return re.sub(r"<[^>]+>", "", text)


def parse_version(version_id: str, channel: str) -> GameVersion:
	"""Split heroesVersion into its parts, rejecting one from the other channel."""
	match = VERSION_ID_PATTERN.match(version_id)
	if not match:
		raise ValueError(f"unrecognised heroesVersion {version_id!r}")

	is_ptr = match.group(3) is not None
	if is_ptr != (channel == CHANNEL_PTR):
		raise ValueError(
			f"heroesVersion {version_id!r} is {'a PTR' if is_ptr else 'a live'} build, "
			f"but the run is for the {channel} channel"
		)
	return GameVersion(version_id, channel, match.group(1), int(match.group(2)))


def ordered(values: dict, schema: tuple[str, ...]) -> dict:
	"""Return values in schema order; keys outside the schema (overrides) follow."""
	record = {key: values[key] for key in schema if key in values}
	record.update((key, value) for key, value in values.items() if key not in record)
	return record


def copy_present(raw: dict, keys: tuple[str, ...]) -> dict:
	return {key: raw[key] for key in keys if key in raw}


def ability_id(entry: dict) -> str:
	"""Return the id HDP gives an ability, or its button's when it has none."""
	value = entry.get("abilityId", "")
	return entry.get("buttonId", "") if value == PASSIVE_ABILITY_ID else value


def is_cancel_button(ability: dict) -> bool:
	return (
		ability.get("icon") == CANCEL_ICON
		or "cancel" in (ability.get("name") or "").lower()
	)


def index_abilities_by_id(owners: list[dict]) -> dict[str, dict]:
	"""Map the owners' abilities by both of their ids, nested ones included.

	Nested abilities are in here because one can be another's parent: Deathwing's
	Onslaught hangs off World Breaker, which itself hangs off Dragonflight.
	"""
	index: dict[str, dict] = {}
	groups = []
	for owner in owners:
		groups.extend((owner.get("abilities") or {}).values())
		for nested in (owner.get("subAbilities") or {}).values():
			groups.extend(nested.values())

	for abilities in groups:
		for ability in abilities:
			for key in (ability.get("abilityId"), ability.get("buttonId")):
				if key and key != PASSIVE_ABILITY_ID:
					index.setdefault(key, ability)
	return index


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


def owner_ability_sources(
	owner: dict, parent: str, by_id: dict[str, dict], talents_by_link: dict[str, dict],
) -> list[AbilitySource]:
	"""An owner's abilities in category order, then its nested ones, minus cancel buttons.

	A nested group belongs to the talent whose link it carries, else to the ability
	its link names, else to the owner itself.
	"""
	groups = [(parent, owner.get("abilities") or {})]
	for link, nested in (owner.get("subAbilities") or {}).items():
		link_ids = link.split("|")
		talent = talents_by_link.get(link)
		owning = talent or by_id.get(link_ids[0]) or by_id.get(link_ids[1]) or {}
		groups.append((owning.get("name") or parent, nested))

	return [
		AbilitySource(category, ability, group_parent)
		for group_parent, group in groups
		for source_category, category in HERO_ABILITY_CATEGORIES
		for ability in group.get(source_category, [])
		if not is_cancel_button(ability)
	]


def hero_ability_sources(hero: dict) -> list[AbilitySource]:
	"""The hero's abilities and nested abilities, then each hero form unit's."""
	owners = [(hero, "")] + [
		(unit, hero_unit_label(hero, unit_id, unit))
		for unit_id, unit in (hero.get("heroUnits") or {}).items()
	]
	by_id = index_abilities_by_id([owner for owner, _ in owners])
	talents_by_link = {
		talent.get("linkId", ""): talent
		for talents in (hero.get("talents") or {}).values()
		for talent in talents
	}
	return [
		source
		for owner, parent in owners
		for source in owner_ability_sources(owner, parent, by_id, talents_by_link)
	]


def unit_ability_sources(unit: dict) -> list[AbilitySource]:
	return owner_ability_sources(unit, "", index_abilities_by_id([unit]), {})


def build_stats(raw: dict, plain_keys: tuple[str, ...]) -> dict:
	stats = {
		name: copy_present(raw[name], VITAL_KEYS)
		for name in VITAL_NAMES
		if isinstance(raw.get(name), dict)
	}
	stats.update(copy_present(raw, plain_keys))
	return stats


def build_weapons(raw: dict) -> list[dict]:
	"""Every weapon in source order; only a disabled one carries isDisabled."""
	weapons = []
	for weapon in raw.get("weapons") or []:
		record = copy_present(weapon, WEAPON_VALUE_KEYS)
		if weapon.get("isDisabled"):
			record["isDisabled"] = True
		weapons.append(record)
	return weapons


def copy_cost_fields(raw: dict, values: dict) -> None:
	for key, source_key in COST_FIELDS:
		if source_key in raw:
			values[key] = strip_html(raw[source_key])


def build_ability(entry_id: str, ability: dict, parent: str, override: dict) -> dict:
	values = {
		"id": entry_id,
		"name": override.get("name") or strip_html(ability.get("name", "")),
		"type": ability.get("abilityType", ""),
	}
	if parent:
		values["parent"] = parent

	copy_cost_fields(ability, values)
	if isinstance(ability.get("charges"), dict):
		values["charges"] = copy_present(ability["charges"], CHARGE_KEYS)
	if "toggleCooldown" in ability:
		values["toggleCooldown"] = ability["toggleCooldown"]

	values["description"] = override.get("description") or strip_html(ability.get("fullText", ""))
	return ordered(values, ABILITY_KEYS)


def unique_ability_id(ability: dict, parent: str, used_ids: set[str]) -> str:
	"""abilityId, else buttonId, else <id>@<parent>, numbered on a further clash."""
	base = ability_id(ability)
	candidates = [base, ability.get("buttonId", ""), f"{base}@{parent}"]
	candidate = next((value for value in candidates if value and value not in used_ids), "")
	number = 2
	while not candidate:
		numbered = f"{base}@{parent}@{number}"
		candidate = numbered if numbered not in used_ids else ""
		number += 1
	return candidate


def build_ability_lists(sources: list[AbilitySource], overrides: dict) -> dict[str, list[dict]]:
	"""Translate every source, skipping one that repeats an earlier record but for id and parent."""
	lists: dict[str, list[dict]] = {key: [] for key in ABILITY_LIST_KEYS}
	used_ids: set[str] = set()
	seen: set[str] = set()
	for source in sources:
		entry_id = unique_ability_id(source.ability, source.parent, used_ids)
		record = build_ability(entry_id, source.ability, source.parent, overrides.get(entry_id, {}))
		content = json.dumps(
			{key: value for key, value in record.items() if key not in ABILITY_PLACEMENT_KEYS},
			ensure_ascii=False, sort_keys=True,
		)
		if content in seen:
			continue

		seen.add(content)
		used_ids.add(entry_id)
		lists[source.category].append(record)
	return lists


def build_talent(talent: dict) -> dict:
	"""Structured record for one talent, already merged with its override."""
	values = {
		"id": talent.get("talentId", ""),
		"name": strip_html(talent.get("name", "")),
		"type": talent.get("abilityType", ""),
		"isQuest": talent.get("isQuest", False),
	}
	ability = talent.get("abilityId", "")
	if ability and ability != PASSIVE_ABILITY_ID:
		values["ability"] = ability

	copy_cost_fields(talent, values)
	if "toggleCooldown" in talent:
		values["toggleCooldown"] = talent["toggleCooldown"]
	if "prerequisiteTalentIds" in talent:
		values["prerequisites"] = talent["prerequisiteTalentIds"]

	values["description"] = talent.get("description") or strip_html(talent.get("fullText", ""))
	return ordered(values, TALENT_KEYS)


def build_unit_record(unit_id: str, unit: dict, include_abilities: bool) -> dict:
	"""A unit's record; a hero form leaves abilities out because the hero's lists hold them."""
	values: dict[str, Any] = {"id": unit_id, "name": strip_html(unit.get("name", ""))}
	values.update(copy_present(unit, UNIT_PLAIN_FIELDS))
	if "description" in unit:
		values["description"] = strip_html(unit["description"])

	values["stats"] = build_stats(unit, UNIT_STAT_KEYS)
	if "weapons" in unit:
		values["weapons"] = build_weapons(unit)
	if include_abilities:
		values["abilities"] = build_ability_lists(unit_ability_sources(unit), {})
	return ordered(values, UNIT_KEYS)


def note_unrecognised(
	unknown: Counter, kind: str, raw: dict, kept: frozenset, dropped: frozenset = frozenset(),
) -> None:
	for key in raw:
		if key not in kept and key not in dropped:
			unknown[f"{kind}.{key}"] += 1


def note_stats_and_weapons(raw: dict, unknown: Counter, kind: str) -> None:
	for name in VITAL_NAMES:
		if isinstance(raw.get(name), dict):
			note_unrecognised(unknown, f"{kind}.{name}", raw[name], frozenset(VITAL_KEYS))
	for weapon in raw.get("weapons") or []:
		note_unrecognised(unknown, f"{kind}.weapon", weapon, WEAPON_KEPT)


def note_owner_abilities(owner: dict, unknown: Counter, kind: str) -> None:
	known_categories = {source for source, _ in HERO_ABILITY_CATEGORIES}
	groups = [(f"{kind}.abilities", owner.get("abilities") or {})]
	groups += [(f"{kind}.subAbilities", nested) for nested in (owner.get("subAbilities") or {}).values()]

	for group_kind, group in groups:
		for category, abilities in group.items():
			if category in DROPPED_ABILITY_CATEGORIES:
				continue
			if category not in known_categories:
				unknown[f"{group_kind}.{category}"] += 1
			for ability in abilities:
				note_unrecognised(unknown, "ability", ability, ABILITY_KEPT, ABILITY_DROPPED)
				note_unrecognised(unknown, "ability.charges", ability.get("charges") or {}, frozenset(CHARGE_KEYS))


def note_unit_fields(unit: dict, unknown: Counter) -> None:
	"""Count every parser field a unit record has no place for."""
	note_unrecognised(unknown, "unit", unit, UNIT_KEPT, UNIT_DROPPED)
	note_stats_and_weapons(unit, unknown, "unit")
	note_owner_abilities(unit, unknown, "unit")


def note_hero_fields(hero: dict, unknown: Counter) -> None:
	"""Count every parser field the hero record has no place for."""
	note_unrecognised(unknown, "hero", hero, HERO_KEPT, HERO_DROPPED)
	note_unrecognised(unknown, "hero.ratings", hero.get("ratings") or {}, frozenset(RATING_KEYS))
	note_stats_and_weapons(hero, unknown, "hero")
	note_owner_abilities(hero, unknown, "hero")
	for unit in (hero.get("heroUnits") or {}).values():
		note_unit_fields(unit, unknown)

	for level, talents in (hero.get("talents") or {}).items():
		if not re.fullmatch(r"Level\d+", level):
			unknown[f"hero.talents.{level}"] += 1
		for talent in talents:
			note_unrecognised(unknown, "talent", talent, TALENT_KEPT, ABILITY_DROPPED)


def build_hero_record(
	item_id: str,
	hero: dict,
	talents_by_tier: dict[int, list[dict]],
	override: dict,
	unknown: Counter,
) -> dict:
	"""Structured hero record from HDP's hero and its talents grouped by tier."""
	note_hero_fields(hero, unknown)
	values: dict[str, Any] = {"id": item_id, "name": strip_html(hero.get("name", ""))}
	if "title" in hero:
		values["title"] = strip_html(hero["title"])
	values.update(copy_present(hero, HERO_PLAIN_FIELDS))
	if isinstance(hero.get("ratings"), dict):
		values["ratings"] = copy_present(hero["ratings"], RATING_KEYS)

	values["stats"] = build_stats(hero, HERO_STAT_KEYS)
	if "weapons" in hero:
		values["weapons"] = build_weapons(hero)
	values["abilities"] = build_ability_lists(hero_ability_sources(hero), override.get("abilities", {}))

	talent_overrides = override.get("talents", {})
	values["talents"] = {
		f"level{tier}": [
			build_talent(talent | talent_overrides.get(talent.get("talentId", ""), {}))
			for talent in talents
		]
		for tier, talents in talents_by_tier.items()
	}

	if "heroUnits" in hero:
		values["units"] = [
			build_unit_record(unit_id, unit, include_abilities=False)
			for unit_id, unit in hero["heroUnits"].items()
		]

	for key, value in override.items():
		if key not in ("abilities", "talents"):
			values[key] = value

	return ordered(values, HERO_KEYS)


def split_common_abilities(records: dict[str, dict]) -> list[dict]:
	"""Remove the generic abilities from every hero whose copy matches the most shared one."""
	common = []
	for ability_id in COMMON_ABILITY_IDS:
		copies: Counter = Counter()
		for record in records.values():
			for abilities in record["abilities"].values():
				for ability in abilities:
					if ability["id"] == ability_id:
						copies[json.dumps(ability, ensure_ascii=False)] += 1
		if not copies:
			continue

		# Ties fall to the text order so the choice never depends on dict order.
		shared = json.loads(min(copies, key=lambda text: (-copies[text], text)))
		common.append(shared)
		for record in records.values():
			for category, abilities in record["abilities"].items():
				record["abilities"][category] = [ability for ability in abilities if ability != shared]
	return common


def build_hero_dataset(records: dict[str, dict]) -> Dataset:
	"""Hero files keyed by slug, with the generic abilities split out first."""
	common = split_common_abilities(records)
	heroes = {slug: records[slug] for slug in sorted(records)}
	files: dict[str, Any] = {f"{HEROES_DATASET}/{slug}.json": record for slug, record in heroes.items()}
	files[COMMON_ABILITIES_FILENAME] = common
	return Dataset(HEROES_DATASET, files, {"heroes": heroes, "commonAbilities": common})


def check_unit_id_case(unit_ids: list[str], source: str) -> None:
	"""Reject ids that differ only by letter case: their files would collide on Windows."""
	by_folded: dict[str, str] = {}
	for unit_id in unit_ids:
		other = by_folded.setdefault(unit_id.casefold(), unit_id)
		if other != unit_id:
			raise ValueError(f"{source}: unit ids {other!r} and {unit_id!r} differ only by letter case")


def build_unit_records(units: dict[str, dict], unknown: Counter) -> tuple[dict[str, dict], int]:
	"""Records in id order for units with gameplay content, and how many were skipped."""
	records = {}
	for unit_id in sorted(units):
		unit = units[unit_id]
		note_unit_fields(unit, unknown)
		record = build_unit_record(unit_id, unit, include_abilities=True)
		has_ability = any(record["abilities"].values())
		if has_ability or any(key in unit for key in UNIT_CONTENT_KEYS):
			records[unit_id] = record
	return records, len(units) - len(records)


def build_units_dataset(records: dict[str, dict]) -> Dataset:
	files = {f"{UNITS_DATASET}/{unit_id}.json": record for unit_id, record in records.items()}
	return Dataset(UNITS_DATASET, files, {"units": records})


def build_map_record(raw: dict, unknown: Counter) -> dict:
	note_unrecognised(unknown, "map", raw, MAP_KEPT, MAP_DROPPED)
	note_unrecognised(unknown, "map.mapSize", raw.get("mapSize") or {}, frozenset(MAP_SIZE_KEYS))
	for objective in raw.get("mapObjectives") or []:
		note_unrecognised(unknown, "map.objective", objective, frozenset(OBJECTIVE_KEYS), OBJECTIVE_DROPPED)

	values: dict[str, Any] = {"id": raw.get("mapId", ""), "name": strip_html(raw.get("name", ""))}
	if isinstance(raw.get("mapSize"), dict):
		values["size"] = copy_present(raw["mapSize"], MAP_SIZE_KEYS)
	values["objectives"] = [
		{key: strip_html(objective.get(key, "")) for key in OBJECTIVE_KEYS}
		for objective in raw.get("mapObjectives") or []
	]
	return ordered(values, MAP_KEYS)


def changed_records(records: dict[str, dict], base: dict[str, dict]) -> dict[str, dict]:
	return {key: record for key, record in records.items() if base.get(key) != record}


def build_maps_dataset(maps: list[MapData]) -> Dataset:
	"""Each map's folder holds map.json plus the records that differ on that map, in full."""
	files: dict[str, Any] = {}
	snapshot: dict[str, dict] = {}
	for map_data in sorted(maps, key=lambda entry: entry.id):
		folder = f"{MAPS_DATASET}/{map_data.id}"
		files[f"{folder}/{MAP_FILENAME}"] = map_data.record
		entry: dict[str, Any] = {"map": map_data.record}

		for part, records in (("units", map_data.units), ("heroes", map_data.heroes)):
			ordered_records = {key: records[key] for key in sorted(records)}
			files.update((f"{folder}/{part}/{key}.json", record) for key, record in ordered_records.items())
			if ordered_records:
				entry[part] = ordered_records

		if map_data.common_abilities is not None:
			files[f"{folder}/{COMMON_ABILITIES_FILENAME}"] = map_data.common_abilities
			entry["commonAbilities"] = map_data.common_abilities
		snapshot[map_data.id] = entry
	return Dataset(MAPS_DATASET, files, {"maps": snapshot})


def pointer_parts(pointer: str) -> list[str]:
	if not pointer.startswith("/"):
		raise ValueError(f"unsupported JSON pointer {pointer!r}")
	return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]


def list_index(values: list, part: str, allow_end: bool) -> int:
	if part == "-" and allow_end:
		return len(values)
	if not part.isdigit() or (part != "0" and part.startswith("0")):
		raise ValueError(f"invalid list index {part!r}")

	index = int(part)
	if index > len(values) or (index == len(values) and not allow_end):
		raise ValueError(f"list index {index} out of range")
	return index


def apply_json_patch(document: Any, operations: list[dict]) -> Any:
	"""Apply an RFC 6902 add/replace/remove patch without touching document.

	Containers on a patched path are copied on first use, so the result shares
	every untouched item with document and a changed item is a different object.
	"""
	copied: set[int] = set()

	def own(value: Any) -> Any:
		duplicate = copy.copy(value)
		copied.add(id(duplicate))
		return duplicate

	root = own(document)
	for operation in operations:
		kind = operation.get("op")
		if kind not in PATCH_OPERATIONS:
			raise ValueError(f"unsupported JSON patch operation {kind!r}")

		parts = pointer_parts(operation.get("path", ""))
		parent = root
		for part in parts[:-1]:
			key: Any = list_index(parent, part, False) if isinstance(parent, list) else part
			if isinstance(parent, dict) and key not in parent:
				raise ValueError(f"path {operation['path']!r} does not exist")

			child = parent[key]
			if not isinstance(child, (dict, list)):
				raise ValueError(f"path {operation['path']!r} runs through a value")
			if id(child) not in copied:
				child = own(child)
				parent[key] = child
			parent = child

		last = parts[-1]
		if isinstance(parent, list):
			index = list_index(parent, last, kind == "add")
			if kind == "add":
				parent.insert(index, operation["value"])
			elif kind == "replace":
				parent[index] = operation["value"]
			else:
				del parent[index]
			continue

		if kind != "add" and last not in parent:
			raise ValueError(f"path {operation['path']!r} does not exist")
		if kind == "remove":
			del parent[last]
		else:
			parent[last] = operation["value"]
	return root


def pretty_json(data: Any) -> str:
	return json.dumps(data, ensure_ascii=False, indent="\t") + "\n"


def minified_json(data: Any) -> str:
	return json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"


def write_text_if_changed(path: str, text: str, dry_run: bool) -> bool:
	"""Write text as UTF-8 with LF line ends unless the file already holds those bytes."""
	content = text.encode("utf-8")
	# Opening without an exists() check first saves a stat per file, which is slow on the 9p mount.
	try:
		with open(path, "rb") as f:
			existing = f.read()
	except FileNotFoundError:
		existing = None
	if existing == content:
		return False

	if not dry_run:
		os.makedirs(os.path.dirname(path), exist_ok=True)
		with open(path, "wb") as f:
			f.write(content)
	return True


def remove_stale_files(folder: str, expected: set[str], dry_run: bool) -> int:
	"""Delete *.json files at any depth in folder that the current version does not have.

	expected holds paths relative to folder with / separators. Directories the
	deletions leave empty are removed too.

	On a case-insensitive filesystem a write to a name that changed only in letter
	case keeps the old name, so such a file is renamed to the expected name, never deleted.
	"""
	if not os.path.isdir(folder):
		return 0
	if not expected:
		print(f"  Refusing to delete from {folder}: this version has no files for it")
		return 0

	expected_by_folded = {relative_path.casefold(): relative_path for relative_path in expected}
	stale = []
	renames = []
	for current, subfolders, names in os.walk(folder):
		subfolders.sort()
		relative_folder = os.path.relpath(current, folder).replace(os.sep, "/")
		prefix = "" if relative_folder == "." else f"{relative_folder}/"
		for name in sorted(names):
			relative_path = f"{prefix}{name}"
			if not name.endswith(".json") or relative_path in expected:
				continue

			target = expected_by_folded.get(relative_path.casefold())
			# A case-sensitive filesystem lists the expected file beside this one, which is then stale.
			if target is not None and target.rsplit("/", 1)[-1] not in names:
				renames.append((os.path.join(current, name), os.path.join(folder, *target.split("/"))))
			else:
				stale.append(os.path.join(current, name))

	for source, target in renames:
		print(f"  {'Would rename' if dry_run else 'Renamed'}: {source} -> {target}")
		if not dry_run:
			os.rename(source, target)

	for path in stale:
		print(f"  {'Would delete' if dry_run else 'Deleted'}: {path}")
		if not dry_run:
			os.remove(path)

	if not dry_run:
		for current, _, _ in os.walk(folder, topdown=False):
			if current != folder and not os.listdir(current):
				os.rmdir(current)
	return len(stale)


def write_dataset(gamedata_dir: str, version: GameVersion, dataset: Dataset, dry_run: bool) -> None:
	channel_dir = os.path.join(gamedata_dir, version.channel)
	changed = 0
	for relative_path, record in dataset.files.items():
		path = os.path.join(channel_dir, *relative_path.split("/"))
		if write_text_if_changed(path, pretty_json(record), dry_run):
			changed += 1

	prefix = f"{dataset.name}/"
	expected = {
		relative_path[len(prefix):] for relative_path in dataset.files if relative_path.startswith(prefix)
	}
	deleted = remove_stale_files(os.path.join(channel_dir, dataset.name), expected, dry_run)

	snapshot_path = os.path.join(gamedata_dir, SNAPSHOTS_DIRNAME, version.id, f"{dataset.name}.json")
	snapshot_changed = write_text_if_changed(
		snapshot_path, minified_json({"id": version.id} | dataset.snapshot), dry_run,
	)

	verb = "would change" if dry_run else "changed"
	print(
		f"  {version.channel}/{dataset.name}: {len(dataset.files)} file(s), {changed} {verb}, "
		f"{deleted} deleted; snapshot {'' if snapshot_changed else 'un'}changed"
	)


def update_versions(gamedata_dir: str, version: GameVersion, dry_run: bool) -> None:
	"""Add or refresh this version's entry, keeping the date it was first ingested."""
	path = os.path.join(gamedata_dir, VERSIONS_FILENAME)
	entries: list[dict] = []
	if os.path.exists(path):
		with open(path, encoding="utf-8") as f:
			entries = json.load(f)

	previous = next((entry for entry in entries if entry.get("id") == version.id), {})
	entry = {
		"id": version.id,
		"channel": version.channel,
		"version": version.version,
		"build": version.build,
		"added": previous.get("added") or datetime.date.today().isoformat(),
	}
	entries = [other for other in entries if other.get("id") != version.id] + [entry]
	entries.sort(key=lambda other: (other["build"], other["id"]))

	if write_text_if_changed(path, pretty_json(entries), dry_run):
		print(f"  {'Would write' if dry_run else 'Written'}: {path}")


def write_gamedata(data_dir: str, version: GameVersion, datasets: list[Dataset], dry_run: bool) -> None:
	"""Write each dataset's channel files and snapshot, then record the version."""
	gamedata_dir = os.path.join(data_dir, GAMEDATA_DIRNAME)
	print(f"Game data {version.id} ({version.channel}):")
	for dataset in datasets:
		write_dataset(gamedata_dir, version, dataset, dry_run)
	update_versions(gamedata_dir, version, dry_run)


def report_unrecognised(unknown: Counter) -> None:
	if not unknown:
		return
	fields = ", ".join(f"{name} ({count})" for name, count in sorted(unknown.items()))
	print(f"Unrecognised parser fields (not written): {fields}")
