# Data aggregation module. Reads match JSON files and computes per-player,
# per-hero, and per-map aggregate statistics for roster players.

import heapq
import itertools
import json
import os
from collections import defaultdict

from pipeline.herodata import FEMALE_HEROES

# Number of talent tiers in HotS (levels 1, 4, 7, 10, 13, 16, 20)
_NUM_TALENT_TIERS = 7

# Replay data sometimes contains UINT32 sentinel values (~4.295B) for stats
# like damageSoaked and timeSpentDead. No legitimate single-game stat can
# reach this range, so values above this threshold are treated as garbage.
_SENTINEL_THRESHOLD = 4_000_000_000


# Stats fields that should be summed across matches
_SUM_STATS = [
	"kills", "deaths", "assists", "takedowns",
	"heroDamage", "siegeDamage", "structureDamage",
	"healing", "selfHealing", "damageTaken",
	"xpContribution", "timeSpentDead", "mercCaptures",
	"creepDamage", "summonDamage", "timeCCdEnemyHeroes",
	"damageSoaked", "protectionGiven",
	"teamfightHeroDamage", "teamfightDamageTaken", "teamfightHealing",
	"physicalDamage", "spellDamage",
	"minionKills", "regenGlobes",
	"hasAward", "awardMVP", "awardMapSpecific", "awardInternal",
	"chatMessages", "pings",
	"disconnects", "disconnectedAtEnd",
	"votesReceived", "votesGiven",
	"deathsByMinions", "deathsByMercs", "deathsByStructures", "deathsByMonsters",
	"chatMessagesAll", "chatMessagesTeam",
	"timeOnFire",
]


def _new_stat_accumulator() -> dict:
	"""Create a fresh stats accumulator with zeroed sums and counters."""
	acc = {
		"games": 0, "wins": 0, "losses": 0, "totalDurationSeconds": 0.0,
		"durationMin": None, "durationMax": None, "lastPlayed": None,
	}
	for field in _SUM_STATS:
		acc[field] = 0
	return acc


def _accumulate_stats(
	acc: dict, player: dict, duration: float, result: str,
	timestamp: str | None = None,
) -> None:
	"""Add one game's stats into an accumulator."""
	acc["games"] += 1
	if result == "win":
		acc["wins"] += 1
	else:
		acc["losses"] += 1
	acc["totalDurationSeconds"] += duration

	if acc["durationMin"] is None or duration < acc["durationMin"]:
		acc["durationMin"] = duration
	if acc["durationMax"] is None or duration > acc["durationMax"]:
		acc["durationMax"] = duration

	if timestamp and (acc["lastPlayed"] is None or timestamp > acc["lastPlayed"]):
		acc["lastPlayed"] = timestamp

	stats = player.get("stats", {})
	for field in _SUM_STATS:
		val = stats.get(field, 0)
		if val < _SENTINEL_THRESHOLD:
			acc[field] += val


def _finalize_stats(acc: dict) -> dict:
	"""Compute averages and rates from accumulated totals."""
	games = acc["games"]
	if games == 0:
		return acc

	acc["winrate"] = round(acc["wins"] / games, 4)

	# Per-game averages for key stats
	avg_fields = [
		"kills", "deaths", "assists", "heroDamage", "siegeDamage",
		"healing", "selfHealing", "damageTaken",
		"xpContribution", "mercCaptures", "timeSpentDead",
	]
	acc["averages"] = {}
	for field in avg_fields:
		acc["averages"][field] = round(acc[field] / games, 1)

	# KDA across all games (not average of per-game KDA)
	total_deaths = max(acc["deaths"], 1)
	acc["averages"]["kda"] = round(
		(acc["kills"] + acc["assists"]) / total_deaths, 2
	)

	acc["averageDurationSeconds"] = round(acc["totalDurationSeconds"] / games, 1)
	return acc


def slugify(name: str) -> str:
	"""Convert a display name to a URL-safe slug."""
	return (
		name.lower()
		.replace(" ", "-")
		.replace("'", "")
		.replace(".", "")
		.replace("(", "")
		.replace(")", "")
	)


def _new_build_accumulator() -> dict:
	"""Create a fresh build accumulator for a hero."""
	return {
		"builds": defaultdict(lambda: {"games": 0, "wins": 0}),
		"tierPicks": [defaultdict(lambda: {"games": 0, "wins": 0}) for _ in range(_NUM_TALENT_TIERS)],
	}


def _build_key(talent_choices: list) -> str | None:
	"""Convert talent choices to a build key string.

	Returns None if all choices are zero/None (no talent data).
	Only includes tiers that were actually picked (non-zero).
	"""
	if not talent_choices:
		return None
	# Filter out unpicked tiers (0 or None) to determine if any talents were chosen
	picked = [c for c in talent_choices if c and c > 0]
	if not picked:
		return None
	# Normalize: pad to 7 tiers, use 0 for unpicked
	normalized = []
	for i in range(_NUM_TALENT_TIERS):
		val = talent_choices[i] if i < len(talent_choices) else 0
		normalized.append(val if val else 0)
	return ",".join(str(v) for v in normalized)


