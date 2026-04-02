# Pipeline entry point. Parses replay files and writes structured JSON output.
# Usage: python pipeline/run.py <replay_path> [--output-dir <dir>] [--pretty]

import argparse
import json
import os
import sys
import hashlib

from pipeline.parser import parse_replay

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG_PATH = os.path.join(PROJECT_ROOT, "pipeline.json")


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
	"""
	player_ids = sorted(p["toon"]["profileId"] for p in match_data["players"])
	identity = "".join(str(pid) for pid in player_ids) + str(match_data["randomSeed"])
	return hashlib.md5(identity.encode()).hexdigest()


def process_single(
	replay_path: str,
	config: dict,
	output_dir: str | None = None,
	pretty: bool = False,
	seen_match_ids: set | None = None,
) -> dict:
	"""Parse a replay and write the match JSON file.

	Args:
		seen_match_ids: If provided, duplicate matches (same ID already in set)
			are tagged but not written to disk. The set is updated in place.

	Returns the parsed match data dict with isDuplicate and hasRoster flags.
	"""
	replay_path = os.path.abspath(replay_path)
	match_data = parse_replay(replay_path)

	match_id = generate_match_id(match_data)
	match_data["matchId"] = match_id
	match_data["replayFile"] = os.path.basename(replay_path)

	# Tag roster players by toon ID (region-realmId-profileId)
	toon_to_roster = {}
	for member in config.get("roster", []):
		for toon_str in member.get("toons", []):
			toon_to_roster[toon_str] = member["name"]

	for player in match_data["players"]:
		t = player["toon"]
		toon_key = f"{t['region']}-{t['realmId']}-{t['profileId']}"
		roster_name = toon_to_roster.get(toon_key)
		player["isRoster"] = roster_name is not None
		if roster_name:
			player["rosterName"] = roster_name

	# Party detection: tag roster players with party size and teammates
	roster_by_team = {}
	for player in match_data["players"]:
		if player.get("isRoster"):
			team = player["team"]
			roster_by_team.setdefault(team, []).append(player["rosterName"])

	for player in match_data["players"]:
		if player.get("isRoster"):
			teammates = roster_by_team[player["team"]]
			player["partySize"] = len(teammates)
			player["partyMembers"] = [n for n in teammates if n != player["rosterName"]]

	# Deduplication: skip writing if this match was already processed
	is_duplicate = seen_match_ids is not None and match_id in seen_match_ids
	has_roster = any(p.get("isRoster") for p in match_data["players"])
	match_data["isDuplicate"] = is_duplicate
	match_data["hasRoster"] = has_roster

	if seen_match_ids is not None:
		seen_match_ids.add(match_id)

	if not is_duplicate and has_roster:
		out_dir = output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
		matches_dir = os.path.join(out_dir, "matches")
		os.makedirs(matches_dir, exist_ok=True)

		# Strip runtime-only fields before writing
		output_data = {k: v for k, v in match_data.items() if k not in ("isDuplicate", "hasRoster")}
		output_path = os.path.join(matches_dir, f"{match_id}.json")
		indent = 2 if pretty else None
		with open(output_path, "w", encoding="utf-8") as f:
			json.dump(output_data, f, indent=indent, ensure_ascii=False)

	return match_data


def main():
	parser = argparse.ArgumentParser(description="Process HotS replay files")
	parser.add_argument("replay", help="Path to a .StormReplay file")
	parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Pipeline config path")
	parser.add_argument("--output-dir", default=None, help="Override output directory")
	parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
	args = parser.parse_args()

	try:
		config = load_config(args.config)
	except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
		print(f"Config error: {e}", file=sys.stderr)
		sys.exit(1)

	try:
		match_data = process_single(args.replay, config, args.output_dir, args.pretty)
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
	status = "Duplicate" if match_data.get("isDuplicate") else "Processed"
	print(f"{status}: {match_id} [{map_name}, {mode}, {roster_count} roster players]")


if __name__ == "__main__":
	main()
