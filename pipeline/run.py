# Pipeline entry point. Parses replay files and writes structured JSON output.
# Usage: python pipeline/run.py <replay_path> [--output-dir <dir>] [--pretty]

import argparse
import gzip
import json
import os
import sys
import hashlib

from pipeline.parser import parse_replay_raw, analyze_raw

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG_PATH = os.path.join(PROJECT_ROOT, "pipeline.json")

# Tier-2 archives live at the repo root, not under the served output directory,
# so they never ship with data/. Overridable via --archive-dir for sandboxing.
DEFAULT_ARCHIVE_DIR = os.path.join(PROJECT_ROOT, "archive")

# Tier-1 schema: the exact set of top-level and per-player keys the committed
# match JSON carries. The sidecar emits a tier-2 superset; write_match filters
# it down to this whitelist so the served match files stay stable. The `stats`
# and `toon` objects are kept whole; `stats` may carry populated `disconnects` /
# `disconnectedAtEnd`, which are absent from the committed data (they only fill
# in with game-event parsing on).
_TIER1_TOPLEVEL_KEYS = (
	"map", "timestamp", "durationSeconds", "build", "gameMode", "randomSeed",
	"players", "firstBloodTeam", "firstToLevel", "teamLevels", "firstBossTeam",
	"firstMercTeam", "draft", "matchId", "replayFile",
)
_TIER1_PLAYER_KEYS = (
	"name", "hero", "team", "result", "toon", "heroLevel", "talentChoices",
	"stats", "isRoster", "rosterName", "isAlt", "altName", "partySize", "partyMembers",
	"matchAwardsList",
)


def load_config(config_path: str) -> dict:
	"""Load and validate pipeline configuration."""
	if not os.path.isfile(config_path):
		raise FileNotFoundError(f"Config not found: {config_path}")

	with open(config_path, "r", encoding="utf-8") as f:
		config = json.load(f)

	required = ["roster", "outputDirectory"]
	for key in required:
		if key not in config:
			raise ValueError(f"Config missing required key: '{key}'")

	return config


def generate_match_id(match_data: dict) -> str:
	"""Generate a stable match ID from match content.

	Uses sorted player profile IDs + randomSeed (same method as Heroes Profile / HotsLogs)
	so the same match produces the same ID regardless of which player's replay was parsed.
	Players without a profile ID (AI) are skipped: accepted matches are all human so
	this never changes an accepted match's ID, and it lets the batch classifier
	fingerprint a raw dict that may still contain AI players before rejecting it.
	"""
	player_ids = sorted(
		p["toon"]["profileId"] for p in match_data["players"]
		if p.get("toon", {}).get("profileId") is not None
	)
	identity = "".join(str(pid) for pid in player_ids) + str(match_data["randomSeed"])
	return hashlib.md5(identity.encode()).hexdigest()


def tag_players(match_data: dict, config: dict) -> None:
	"""Re-derive isRoster/rosterName/isAlt/altName and party info from toon IDs.

	Tags each player against the current roster + alts by toon ID
	(region-realmId-profileId). Idempotent: clears prior tags for players who
	are no longer roster/alt, so it works both on a fresh parse and on an
	already-tagged match JSON (retag). Party detection covers roster and alt
	players (loose Sauna Tent membership); partyMembers lists teammates by name,
	excluding self.
	"""
	toon_to_roster = {}
	for member in config.get("roster", []):
		for toon_str in member.get("toons", []):
			toon_to_roster[toon_str] = member["name"]

	toon_to_alt = {}
	for member in config.get("alts", []):
		for toon_str in member.get("toons", []):
			toon_to_alt[toon_str] = member["name"]

	for player in match_data["players"]:
		t = player["toon"]
		toon_key = f"{t['region']}-{t['realmId']}-{t['profileId']}"
		roster_name = toon_to_roster.get(toon_key)
		alt_name = toon_to_alt.get(toon_key)

		player["isRoster"] = roster_name is not None
		if roster_name is not None:
			player["rosterName"] = roster_name
		else:
			player.pop("rosterName", None)

		player["isAlt"] = alt_name is not None
		if alt_name is not None:
			player["altName"] = alt_name
		else:
			player.pop("altName", None)

	# Party detection: group roster + alt players by team.
	sauna_by_team = {}
	for player in match_data["players"]:
		if player.get("isRoster") or player.get("isAlt"):
			name = player.get("rosterName") or player.get("altName")
			sauna_by_team.setdefault(player["team"], []).append(name)

	for player in match_data["players"]:
		if player.get("isRoster") or player.get("isAlt"):
			teammates = sauna_by_team[player["team"]]
			own_name = player.get("rosterName") or player.get("altName")
			player["partySize"] = len(teammates)
			player["partyMembers"] = [n for n in teammates if n != own_name]
		else:
			player.pop("partySize", None)
			player.pop("partyMembers", None)