def _accumulate_build(acc: dict, talent_choices: list, result: str) -> None:
	"""Record a talent build into the build accumulator."""
	key = _build_key(talent_choices)
	if key is None:
		return

	is_win = result == "win"

	# Full build tracking
	acc["builds"][key]["games"] += 1
	if is_win:
		acc["builds"][key]["wins"] += 1

	# Per-tier pick rates
	for i in range(_NUM_TALENT_TIERS):
		choice = talent_choices[i] if i < len(talent_choices) else 0
		if choice and choice > 0:
			acc["tierPicks"][i][choice]["games"] += 1
			if is_win:
				acc["tierPicks"][i][choice]["wins"] += 1


def _finalize_builds(acc: dict) -> dict:
	"""Finalize build data into output format."""
	# Sort builds by frequency descending
	builds_out = []
	for key, data in sorted(acc["builds"].items(), key=lambda x: -x[1]["games"]):
		choices = [int(v) for v in key.split(",")]
		games = data["games"]
		builds_out.append({
			"talents": choices,
			"games": games,
			"wins": data["wins"],
			"losses": games - data["wins"],
			"winrate": round(data["wins"] / games, 4),
		})

	# Per-tier pick rates
	tier_picks_out = []
	for tier_idx in range(_NUM_TALENT_TIERS):
		tier_data = acc["tierPicks"][tier_idx]
		total_tier_games = sum(d["games"] for d in tier_data.values())
		picks = []
		for choice, data in sorted(tier_data.items()):
			games = data["games"]
			picks.append({
				"choice": choice,
				"games": games,
				"wins": data["wins"],
				"losses": games - data["wins"],
				"winrate": round(data["wins"] / games, 4),
				"pickrate": round(games / max(total_tier_games, 1), 4),
			})
		tier_picks_out.append(picks)

	return {
		"builds": builds_out,
		"tierPicks": tier_picks_out,
	}


# Hall of fame: single-game stat categories to track top records for
_HOF_STAT_CATEGORIES = [
	("heroDamage", "Most Hero Damage"),
	("siegeDamage", "Most Siege Damage"),
	("healing", "Most Healing"),
	("damageSoaked", "Most Damage Taken"),
	("kills", "Most Kills"),
	("xpContribution", "Most XP Contribution"),
	("deaths", "Most Deaths"),
	("timeSpentDead", "Longest Time Dead"),
	("chatMessages", "Most Messages (Single Game)"),
	("pings", "Most Pings (Single Game)"),
	("disconnects", "Most Disconnects (Single Game)"),
	("votesReceived", "Most Votes (Single Game)"),
	("deathsByMinions", "Most Deaths to Minions (Single Game)"),
	("deathsByMercs", "Most Deaths to Mercs (Single Game)"),
	("deathsByStructures", "Most Deaths to Structures (Single Game)"),
	("deathsByMonsters", "Most Deaths to Monsters (Single Game)"),
]

# Single-game stat categories tracked with inverted heaps (lowest value wins)
_HOF_STAT_CATEGORIES_MIN = [
	("damageSoaked", "damageSoakedMin", "Least Damage Taken"),
]

# Heroes excluded from specific stat categories (value is garbage/meaningless)
_HOF_HERO_EXCLUSIONS = {
	"damageSoaked": {"Gall"},
	"damageSoakedMin": {"Gall", "Abathur"},
	"deaths": {"Abathur", "Gall"},
}

# Max records to keep per stat per mode (frontend filters by date from these)
_HOF_RECORDS_PER_CATEGORY = 20

# Cumulative player stats to track for hall of fame (summed across all games).
# These stat keys are written to each player's hof dict in the match index (via
# HOF_INDEX_STAT_KEYS) so the frontend can re-aggregate from filtered matches.
# Any changes here must be reflected in the frontend's cumulative card rendering
# (halloffame.js).
_HOF_CUMULATIVE_CATEGORIES = [
	("hasAward", "Most End-of-Match Awards"),
	("awardMVP", "Most MVP Awards"),
	("awardMapSpecific", "Most Map-Specific Awards"),
	("awardInternal", "Most Internal Awards"),
	("chatMessages", "Total Messages"),
	("pings", "Total Pings"),
	("disconnects", "Total Disconnects"),
	("disconnectedAtEnd", "Rage Quits"),
	("votesGiven", "Total Votes Given"),
	("votesReceived", "Total Votes Received"),
	("deathsByMinions", "Total Deaths to Minions"),
	("deathsByMercs", "Total Deaths to Mercs"),
	("deathsByStructures", "Total Deaths to Structures"),
	("deathsByMonsters", "Total Deaths to Monsters"),
	("chatMessagesAll", "Total All Chat"),
	("chatMessagesTeam", "Total Team Chat"),
	("chatToxicMessages", "Total Toxic Messages"),
	("chatGamesClean", "Conversationalist Games"),
	("chatGamesToxic", "Toxic Games"),
	("chatGlhf", "Sportsmanlike Greetings"),
	("chatOffensiveGg", "Offensive GG"),
	("timeOnFire", "Total Time on Fire"),
	("regenGlobes", "A Game of Globes"),
]

