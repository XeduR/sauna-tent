# Output file generator. Takes aggregate data and match JSON files, writes
# dashboard-ready split JSON files: summary, players, heroes, maps, match index.

import json
import os

from pipeline.aggregate import slugify, load_matches
from pipeline.herodata import ARAM_MAP_NAMES, HERO_ROLES


def _write_json(data: dict | list, path: str, pretty: bool = False) -> None:
	"""Write data as JSON to a file, creating parent directories as needed."""
	os.makedirs(os.path.dirname(path), exist_ok=True)
	indent = 2 if pretty else None
	with open(path, "w", encoding="utf-8") as f:
		json.dump(data, f, indent=indent, ensure_ascii=False)


def _build_match_index_entry(match: dict) -> dict:
	"""Build a lightweight index entry for a match.

	Contains only the fields needed for match history list/filtering.
	"""
	roster_players = []
	for p in match.get("players", []):
		if p.get("isRoster"):
			s = p.get("stats", {})
			roster_players.append({
				"name": p.get("rosterName", p["name"]),
				"hero": p["hero"],
				"result": p["result"],
				"partySize": p.get("partySize", 1),
				"kills": s.get("kills", 0),
				"deaths": s.get("deaths", 0),
				"assists": s.get("assists", 0),
				"heroDamage": s.get("heroDamage", 0),
				"siegeDamage": s.get("siegeDamage", 0),
				"healing": s.get("healing", 0),
				"selfHealing": s.get("selfHealing", 0),
				"damageTaken": s.get("damageTaken", 0),
				"xpContribution": s.get("xpContribution", 0),
				"mercCaptures": s.get("mercCaptures", 0),
				"timeSpentDead": s.get("timeSpentDead", 0),
			})

	# All 10 players as hero/team pairs for team comp display
	teams = {0: [], 1: []}
	for p in match.get("players", []):
		team_id = p["team"]
		teams.setdefault(team_id, []).append({
			"hero": p["hero"],
			"name": p["name"],
			"isRoster": p.get("isRoster", False),
		})

	# Determine match result from roster perspective (first roster player's result)
	result = "unknown"
	roster_team_id = None
	if roster_players:
		result = roster_players[0]["result"]

	# Remap old mode names for backward compatibility with existing match files
	raw_mode = match.get("gameMode", "Unknown")
	if raw_mode == "CustomDraft":
		raw_mode = "Custom"

	# Determine roster team ID (team with roster players) for meta stats
	for p in match.get("players", []):
		if p.get("isRoster"):
			roster_team_id = p["team"]
			break

	# Team side: team 0 = left, team 1 = right in HotS
	roster_side = None
	if roster_team_id is not None:
		roster_side = "left" if roster_team_id == 0 else "right"

	# First blood from roster perspective
	first_blood = match.get("firstBloodTeam")
	roster_got_first_blood = None
	if first_blood is not None and roster_team_id is not None:
		roster_got_first_blood = first_blood == roster_team_id

	entry = {
		"matchId": match["matchId"],
		"timestamp": match["timestamp"],
		"map": match["map"],
		"gameMode": raw_mode,
		"durationSeconds": match["durationSeconds"],
		"result": result,
		"rosterPlayers": roster_players,
		"teams": teams,
	}

	# Only include meta fields when data is available (backward compat with old match files)
	if roster_side is not None:
		entry["rosterSide"] = roster_side
	if roster_got_first_blood is not None:
		entry["rosterFirstBlood"] = roster_got_first_blood

	# Level lead from roster perspective
	first_to_level = match.get("firstToLevel")
	if first_to_level and roster_team_id is not None:
		roster_ftl = {}
		for level, team_id in first_to_level.items():
			roster_ftl[level] = team_id == roster_team_id
		entry["rosterFirstToLevel"] = roster_ftl

	# First boss/merc from roster perspective
	first_boss = match.get("firstBossTeam")
	if first_boss is not None and roster_team_id is not None:
		entry["rosterFirstBoss"] = first_boss == roster_team_id

	first_merc = match.get("firstMercTeam")
	if first_merc is not None and roster_team_id is not None:
		entry["rosterFirstMerc"] = first_merc == roster_team_id

	# Chat toxicity classification for the roster team
	# Examines all players on the roster's team (not just roster members)
	if roster_team_id is not None:
		had_team_chat = False
		has_toxic_roster = False
		has_toxic_other = False
		for p in match.get("players", []):
			if p["team"] != roster_team_id:
				continue
			s = p.get("stats", {})
			if s.get("chatMessagesTeam", 0) > 0:
				had_team_chat = True
			if s.get("chatToxicMessages", 0) > 0:
				if p.get("isRoster"):
					has_toxic_roster = True
				else:
					has_toxic_other = True

		entry["hadTeamChat"] = had_team_chat
		if not had_team_chat:
			entry["chatToxicity"] = "none"
		elif has_toxic_roster and has_toxic_other:
			entry["chatToxicity"] = "toxic_mixed"
		elif has_toxic_roster:
			entry["chatToxicity"] = "toxic_roster"
		elif has_toxic_other:
			entry["chatToxicity"] = "toxic_other"
		else:
			entry["chatToxicity"] = "clean"

	return entry