def _tier1_view(match_data: dict) -> dict:
	"""Filter an analysed match dict down to the tier-1 committed schema.

	Applies the top-level and per-player key whitelist (insertion order
	preserved for byte-stable output). `stats` and `toon` pass through whole.
	This also drops the runtime-only flags, which are not whitelisted.
	"""
	output = {k: v for k, v in match_data.items() if k in _TIER1_TOPLEVEL_KEYS}
	output["players"] = [
		{k: v for k, v in player.items() if k in _TIER1_PLAYER_KEYS}
		for player in match_data.get("players", [])
	]
	return output


def write_match(match_data: dict, output_dir: str, pretty: bool = False) -> str:
	"""Write the tier-1 match JSON to <output_dir>/matches/<matchId>.json.

	Emits exactly the committed schema via the tier-1 whitelist. Returns the path.
	"""
	matches_dir = os.path.join(output_dir, "matches")
	os.makedirs(matches_dir, exist_ok=True)
	output_data = _tier1_view(match_data)
	output_path = os.path.join(matches_dir, f"{match_data['matchId']}.json")
	indent = 2 if pretty else None
	with open(output_path, "w", encoding="utf-8") as f:
		json.dump(output_data, f, indent=indent, ensure_ascii=False)
	return output_path


def archive_path(archive_dir: str, match_id: str) -> str:
	"""The single source of truth for a match's tier-2 archive file path."""
	return os.path.join(archive_dir, f"{match_id}.json.gz")


def write_match_archive(raw: dict, match_id: str, replay_file: str, archive_dir: str) -> str:
	"""Write the tier-2 extract to <archive_dir>/<matchId>.json.gz.

	The archive holds the full sidecar superset (the approved extraction
	categories - see the pipeline README for the exact preserved/discarded
	inventory) plus matchId/replayFile bookkeeping, so the source .StormReplay
	can be discarded. The gzip stream is deterministic (mtime=0, no embedded
	filename) so reruns are byte-identical.
	"""
	os.makedirs(archive_dir, exist_ok=True)
	record = dict(raw)
	record["matchId"] = match_id
	record["replayFile"] = replay_file
	payload = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
	output_path = archive_path(archive_dir, match_id)
	with open(output_path, "wb") as f:
		f.write(gzip.compress(payload, mtime=0))
	return output_path


def process_single(
	replay_path: str,
	config: dict,
	output_dir: str | None = None,
	pretty: bool = False,
	seen_match_ids: set | None = None,
	archive_dir: str | None = None,
) -> dict:
	"""Parse a replay and write the tier-1 match JSON plus the tier-2 archive.

	Args:
		seen_match_ids: If provided, duplicate matches (same ID already in set)
			are tagged but not written to disk. The set is updated in place.
		archive_dir: Tier-2 archive directory. Defaults to the repo-root archive/
			(it does not follow output_dir).

	Returns the parsed match data dict with isDuplicate and hasRoster flags.
	"""
	replay_path = os.path.abspath(replay_path)
	raw = parse_replay_raw(replay_path)
	match_data = analyze_raw(raw)

	match_id = generate_match_id(match_data)
	replay_file = os.path.basename(replay_path)
	match_data["matchId"] = match_id
	match_data["replayFile"] = replay_file

	tag_players(match_data, config)

	# Deduplication: skip writing if this match was already processed
	is_duplicate = seen_match_ids is not None and match_id in seen_match_ids
	has_roster = any(p.get("isRoster") for p in match_data["players"])
	has_alt = any(p.get("isAlt") for p in match_data["players"])
	match_data["isDuplicate"] = is_duplicate
	match_data["hasRoster"] = has_roster
	match_data["hasAlt"] = has_alt

	if seen_match_ids is not None:
		seen_match_ids.add(match_id)

	if not is_duplicate and (has_roster or has_alt):
		out_dir = output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
		write_match(match_data, out_dir, pretty)
		write_match_archive(raw, match_id, replay_file, archive_dir or DEFAULT_ARCHIVE_DIR)

	return match_data


def main():
	parser = argparse.ArgumentParser(description="Process HotS replay files")
	parser.add_argument("replay", help="Path to a .StormReplay file")
	parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Pipeline config path")
	parser.add_argument("--output-dir", default=None, help="Override output directory")
	parser.add_argument("--archive-dir", default=None, help="Override tier-2 archive directory (default: repo-root archive/)")
	parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
	args = parser.parse_args()

	try:
		config = load_config(args.config)
	except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
		print(f"Config error: {e}", file=sys.stderr)
		sys.exit(1)

	try:
		match_data = process_single(
			args.replay, config, args.output_dir, args.pretty, archive_dir=args.archive_dir,
		)
	except FileNotFoundError as e:
		print(f"Replay error: {e}", file=sys.stderr)
		sys.exit(1)
	except ValueError as e:
		print(f"Parse error: {e}", file=sys.stderr)
		sys.exit(1)

	match_id = match_data["matchId"]
	map_name = match_data["map"]
	mode = match_data["gameMode"]
	roster_count = sum(1 for p in match_data["players"] if p["isRoster"])
	alt_count = sum(1 for p in match_data["players"] if p["isAlt"])
	status = "Duplicate" if match_data.get("isDuplicate") else "Processed"
	print(f"{status}: {match_id} [{map_name}, {mode}, {roster_count} roster, {alt_count} alt]")


if __name__ == "__main__":
	main()