# Derived cumulative categories with non-standard accumulation logic
# (flag-based or hero-attribute-based, not simple stat sums)
_HOF_DERIVED_CUMULATIVE = [
	("hasMultikill", "Multi-kill Percentage"),
	("femaleHero", "Gender Equality"),
]

# Stat keys written to match index rosterPlayers so the frontend can
# re-aggregate cumulative HoF stats from date-filtered matches.
# Derived categories (hasMultikill, femaleHero) are computed in output.py's _build_match_index_entry.
HOF_INDEX_STAT_KEYS: list[str] = [key for key, _ in _HOF_CUMULATIVE_CATEGORIES]

# Sentinel threshold re-exported for output.py to skip garbage stat values
HOF_SENTINEL_THRESHOLD: int = _SENTINEL_THRESHOLD


def _new_hof_tracker() -> dict:
	"""Create a hall of fame record tracker with min-heaps per stat per mode."""
	modes = ["Overall", "StormLeague", "ARAM", "Custom"]
	tracker = {"stats": {}, "stats_min": {}, "games": {}, "cumulative": {}}
	for stat_key, _ in _HOF_STAT_CATEGORIES:
		tracker["stats"][stat_key] = {mode: [] for mode in modes}
	for _, out_key, _ in _HOF_STAT_CATEGORIES_MIN:
		tracker["stats_min"][out_key] = {mode: [] for mode in modes}
	for length_key in ["shortest", "longest", "shortestWon", "shortestLost", "longestWon", "longestLost"]:
		tracker["games"][length_key] = {mode: [] for mode in modes}
	for stat_key, _ in _HOF_CUMULATIVE_CATEGORIES + _HOF_DERIVED_CUMULATIVE:
		tracker["cumulative"][stat_key] = {
			mode: defaultdict(lambda: {"value": 0, "games": 0})
			for mode in modes
		}
	return tracker


_hof_counter = itertools.count()


def _push_hof_record(heap: list, value: float, entry: dict, max_size: int, invert: bool = False) -> None:
	"""Push a record into a bounded min-heap.

	For 'largest value wins' (default): heap stores (value, counter, entry),
	smallest value gets evicted when full.
	For 'smallest value wins' (invert=True): heap stores (-value, counter, entry).
	Counter breaks ties so dicts are never compared.
	"""
	counter_val = next(_hof_counter)
	sort_val = -value if invert else value
	if len(heap) < max_size:
		heapq.heappush(heap, (sort_val, counter_val, entry))
	elif sort_val > heap[0][0]:
		heapq.heapreplace(heap, (sort_val, counter_val, entry))


def _finalize_hof(tracker: dict) -> dict:
	"""Convert heap-based tracker into sorted output."""
	out = {"stats": {}, "games": {}, "cumulative": {}}

	for stat_key, label in _HOF_STAT_CATEGORIES:
		out["stats"][stat_key] = {"label": label}
		for mode, heap in tracker["stats"][stat_key].items():
			# Sort descending by value (tuple: sort_val, counter, entry)
			records = sorted(heap, key=lambda x: -x[0])
			out["stats"][stat_key][mode] = [r[2] for r in records]

	# Min records: stored with inverted values, sort ascending by original value
	for _, out_key, label in _HOF_STAT_CATEGORIES_MIN:
		out["stats"][out_key] = {"label": label}
		for mode, heap in tracker["stats_min"][out_key].items():
			records = sorted(heap, key=lambda x: x[0], reverse=True)
			out["stats"][out_key][mode] = [r[2] for r in records]

	for length_key in ["shortest", "longest", "shortestWon", "shortestLost", "longestWon", "longestLost"]:
		out["games"][length_key] = {}
		for mode, heap in tracker["games"][length_key].items():
			if length_key.startswith("shortest"):
				records = sorted(heap, key=lambda x: x[0], reverse=True)
			else:
				records = sorted(heap, key=lambda x: -x[0])
			out["games"][length_key][mode] = [r[2] for r in records]

	# Cumulative player records (standard sums and derived flags)
	for stat_key, label in _HOF_CUMULATIVE_CATEGORIES + _HOF_DERIVED_CUMULATIVE:
		out["cumulative"][stat_key] = {"label": label}
		for mode, player_data in tracker["cumulative"][stat_key].items():
			records = []
			for name, data in player_data.items():
				if data["value"] > 0:
					records.append({
						"playerName": name,
						"value": data["value"],
						"games": data["games"],
					})
			records.sort(key=lambda x: (-x["value"], -x["games"]))
			out["cumulative"][stat_key][mode] = records[:20]

	return out


