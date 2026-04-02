# Core replay parser module. Wraps heroprotocol to extract structured data
# from a single .StormReplay file.

import re
import sys
import os
from datetime import datetime, timezone

import mpyq

# heroprotocol is not pip-installable; add it to sys.path
_HEROPROTOCOL_PATH = os.path.join(
	os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
	"tools", "heroprotocol"
)
if _HEROPROTOCOL_PATH not in sys.path:
	sys.path.insert(0, _HEROPROTOCOL_PATH)

from heroprotocol.versions import build, latest

from pipeline.herodata import HERO_NAMES, MAP_NAMES, ARAM_MAP_IDS
from pipeline.toxicity import is_toxic

# Windows FILETIME epoch offset (100-ns intervals between 1601-01-01 and 1970-01-01)
_FILETIME_EPOCH_DIFF = 116444736000000000

# Game runs at 16 loops per second
_LOOPS_PER_SECOND = 16

# Score result stats to extract, mapped to output field names
_SCORE_STATS = {
	b"SoloKill": "kills",
	b"Deaths": "deaths",
	b"Assists": "assists",
	b"HeroDamage": "heroDamage",
	b"SiegeDamage": "siegeDamage",
	b"StructureDamage": "structureDamage",
	b"Healing": "healing",
	b"SelfHealing": "selfHealing",
	b"DamageTaken": "damageTaken",
	b"ExperienceContribution": "xpContribution",
	b"TimeSpentDead": "timeSpentDead",
	b"MercCampCaptures": "mercCaptures",
	b"CreepDamage": "creepDamage",
	b"SummonDamage": "summonDamage",
	b"TimeCCdEnemyHeroes": "timeCCdEnemyHeroes",
	b"DamageSoaked": "damageSoaked",
	b"HighestKillStreak": "highestKillStreak",
	b"ProtectionGivenToAllies": "protectionGiven",
	b"TeamfightHeroDamage": "teamfightHeroDamage",
	b"TeamfightDamageTaken": "teamfightDamageTaken",
	b"TeamfightHealingDone": "teamfightHealing",
	b"MinionKills": "minionKills",
	b"RegenGlobes": "regenGlobes",
	b"Multikill": "multikill",
	b"PhysicalDamage": "physicalDamage",
	b"SpellDamage": "spellDamage",
	b"Takedowns": "takedowns",
	b"OnFireTimeOnFire": "timeOnFire",
}

# Talent tier stat names (1-indexed choice within each tier)
_TALENT_TIERS = [
	b"Tier1Talent", b"Tier2Talent", b"Tier3Talent", b"Tier4Talent",
	b"Tier5Talent", b"Tier6Talent", b"Tier7Talent",
]

# Talent tier levels where breakpoints matter for level lead tracking
_TALENT_TIER_LEVELS = frozenset({4, 7, 10, 13, 16, 20})

# JungleCampCapture camp type classification
_BOSS_CAMP_TYPE = "Boss Camp"

# Attribute IDs for talent internal codes (per-player scope, IDs 4032-4038)
_TALENT_ATTR_IDS = [4032, 4033, 4034, 4035, 4036, 4037, 4038]

# Game mode detection from global attribute scope
# 3009: matchmaking type, 4010: lobby mode
# Amm+stan can be QM or ARAM (distinguished by map after tracker parsing)
_GAME_MODE_MAP = {
	(b"Amm", b"drft"): "StormLeague",
	(b"Amm", b"stan"): "QuickMatch",
	(b"Priv", b"drft"): "Custom",
	(b"Priv", b"tour"): "Custom",
	(b"Priv", b"stan"): "CustomStandard",
}


# Death source classification for non-player kills
_MINION_UNIT_TYPES = frozenset({
	"FootmanMinion", "RangedMinion", "WizardMinion", "CatapultMinion",
})

_STRUCTURE_UNIT_TYPES = frozenset({
	"KingsCore", "VanndarStormpike", "DrekThar",
})