def write_output(
	aggregates: dict,
	output_dir: str,
	config: dict,
	pretty: bool = False,
) -> dict:
	"""Write all dashboard JSON files from aggregate data.

	Args:
		aggregates: Output from aggregate_all() with players/heroes/maps/summary keys.
		output_dir: Root output directory (e.g. docs/data/).
		config: Full pipeline.json config (team name + roster list).
		pretty: Pretty-print JSON files.

	Returns:
		Dict with counts of files written per category.
	"""
	counts = {"summary": 0, "roster": 0, "players": 0, "heroes": 0, "maps": 0, "matchIndex": 0, "hallOfFame": 0}

	# summary.json
	summary = aggregates["summary"]
	summary["aramMaps"] = sorted(ARAM_MAP_NAMES)
	summary["heroRoles"] = HERO_ROLES

	# All heroes with basic stats and roles for the heroes main page
	all_heroes = []
	for hero_name, data in sorted(aggregates["heroes"].items()):
		overall = data["overall"]
		all_heroes.append({
			"name": hero_name,
			"slug": data["slug"],
			"role": HERO_ROLES.get(hero_name, "Unknown"),
			"games": overall["games"],
			"wins": overall["wins"],
			"winrate": overall.get("winrate", 0),
		})
	summary["allHeroes"] = all_heroes

	# All maps with basic stats for the maps main page
	all_maps = []
	for map_name, data in sorted(aggregates["maps"].items()):
		overall = data["overall"]
		all_maps.append({
			"name": map_name,
			"slug": data["slug"],
			"games": overall["games"],
			"wins": overall["wins"],
			"winrate": overall.get("winrate", 0),
		})
	summary["allMaps"] = all_maps

	_write_json(summary, os.path.join(output_dir, "summary.json"), pretty)
	counts["summary"] = 1

	# hall-of-fame.json
	if "hallOfFame" in aggregates:
		_write_json(aggregates["hallOfFame"], os.path.join(output_dir, "hall-of-fame.json"), pretty)
		counts["hallOfFame"] = 1

	# roster.json - player list with slugs for frontend navigation
	roster = config["roster"]
	team_name = config.get("team", "Unknown")
	roster_data = {
		"team": team_name,
		"players": [
			{"name": entry["name"], "slug": slugify(entry["name"])}
			for entry in roster
		],
	}
	_write_json(roster_data, os.path.join(output_dir, "roster.json"), pretty)
	counts["roster"] = 1

	# players/{name}.json - keyed by roster name (already URL-safe lowercase names)
	players_dir = os.path.join(output_dir, "players")
	for name, data in aggregates["players"].items():
		slug = slugify(name)
		player_data = {
			"name": name,
			"slug": slug,
			**data,
		}
		_write_json(player_data, os.path.join(players_dir, f"{slug}.json"), pretty)
		counts["players"] += 1

	# heroes/{heroSlug}.json
	heroes_dir = os.path.join(output_dir, "heroes")
	for hero_name, data in aggregates["heroes"].items():
		slug = data["slug"]
		hero_data = {
			"name": hero_name,
			**data,
		}
		_write_json(hero_data, os.path.join(heroes_dir, f"{slug}.json"), pretty)
		counts["heroes"] += 1

	# maps/{mapSlug}.json
	maps_dir = os.path.join(output_dir, "maps")
	for map_name, data in aggregates["maps"].items():
		slug = data["slug"]
		map_data = {
			"name": map_name,
			**data,
		}
		_write_json(map_data, os.path.join(maps_dir, f"{slug}.json"), pretty)
		counts["maps"] += 1

	# matches/index.json - lightweight match list from existing match files
	matches_dir = os.path.join(output_dir, "matches")
	matches = load_matches(matches_dir)
	index_entries = [
		_build_match_index_entry(m) for m in matches
		if m.get("gameMode") != "CustomStandard"
	]
	# Sort newest first for the match history view
	index_entries.sort(key=lambda e: e["timestamp"], reverse=True)
	_write_json(index_entries, os.path.join(matches_dir, "index.json"), pretty)
	counts["matchIndex"] = 1

	return counts