def load_matches(matches_dir: str) -> list[dict]:
	"""Load all match JSON files from a directory."""
	matches = []
	if not os.path.isdir(matches_dir):
		return matches

	for filename in os.listdir(matches_dir):
		if not filename.endswith(".json") or filename == "index.json":
			continue
		filepath = os.path.join(matches_dir, filename)
		with open(filepath, "r", encoding="utf-8") as f:
			matches.append(json.load(f))

	# Sort by timestamp (oldest first) for consistent processing
	matches.sort(key=lambda m: m.get("timestamp", ""))
	return matches


def aggregate_all(
	matches: list[dict],
	roster: list[dict],
	cutoff_date: str | None = None,
	alts: list[dict] | None = None,
) -> dict:
	"""Compute all aggregates from match data.

	Args:
		matches: List of parsed match dicts (from match JSON files).
		roster: Roster list from pipeline.json config.
		cutoff_date: ISO date string (e.g. "2017-01-01"). Matches before this are excluded.
		alts: Alt player list from pipeline.json config (loose Sauna Tent members).

	Returns:
		Dict with keys: players, alts, heroes, maps, summary, hallOfFame.

	Baseline stats (players/heroes/maps/summary/HoF) are computed from matches with
	NO alt players present, matching the default "No alts" filter state. Alt player
	stats are computed separately from the full match set.
	"""
	alts = alts or []
	if cutoff_date:
		before_count = len(matches)
		matches = [m for m in matches if m.get("timestamp", "") >= cutoff_date]
		excluded = before_count - len(matches)
		if excluded:
			print(f"  Cutoff {cutoff_date}: excluded {excluded} matches, {len(matches)} remaining")

	# Baseline: exclude matches that contain any alt player. Matches the default
	# "No alts" filter state that roster pre-computed data is built from.
	baseline_matches = [
		m for m in matches
		if not any(p.get("isAlt") for p in m["players"])
	]
	alt_excluded = len(matches) - len(baseline_matches)
	if alt_excluded:
		print(f"  Alt games: {alt_excluded} matches excluded from baseline, {len(baseline_matches)} remaining")

	roster_names = {m["name"] for m in roster}
	alt_names = {m["name"] for m in alts}

	# Accumulators
	# player_stats[rosterName] -> overall stats
	player_stats = {name: _new_stat_accumulator() for name in roster_names}
	# player_hero_stats[rosterName][hero] -> stats per hero per player
	player_hero_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	# player_map_stats[rosterName][map] -> stats per map per player
	player_map_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	# hero_stats[hero] -> overall hero stats across all roster players
	hero_stats = defaultdict(_new_stat_accumulator)
	# hero_player_stats[hero][rosterName] -> per-player stats for each hero
	hero_player_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	# map_stats[map] -> overall map stats across all roster players
	map_stats = defaultdict(_new_stat_accumulator)
	# map_hero_stats[map][hero] -> per-hero stats on each map
	map_hero_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	# map_player_stats[map][rosterName] -> per-player stats on each map
	map_player_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	# game_mode_stats[mode] -> stats by game mode
	game_mode_stats = defaultdict(_new_stat_accumulator)
	# player_party_stats[rosterName][partySize] -> stats by party size per player
	player_party_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	# party_size_stats[partySize] -> overall stats by party size
	party_size_stats = defaultdict(_new_stat_accumulator)
	# hero_builds[hero] -> build accumulator across all roster players
	hero_builds = defaultdict(_new_build_accumulator)
	# hero_player_builds[hero][rosterName] -> per-player build accumulator
	hero_player_builds = defaultdict(lambda: defaultdict(_new_build_accumulator))
	# player_hero_builds[rosterName][hero] -> per-player-hero build accumulator
	player_hero_builds = defaultdict(lambda: defaultdict(_new_build_accumulator))
	# player_hero_party_stats[rosterName][hero][partySize] -> stats per hero per party size
	player_hero_party_stats = defaultdict(lambda: defaultdict(lambda: defaultdict(_new_stat_accumulator)))

	# Hall of fame record tracker
	hof = _new_hof_tracker()

	# Meta stat trackers
	meta_side = {"left": {"games": 0, "wins": 0}, "right": {"games": 0, "wins": 0}}
	meta_first_blood = {"got": {"games": 0, "wins": 0}, "gave": {"games": 0, "wins": 0}}
	meta_first_boss = {"got": {"games": 0, "wins": 0}, "gave": {"games": 0, "wins": 0}}
	meta_first_merc = {"got": {"games": 0, "wins": 0}, "gave": {"games": 0, "wins": 0}}
	# Level lead: per talent tier, track "got" (reached first) and "gave" (opponent reached first)
	_level_tiers = ["4", "7", "10", "13", "16", "20"]
	meta_level_lead = {t: {"got": {"games": 0, "wins": 0}, "gave": {"games": 0, "wins": 0}} for t in _level_tiers}

	total_matches = 0
	total_roster_appearances = 0
	match_wins = 0

	for match in baseline_matches:
		map_name = match["map"]
		duration = match["durationSeconds"]
		timestamp = match.get("timestamp")
		game_mode = match.get("gameMode", "Unknown")

		if game_mode == "CustomStandard":
			continue
		if game_mode == "CustomDraft":
			game_mode = "Custom"

		total_matches += 1

		# Pre-compute party info: group roster players by team
		roster_by_team = defaultdict(list)
		for player in match["players"]:
			if player.get("isRoster") and player.get("rosterName") in roster_names:
				roster_by_team[player["team"]].append(player["rosterName"])

		# Match-level win/loss: use the result of the team with more roster players
		match_result_for_meta = None
		primary_team = None
		if roster_by_team:
			primary_team = max(roster_by_team, key=lambda t: len(roster_by_team[t]))
			for player in match["players"]:
				if player.get("isRoster") and player["team"] == primary_team:
					match_result_for_meta = player["result"]
					if player["result"] == "win":
						match_wins += 1
					break

		# Meta stats: team side and first blood
		if primary_team is not None and match_result_for_meta:
			side = "left" if primary_team == 0 else "right"
			meta_side[side]["games"] += 1
			if match_result_for_meta == "win":
				meta_side[side]["wins"] += 1

			fb_team = match.get("firstBloodTeam")
			if fb_team is not None:
				got_fb = fb_team == primary_team
				fb_key = "got" if got_fb else "gave"
				meta_first_blood[fb_key]["games"] += 1
				if match_result_for_meta == "win":
					meta_first_blood[fb_key]["wins"] += 1

			boss_team = match.get("firstBossTeam")
			if boss_team is not None:
				b_key = "got" if boss_team == primary_team else "gave"
				meta_first_boss[b_key]["games"] += 1
				if match_result_for_meta == "win":
					meta_first_boss[b_key]["wins"] += 1

			merc_team = match.get("firstMercTeam")
			if merc_team is not None:
				m_key = "got" if merc_team == primary_team else "gave"
				meta_first_merc[m_key]["games"] += 1
				if match_result_for_meta == "win":
					meta_first_merc[m_key]["wins"] += 1

			ftl = match.get("firstToLevel") or {}
			for tier in _level_tiers:
				if tier in ftl:
					ll_key = "got" if ftl[tier] == primary_team else "gave"
					meta_level_lead[tier][ll_key]["games"] += 1
					if match_result_for_meta == "win":
						meta_level_lead[tier][ll_key]["wins"] += 1

		for player in match["players"]:
			if not player.get("isRoster"):
				continue

			roster_name = player.get("rosterName")
			if not roster_name or roster_name not in roster_names:
				continue

			hero = player["hero"]
			result = player["result"]
			total_roster_appearances += 1

			# Party size = number of roster members on same team
			party_size = len(roster_by_team[player["team"]])

			# Player overall
			_accumulate_stats(player_stats[roster_name], player, duration, result, timestamp)

			# Player x Hero
			_accumulate_stats(
				player_hero_stats[roster_name][hero], player, duration, result, timestamp
			)

			# Player x Map
			_accumulate_stats(
				player_map_stats[roster_name][map_name], player, duration, result, timestamp
			)

			# Hero overall (across all roster players)
			_accumulate_stats(hero_stats[hero], player, duration, result, timestamp)

			# Hero x Player
			_accumulate_stats(
				hero_player_stats[hero][roster_name], player, duration, result, timestamp
			)

			# Map overall
			_accumulate_stats(map_stats[map_name], player, duration, result, timestamp)

			# Map x Hero
			_accumulate_stats(
				map_hero_stats[map_name][hero], player, duration, result, timestamp
			)

			# Map x Player
			_accumulate_stats(
				map_player_stats[map_name][roster_name], player, duration, result, timestamp
			)

			# Game mode
			_accumulate_stats(game_mode_stats[game_mode], player, duration, result, timestamp)

			# Party size
			_accumulate_stats(player_party_stats[roster_name][party_size], player, duration, result, timestamp)
			_accumulate_stats(party_size_stats[party_size], player, duration, result, timestamp)

			# Player x Hero x Party size
			_accumulate_stats(
				player_hero_party_stats[roster_name][hero][party_size], player, duration, result, timestamp
			)

			# Talent builds
			talent_choices = player.get("talentChoices", [])
			_accumulate_build(hero_builds[hero], talent_choices, result)
			_accumulate_build(hero_player_builds[hero][roster_name], talent_choices, result)
			_accumulate_build(player_hero_builds[roster_name][hero], talent_choices, result)

			# Hall of fame: single-game stat records
			stats = player.get("stats", {})
			hof_entry = {
				"value": 0,
				"playerName": roster_name,
				"hero": hero,
				"map": map_name,
				"gameMode": game_mode,
				"matchId": match.get("matchId", ""),
				"timestamp": match.get("timestamp", ""),
				"durationSeconds": duration,
			}
			for stat_key, _ in _HOF_STAT_CATEGORIES:
				excluded = _HOF_HERO_EXCLUSIONS.get(stat_key, set())
				if hero in excluded:
					continue
				val = stats.get(stat_key, 0)
				if val >= _SENTINEL_THRESHOLD:
					continue
				entry = {**hof_entry, "value": val}
				_push_hof_record(hof["stats"][stat_key]["Overall"], val, entry, _HOF_RECORDS_PER_CATEGORY)
				if game_mode in hof["stats"][stat_key]:
					_push_hof_record(hof["stats"][stat_key][game_mode], val, entry, _HOF_RECORDS_PER_CATEGORY)

			# Hall of fame: single-game min records (lowest value wins)
			for src_key, out_key, _ in _HOF_STAT_CATEGORIES_MIN:
				excluded = _HOF_HERO_EXCLUSIONS.get(out_key, set())
				if hero in excluded:
					continue
				val = stats.get(src_key, 0)
				if val <= 0:
					continue
				entry = {**hof_entry, "value": val}
				_push_hof_record(hof["stats_min"][out_key]["Overall"], val, entry, _HOF_RECORDS_PER_CATEGORY, invert=True)
				if game_mode in hof["stats_min"][out_key]:
					_push_hof_record(hof["stats_min"][out_key][game_mode], val, entry, _HOF_RECORDS_PER_CATEGORY, invert=True)

			# Hall of fame: cumulative player records
			for stat_key, _ in _HOF_CUMULATIVE_CATEGORIES:
				val = stats.get(stat_key, 0)
				if val >= _SENTINEL_THRESHOLD:
					continue
				hof["cumulative"][stat_key]["Overall"][roster_name]["value"] += val
				hof["cumulative"][stat_key]["Overall"][roster_name]["games"] += 1
				if game_mode in hof["cumulative"][stat_key]:
					hof["cumulative"][stat_key][game_mode][roster_name]["value"] += val
					hof["cumulative"][stat_key][game_mode][roster_name]["games"] += 1

			# Hall of fame: derived cumulative records (flag-based)
			mk_val = 1 if stats.get("multikill", 0) > 0 else 0
			hof["cumulative"]["hasMultikill"]["Overall"][roster_name]["value"] += mk_val
			hof["cumulative"]["hasMultikill"]["Overall"][roster_name]["games"] += 1
			if game_mode in hof["cumulative"]["hasMultikill"]:
				hof["cumulative"]["hasMultikill"][game_mode][roster_name]["value"] += mk_val
				hof["cumulative"]["hasMultikill"][game_mode][roster_name]["games"] += 1

			fem_val = 1 if hero in FEMALE_HEROES else 0
			hof["cumulative"]["femaleHero"]["Overall"][roster_name]["value"] += fem_val
			hof["cumulative"]["femaleHero"]["Overall"][roster_name]["games"] += 1
			if game_mode in hof["cumulative"]["femaleHero"]:
				hof["cumulative"]["femaleHero"][game_mode][roster_name]["value"] += fem_val
				hof["cumulative"]["femaleHero"][game_mode][roster_name]["games"] += 1

		# Hall of fame: game duration records (once per match, not per player)
		# Determine match result from roster perspective
		match_result = "unknown"
		if roster_by_team:
			primary_team = max(roster_by_team, key=lambda t: len(roster_by_team[t]))
			for p in match["players"]:
				if p.get("isRoster") and p["team"] == primary_team:
					match_result = p["result"]
					break
		game_entry = {
			"map": map_name,
			"gameMode": game_mode,
			"matchId": match.get("matchId", ""),
			"timestamp": match.get("timestamp", ""),
			"durationSeconds": duration,
			"result": match_result,
		}
		_push_hof_record(hof["games"]["longest"]["Overall"], duration, game_entry, _HOF_RECORDS_PER_CATEGORY)
		_push_hof_record(hof["games"]["shortest"]["Overall"], duration, game_entry, _HOF_RECORDS_PER_CATEGORY, invert=True)
		if game_mode in hof["games"]["longest"]:
			_push_hof_record(hof["games"]["longest"][game_mode], duration, game_entry, _HOF_RECORDS_PER_CATEGORY)
			_push_hof_record(hof["games"]["shortest"][game_mode], duration, game_entry, _HOF_RECORDS_PER_CATEGORY, invert=True)

		# Result-specific game duration records
		if match_result == "win":
			result_keys = ("shortestWon", "longestWon")
		elif match_result == "loss":
			result_keys = ("shortestLost", "longestLost")
		else:
			result_keys = None
		if result_keys:
			short_key, long_key = result_keys
			_push_hof_record(hof["games"][long_key]["Overall"], duration, game_entry, _HOF_RECORDS_PER_CATEGORY)
			_push_hof_record(hof["games"][short_key]["Overall"], duration, game_entry, _HOF_RECORDS_PER_CATEGORY, invert=True)
			if game_mode in hof["games"][long_key]:
				_push_hof_record(hof["games"][long_key][game_mode], duration, game_entry, _HOF_RECORDS_PER_CATEGORY)
				_push_hof_record(hof["games"][short_key][game_mode], duration, game_entry, _HOF_RECORDS_PER_CATEGORY, invert=True)

	# Finalize all accumulators
	for name in player_stats:
		_finalize_stats(player_stats[name])

	for name in player_hero_stats:
		for hero in player_hero_stats[name]:
			_finalize_stats(player_hero_stats[name][hero])

	for name in player_map_stats:
		for map_name in player_map_stats[name]:
			_finalize_stats(player_map_stats[name][map_name])

	for hero in hero_stats:
		_finalize_stats(hero_stats[hero])

	for hero in hero_player_stats:
		for name in hero_player_stats[hero]:
			_finalize_stats(hero_player_stats[hero][name])

	for map_name in map_stats:
		_finalize_stats(map_stats[map_name])

	for map_name in map_hero_stats:
		for hero in map_hero_stats[map_name]:
			_finalize_stats(map_hero_stats[map_name][hero])

	for map_name in map_player_stats:
		for name in map_player_stats[map_name]:
			_finalize_stats(map_player_stats[map_name][name])

	for mode in game_mode_stats:
		_finalize_stats(game_mode_stats[mode])

	for name in player_party_stats:
		for size in player_party_stats[name]:
			_finalize_stats(player_party_stats[name][size])

	for size in party_size_stats:
		_finalize_stats(party_size_stats[size])

	for name in player_hero_party_stats:
		for hero in player_hero_party_stats[name]:
			for size in player_hero_party_stats[name][hero]:
				_finalize_stats(player_hero_party_stats[name][hero][size])

	# Build structured output

	# Players: keyed by roster name
	players_out = {}
	for name in sorted(roster_names):
		hero_breakdown = {}
		for hero, stats in sorted(player_hero_stats[name].items()):
			hero_data = dict(stats)
			# Attach per-hero build data for this player
			if hero in player_hero_builds[name]:
				hero_data["builds"] = _finalize_builds(player_hero_builds[name][hero])
			# Attach per-party-size win rates for this hero
			if hero in player_hero_party_stats[name]:
				by_party = {}
				for size in sorted(player_hero_party_stats[name][hero].keys()):
					ps = player_hero_party_stats[name][hero][size]
					by_party[str(size)] = {
						"games": ps["games"],
						"wins": ps["wins"],
						"losses": ps["losses"],
						"winrate": ps.get("winrate", 0),
						"averages": ps.get("averages", {}),
						"averageDurationSeconds": ps.get("averageDurationSeconds", 0),
					}
				hero_data["byPartySize"] = by_party
			hero_breakdown[hero] = hero_data

		map_breakdown = {}
		for map_name, stats in sorted(player_map_stats[name].items()):
			map_breakdown[map_name] = stats

		# Party stats keyed by party size (string keys for JSON compat)
		party_breakdown = {}
		for size in sorted(player_party_stats[name].keys()):
			party_breakdown[str(size)] = player_party_stats[name][size]

		players_out[name] = {
			"overall": player_stats[name],
			"heroes": hero_breakdown,
			"maps": map_breakdown,
			"partySize": party_breakdown,
		}

	# Heroes: keyed by hero name
	heroes_out = {}
	for hero in sorted(hero_stats.keys()):
		player_breakdown = {}
		for name, stats in sorted(hero_player_stats[hero].items()):
			player_data = dict(stats)
			# Attach per-player build data for this hero
			if name in hero_player_builds[hero]:
				player_data["builds"] = _finalize_builds(hero_player_builds[hero][name])
			player_breakdown[name] = player_data

		heroes_out[hero] = {
			"overall": hero_stats[hero],
			"players": player_breakdown,
			"builds": _finalize_builds(hero_builds[hero]),
			"slug": slugify(hero),
		}

	# Maps: keyed by map name
	maps_out = {}
	for map_name in sorted(map_stats.keys()):
		hero_breakdown = {}
		for hero, stats in sorted(map_hero_stats[map_name].items()):
			hero_breakdown[hero] = stats

		player_breakdown = {}
		for name, stats in sorted(map_player_stats[map_name].items()):
			player_breakdown[name] = stats

		maps_out[map_name] = {
			"overall": map_stats[map_name],
			"heroes": hero_breakdown,
			"players": player_breakdown,
			"slug": slugify(map_name),
		}

	# Summary (match-level, not player-appearance-level)
	match_losses = total_matches - match_wins
	overall_winrate = round(match_wins / max(total_matches, 1), 4)

	# Most played heroes across all roster players
	hero_play_counts = sorted(
		[(hero, s["games"]) for hero, s in hero_stats.items()],
		key=lambda x: -x[1],
	)
	most_played = [{"hero": h, "games": g} for h, g in hero_play_counts[:10]]

	# Party size stats keyed by size (string keys for JSON compat)
	party_summary = {}
	for size in sorted(party_size_stats.keys()):
		party_summary[str(size)] = party_size_stats[size]

	# Meta stats: compute winrates
	def _meta_winrate(acc):
		return {
			"games": acc["games"],
			"wins": acc["wins"],
			"losses": acc["games"] - acc["wins"],
			"winrate": round(acc["wins"] / max(acc["games"], 1), 4),
		}

	meta_stats = {"teamSide": {}, "firstBlood": {}, "firstBoss": {}, "firstMerc": {}, "levelLead": {}}
	for side in ("left", "right"):
		meta_stats["teamSide"][side] = _meta_winrate(meta_side[side])
	for fb_key in ("got", "gave"):
		meta_stats["firstBlood"][fb_key] = _meta_winrate(meta_first_blood[fb_key])
		meta_stats["firstBoss"][fb_key] = _meta_winrate(meta_first_boss[fb_key])
		meta_stats["firstMerc"][fb_key] = _meta_winrate(meta_first_merc[fb_key])
	for tier in _level_tiers:
		meta_stats["levelLead"][tier] = {
			"got": _meta_winrate(meta_level_lead[tier]["got"]),
			"gave": _meta_winrate(meta_level_lead[tier]["gave"]),
		}

	summary = {
		"totalMatches": total_matches,
		"totalRosterAppearances": total_roster_appearances,
		"totalWins": match_wins,
		"totalLosses": match_losses,
		"overallWinrate": overall_winrate,
		"mostPlayedHeroes": most_played,
		"gameModes": dict(game_mode_stats),
		"partySizes": party_summary,
		"playerSummary": {
			name: {
				"games": player_stats[name]["games"],
				"wins": player_stats[name]["wins"],
				"winrate": player_stats[name].get("winrate", 0),
			}
			for name in sorted(roster_names)
		},
		"metaStats": meta_stats,
	}

	# Alt players: aggregated from the full match set (not baseline-filtered).
	# These are the games each alt actually played, which by definition contain
	# at least themselves. Used when the "No alts" filter is toggled off.
	alts_out = _aggregate_alt_players(matches, alt_names)

	return {
		"players": players_out,
		"alts": alts_out,
		"heroes": heroes_out,
		"maps": maps_out,
		"summary": summary,
		"hallOfFame": _finalize_hof(hof),
	}