_DEATH_SOURCE_STAT_KEYS = {
	"minion": "deathsByMinions",
	"merc": "deathsByMercs",
	"structure": "deathsByStructures",
	"monster": "deathsByMonsters",
}


# Chat behaviour analysis: sportsmanlike greetings and offensive gg
_CHAT_NORMALIZE_RE = re.compile(r"[^a-z0-9 &]")
_GLHF_PATTERNS = frozenset({"gl", "hf", "gl hf", "gl & hf", "glhf"})
_GG_PATTERNS = frozenset({"gg", "ggs"})
_GLHF_THRESHOLD_LOOPS = 60 * _LOOPS_PER_SECOND
_GG_EARLY_BUFFER_LOOPS = 15 * _LOOPS_PER_SECOND


def _normalize_chat(text: str) -> str:
	"""Normalize chat text for pattern matching: lowercase, strip non-alnum."""
	return " ".join(_CHAT_NORMALIZE_RE.sub("", text.strip().lower()).split())


def _classify_killer_unit(unit_type: str) -> str:
	"""Classify a non-player killer unit into a death source category."""
	if unit_type in _MINION_UNIT_TYPES:
		return "minion"
	if unit_type.startswith("Merc"):
		return "merc"
	if unit_type in _STRUCTURE_UNIT_TYPES or unit_type.startswith("Town"):
		return "structure"
	return "monster"


def _decode_bytes(value):
	"""Decode bytes to str, handling heroprotocol's mixed bytes/str output."""
	if isinstance(value, bytes):
		return value.decode("utf-8", errors="replace")
	return value


def _filetime_to_iso(filetime: int) -> str:
	"""Convert Windows FILETIME to ISO 8601 UTC string."""
	unix_timestamp = (filetime - _FILETIME_EPOCH_DIFF) / 10_000_000
	dt = datetime.fromtimestamp(unix_timestamp, tz=timezone.utc)
	return dt.isoformat()


def _extract_score_value(values_list: list, player_index: int) -> int | None:
	"""Extract a single score value for a player from the score result array.

	The values array has 16 slots (10 players + 6 empty). Each non-empty
	slot contains a list of time-stamped values; we take the final one.
	"""
	if player_index >= len(values_list):
		return None
	entries = values_list[player_index]
	if not entries:
		return None
	return entries[-1]["m_value"]


def _detect_game_mode(global_scope: dict) -> str:
	"""Detect game mode from global attribute scope."""
	matchmaking = global_scope.get(3009, [{}])[0].get("value", b"").strip()
	lobby = global_scope.get(4010, [{}])[0].get("value", b"").strip()
	return _GAME_MODE_MAP.get((matchmaking, lobby), "Unknown")


def _extract_talents_from_attributes(player_scope: dict) -> list[str]:
	"""Extract talent internal codes from attribute events for a player.

	Returns list of 7 talent codes (or empty strings for unpicked tiers).
	"""
	talents = []
	for attr_id in _TALENT_ATTR_IDS:
		attr_list = player_scope.get(attr_id, [{}])
		code = _decode_bytes(attr_list[0].get("value", b"")).strip()
		talents.append(code)
	return talents


def parse_replay(replay_path: str) -> dict:
	"""Parse a single .StormReplay file and return structured data.

	Args:
		replay_path: Path to the .StormReplay file.

	Returns:
		Dict with match metadata, player stats, and talent data.

	Raises:
		FileNotFoundError: If the replay file doesn't exist.
		ValueError: If the replay can't be parsed (corrupt, unsupported build).
	"""
	if not os.path.isfile(replay_path):
		raise FileNotFoundError(f"Replay not found: {replay_path}")

	try:
		archive = mpyq.MPQArchive(replay_path)
	except Exception as e:
		raise ValueError(f"Failed to open replay archive: {e}") from e

	# Header (readable with any protocol version)
	header_content = archive.header["user_data_header"]["content"]
	header = latest().decode_replay_header(header_content)
	base_build = header["m_version"]["m_baseBuild"]
	elapsed_loops = header["m_elapsedGameLoops"]

	try:
		protocol = build(base_build)
	except Exception as e:
		raise ValueError(f"Unsupported protocol build {base_build}: {e}") from e

	# Some protocol builds load but lack decoder methods
	for method in ("decode_replay_details", "decode_replay_attributes_events"):
		if not hasattr(protocol, method):
			raise ValueError(f"Protocol build {base_build} missing {method}")

	# Details
	details_content = archive.read_file("replay.details")
	details = protocol.decode_replay_details(details_content)

	map_name = _decode_bytes(details["m_title"])
	timestamp = _filetime_to_iso(details["m_timeUTC"])
	duration_seconds = elapsed_loops / _LOOPS_PER_SECOND

	# Init data (randomSeed is the stable per-match identifier from the game engine)
	initdata = protocol.decode_replay_initdata(archive.read_file("replay.initdata"))
	random_seed = initdata["m_syncLobbyState"]["m_lobbyState"]["m_randomSeed"]

	# Attribute events (talents, game mode, hero level)
	attr_content = archive.read_file("replay.attributes.events")
	attributes = protocol.decode_replay_attributes_events(attr_content)
	scopes = attributes.get("scopes", {})
	global_scope = scopes.get(16, {})
	game_mode = _detect_game_mode(global_scope)

	# Build player list from details
	player_list = details["m_playerList"]
	num_players = len(player_list)
	players = []

	for i, p in enumerate(player_list):
		toon = p.get("m_toon", {})
		# Attribute scopes use 1-indexed player IDs
		player_scope = scopes.get(i + 1, {})

		hero_level_attr = player_scope.get(4008, [{}])[0].get("value", b"")
		hero_level_str = _decode_bytes(hero_level_attr).strip()
		hero_level = int(hero_level_str) if hero_level_str.isdigit() else None

		player_data = {
			"name": _decode_bytes(p["m_name"]),
			"hero": _decode_bytes(p["m_hero"]),
			"team": p["m_teamId"],
			"result": "win" if p["m_result"] == 1 else "loss",
			"toon": {
				"region": toon.get("m_region"),
				"realmId": toon.get("m_realm"),
				"profileId": toon.get("m_id"),
			},
			"heroLevel": hero_level,
			"talentCodes": _extract_talents_from_attributes(player_scope),
			"talentChoices": [],  # Filled from score results below
			"stats": {},
		}
		players.append(player_data)

	# Tracker events (hero identification, map ID, score results, death sources)
	tracker_content = archive.read_file("replay.tracker.events")
	hero_units = {}  # player_id -> internal hero name (from first SUnitBornEvent)
	unit_registry = {}  # (tag_index, tag_recycle) -> unit_type_name
	hero_tags = {}  # (tag_index, tag_recycle) -> player_index (0-based)
	death_sources = [{} for _ in range(num_players)]
	tracker_map_id = None
	first_blood_loop = None  # gameloop of first hero death
	first_blood_victim_idx = None  # player index (0-based) of first hero to die
	# Level lead: first gameloop each team reaches a talent tier level
	# team_level_loops[team_id][level] = first gameloop
	team_level_loops = {0: {}, 1: {}}
	# First boss/merc capture: team ID (0 or 1) or None
	first_boss_team = None
	first_boss_loop = None
	first_merc_team = None
	first_merc_loop = None
	if hasattr(protocol, "decode_replay_tracker_events"):
		for event in protocol.decode_replay_tracker_events(tracker_content):
			event_type = event.get("_event")

			if event_type == "NNet.Replay.Tracker.SUnitBornEvent":
				unit_name = _decode_bytes(event.get("m_unitTypeName", b""))
				player_id = event.get("m_controlPlayerId", 0)
				tag = (event.get("m_unitTagIndex"), event.get("m_unitTagRecycle"))
				# Build unit registry for death source classification
				if tag[0] is not None and tag[1] is not None:
					unit_registry[tag] = unit_name
					if unit_name.startswith("Hero") and 1 <= player_id <= num_players:
						hero_tags[tag] = player_id - 1
				# Hero identification: first spawn per player is their hero
				if player_id > 0 and player_id not in hero_units:
					if unit_name.startswith("Hero"):
						hero_units[player_id] = unit_name[4:]

			# Hero deaths by non-player units + first blood tracking
			elif event_type == "NNet.Replay.Tracker.SUnitDiedEvent":
				tag = (event.get("m_unitTagIndex"), event.get("m_unitTagRecycle"))
				if tag[0] is not None and tag[1] is not None and tag in hero_tags:
					pi = hero_tags[tag]
					# First blood: first hero death in the match
					game_loop = event.get("_gameloop", 0)
					if first_blood_loop is None or game_loop < first_blood_loop:
						first_blood_loop = game_loop
						first_blood_victim_idx = pi

					killer_pid = event.get("m_killerPlayerId", 0)
					if killer_pid == 0 or killer_pid > num_players:
						killer_tag = (
							event.get("m_killerUnitTagIndex"),
							event.get("m_killerUnitTagRecycle"),
						)
						if killer_tag[0] is not None and killer_tag[1] is not None:
							killer_type = unit_registry.get(killer_tag, "")
							category = _classify_killer_unit(killer_type)
							death_sources[pi][category] = death_sources[pi].get(category, 0) + 1

			# Score results
			elif event_type == "NNet.Replay.Tracker.SScoreResultEvent":
				for inst in event["m_instanceList"]:
					stat_name = inst["m_name"]

					if stat_name in _SCORE_STATS:
						field = _SCORE_STATS[stat_name]
						for pi in range(num_players):
							val = _extract_score_value(inst["m_values"], pi)
							if val is not None:
								players[pi]["stats"][field] = val

					elif stat_name in _TALENT_TIERS:
						tier_idx = _TALENT_TIERS.index(stat_name)
						for pi in range(num_players):
							val = _extract_score_value(inst["m_values"], pi)
							if val is not None:
								choices = players[pi]["talentChoices"]
								while len(choices) <= tier_idx:
									choices.append(None)
								choices[tier_idx] = val

					# End-of-match awards (booleans, 0 or 1 per player)
					elif stat_name.startswith(b"EndOfMatchAward"):
						for pi in range(num_players):
							val = _extract_score_value(inst["m_values"], pi)
							if val and val == 1:
								if stat_name == b"EndOfMatchAwardMVPBoolean":
									players[pi]["stats"]["awardMVP"] = 1
									players[pi]["stats"]["hasAward"] = 1
								elif stat_name == b"EndOfMatchAwardMapSpecificBoolean":
									players[pi]["stats"]["awardMapSpecific"] = 1
									players[pi]["stats"]["hasAward"] = 1
								elif stat_name == b"EndOfMatchAwardGivenToNonwinner":
									players[pi]["stats"]["awardInternal"] = 1
								else:
									players[pi]["stats"]["hasAward"] = 1

			# Map internal ID and votes from end-of-game tracker events
			elif event_type == "NNet.Replay.Tracker.SStatGameEvent":
				event_name = _decode_bytes(event.get("m_eventName", b""))

				if event_name == "EndOfGameTalentChoices" and tracker_map_id is None:
					for item in event.get("m_stringData", []):
						if _decode_bytes(item["m_key"]) == "Map":
							tracker_map_id = _decode_bytes(item["m_value"])
							break

				elif event_name == "EndOfGameUpVotesCollected":
					int_data = event.get("m_intData", [])
					if len(int_data) >= 2:
						upvoted_id = int_data[0].get("m_value", 0)
						voter_id = int_data[1].get("m_value", 0)
						if 1 <= upvoted_id <= num_players:
							players[upvoted_id - 1]["stats"].setdefault("votesReceived", 0)
							players[upvoted_id - 1]["stats"]["votesReceived"] += 1
						if 1 <= voter_id <= num_players:
							players[voter_id - 1]["stats"].setdefault("votesGiven", 0)
							players[voter_id - 1]["stats"]["votesGiven"] += 1

				elif event_name == "LevelUp":
					int_data = event.get("m_intData", [])
					if len(int_data) >= 2:
						tracker_pid = int_data[0].get("m_value", 0)
						new_level = int_data[1].get("m_value", 0)
						if new_level in _TALENT_TIER_LEVELS and 1 <= tracker_pid <= num_players:
							team_id = players[tracker_pid - 1]["team"]
							if new_level not in team_level_loops[team_id]:
								team_level_loops[team_id][new_level] = event.get("_gameloop", 0)

				elif event_name == "JungleCampCapture":
					fixed_data = event.get("m_fixedData", [])
					string_data = event.get("m_stringData", [])
					if fixed_data and string_data:
						# Team: 1=blue(team0), 2=red(team1), stored as fixed-point / 4096
						raw_team = fixed_data[0].get("m_value", 0) // 4096
						team_id = raw_team - 1  # 0 or 1
						if team_id in (0, 1):
							camp_type = _decode_bytes(string_data[0].get("m_value", b""))
							game_loop = event.get("_gameloop", 0)
							if camp_type == _BOSS_CAMP_TYPE:
								if first_boss_loop is None or game_loop < first_boss_loop:
									first_boss_team = team_id
									first_boss_loop = game_loop
							else:
								if first_merc_loop is None or game_loop < first_merc_loop:
									first_merc_team = team_id
									first_merc_loop = game_loop

	# Message events (chat messages, pings, disconnects)
	message_content = archive.read_file("replay.message.events")
	if message_content and hasattr(protocol, "decode_replay_message_events"):
		disconnected = set()
		chat_records = []
		for event in protocol.decode_replay_message_events(message_content):
			event_name = event.get("_event", "")
			userid = event.get("_userid")
			player_idx = userid.get("m_userId") if userid else None

			if event_name.endswith(".SChatMessage"):
				if player_idx is not None and 0 <= player_idx < num_players:
					players[player_idx]["stats"].setdefault("chatMessages", 0)
					players[player_idx]["stats"]["chatMessages"] += 1
					recipient = event.get("m_recipient", 1)
					if recipient == 0:
						players[player_idx]["stats"].setdefault("chatMessagesAll", 0)
						players[player_idx]["stats"]["chatMessagesAll"] += 1
					elif recipient == 1:
						players[player_idx]["stats"].setdefault("chatMessagesTeam", 0)
						players[player_idx]["stats"]["chatMessagesTeam"] += 1

					# Toxicity detection on message text
					raw_text = event.get("m_string", b"")
					text = _decode_bytes(raw_text) if isinstance(raw_text, bytes) else str(raw_text)
					if text and is_toxic(text):
						players[player_idx]["stats"].setdefault("chatToxicMessages", 0)
						players[player_idx]["stats"]["chatToxicMessages"] += 1

					# Retain per-message metadata for behaviour analysis
					if text:
						chat_records.append((
							event.get("_gameloop", 0),
							player_idx,
							text,
						))

			elif event_name.endswith(".SPingMessage"):
				if player_idx is not None and 0 <= player_idx < num_players:
					players[player_idx]["stats"].setdefault("pings", 0)
					players[player_idx]["stats"]["pings"] += 1

			elif event_name.endswith(".SReconnectNotifyMessage"):
				status = event.get("m_status", 0)
				if player_idx is not None and 0 <= player_idx < num_players:
					if status == 1:
						players[player_idx]["stats"].setdefault("disconnects", 0)
						players[player_idx]["stats"]["disconnects"] += 1
						disconnected.add(player_idx)
					elif status == 2:
						disconnected.discard(player_idx)

		for pi in disconnected:
			if 0 <= pi < num_players:
				players[pi]["stats"]["disconnectedAtEnd"] = 1

		# Derived chat stats: per-player clean/toxic game flags for HoF/HoS
		for pi in range(num_players):
			s = players[pi]["stats"]
			total_chat = s.get("chatMessages", 0)
			toxic_chat = s.get("chatToxicMessages", 0)
			if total_chat > 0 and toxic_chat == 0:
				s["chatGamesClean"] = 1
			if toxic_chat > 0:
				s["chatGamesToxic"] = 1

		# Chat behaviour: sportsmanlike greeting (glhf) in first 60 seconds
		for gameloop, pi, text in chat_records:
			if gameloop > _GLHF_THRESHOLD_LOOPS:
				continue
			if _normalize_chat(text) in _GLHF_PATTERNS:
				players[pi]["stats"]["chatGlhf"] = 1

		# Chat behaviour: offensive gg (too early or winners-say-first)
		winning_team = None
		losing_team = None
		for p in players:
			if p["result"] == "win":
				winning_team = p["team"]
			elif p["result"] == "loss":
				losing_team = p["team"]
			if winning_team is not None and losing_team is not None:
				break

		gg_early_threshold = elapsed_loops - _GG_EARLY_BUFFER_LOOPS

		# Find the losing team's first gg
		loser_first_gg_loop = None
		if losing_team is not None:
			for gameloop, pi, text in sorted(chat_records, key=lambda r: r[0]):
				if _normalize_chat(text) in _GG_PATTERNS and players[pi]["team"] == losing_team:
					loser_first_gg_loop = gameloop
					break

		# Flag players who sent an offensive gg
		for gameloop, pi, text in chat_records:
			if _normalize_chat(text) not in _GG_PATTERNS:
				continue
			is_offensive = False
			# Too early: more than 15 seconds before game end
			if gameloop < gg_early_threshold:
				is_offensive = True
			# Winners first: winning team gg before losing team's first gg
			if (winning_team is not None and players[pi]["team"] == winning_team
					and loser_first_gg_loop is not None and gameloop < loser_first_gg_loop):
				is_offensive = True
			if is_offensive:
				players[pi]["stats"]["chatOffensiveGg"] = 1

	# Store death-by-source stats
	for pi in range(num_players):
		for category, count in death_sources[pi].items():
			if count > 0:
				key = _DEATH_SOURCE_STAT_KEYS.get(category)
				if key:
					players[pi]["stats"][key] = count

	# Resolve hero names from tracker data (language-independent)
	for i, p in enumerate(players):
		internal_id = hero_units.get(i + 1)
		if internal_id:
			p["hero"] = HERO_NAMES.get(internal_id, internal_id)

	# Resolve map name from tracker data (language-independent)
	if tracker_map_id:
		map_name = MAP_NAMES.get(tracker_map_id, tracker_map_id)
		# ARAM: Amm+stan on an ARAM-exclusive map
		if game_mode == "QuickMatch" and tracker_map_id in ARAM_MAP_IDS:
			game_mode = "ARAM"

	# Compute KDA for each player
	for p in players:
		s = p["stats"]
		kills = s.get("kills", 0)
		deaths = s.get("deaths", 0)
		assists = s.get("assists", 0)
		p["stats"]["kda"] = round((kills + assists) / max(deaths, 1), 2)

	# First blood: which team gave up the first death
	# The victim's team conceded first blood; the other team "got" it.
	first_blood_team = None
	if first_blood_victim_idx is not None and first_blood_victim_idx < num_players:
		victim_team = players[first_blood_victim_idx]["team"]
		first_blood_team = 1 - victim_team

	# Level lead: determine which team reached each talent tier first
	first_to_level = {}
	for level in sorted(_TALENT_TIER_LEVELS):
		t0 = team_level_loops[0].get(level)
		t1 = team_level_loops[1].get(level)
		if t0 is not None and t1 is not None:
			if t0 < t1:
				first_to_level[str(level)] = 0
			elif t1 < t0:
				first_to_level[str(level)] = 1
			# Tie (same gameloop): omit from results
		elif t0 is not None:
			first_to_level[str(level)] = 0
		elif t1 is not None:
			first_to_level[str(level)] = 1

	return {
		"map": map_name,
		"timestamp": timestamp,
		"durationSeconds": round(duration_seconds, 1),
		"build": base_build,
		"gameMode": game_mode,
		"randomSeed": random_seed,
		"players": players,
		"firstBloodTeam": first_blood_team,
		"firstToLevel": first_to_level,
		"firstBossTeam": first_boss_team,
		"firstMercTeam": first_merc_team,
	}