def _aggregate_alt_players(matches: list[dict], alt_names: set) -> dict:
	"""Compute per-alt player stats from matches they appeared in.

	Mirrors the roster player output shape (overall / heroes / maps / partySize)
	but without builds, HoF tracking, or meta stats.
	"""
	if not alt_names:
		return {}

	alt_stats = {name: _new_stat_accumulator() for name in alt_names}
	alt_hero_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	alt_map_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))
	alt_party_stats = defaultdict(lambda: defaultdict(_new_stat_accumulator))

	for match in matches:
		game_mode = match.get("gameMode", "Unknown")
		if game_mode == "CustomStandard":
			continue
		if game_mode == "CustomDraft":
			game_mode = "Custom"

		map_name = match["map"]
		duration = match["durationSeconds"]
		timestamp = match.get("timestamp")

		for player in match["players"]:
			if not player.get("isAlt"):
				continue
			name = player.get("altName")
			if not name or name not in alt_names:
				continue

			hero = player["hero"]
			result = player["result"]
			party_size = player.get("partySize", 1)

			_accumulate_stats(alt_stats[name], player, duration, result, timestamp)
			_accumulate_stats(alt_hero_stats[name][hero], player, duration, result, timestamp)
			_accumulate_stats(alt_map_stats[name][map_name], player, duration, result, timestamp)
			_accumulate_stats(alt_party_stats[name][party_size], player, duration, result, timestamp)

	for name in alt_stats:
		_finalize_stats(alt_stats[name])
	for name in alt_hero_stats:
		for hero in alt_hero_stats[name]:
			_finalize_stats(alt_hero_stats[name][hero])
	for name in alt_map_stats:
		for m_name in alt_map_stats[name]:
			_finalize_stats(alt_map_stats[name][m_name])
	for name in alt_party_stats:
		for size in alt_party_stats[name]:
			_finalize_stats(alt_party_stats[name][size])

	alts_out = {}
	for name in sorted(alt_names):
		hero_breakdown = {hero: stats for hero, stats in sorted(alt_hero_stats[name].items())}
		map_breakdown = {m: stats for m, stats in sorted(alt_map_stats[name].items())}
		party_breakdown = {str(size): alt_party_stats[name][size] for size in sorted(alt_party_stats[name].keys())}

		alts_out[name] = {
			"overall": alt_stats[name],
			"heroes": hero_breakdown,
			"maps": map_breakdown,
			"partySize": party_breakdown,
		}

	return alts_out
