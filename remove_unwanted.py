# Identifies and removes replay files that don't meet acceptance criteria.
# Accepted: StormLeague, Custom (draft/standard/tournament), ARAM.
# Rejected: QuickMatch, Brawl, unknown modes, AI players, incomplete games, unparseable.
# Usage: python remove_unwanted.py [--replay-dir path]

import json
import os
import sys
import time
from collections import Counter

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_PROJECT_ROOT, "tools", "heroprotocol"))

import mpyq
from heroprotocol.versions import build, latest
from pipeline.herodata import ARAM_MAP_IDS, ARAM_MAP_NAMES as ARAM_MAPS
from replay_utils import find_replays

ACCEPTED_MODES = frozenset({"StormLeague", "CustomDraft", "CustomStandard", "ARAM"})


def _decode(value):
	if isinstance(value, bytes):
		return value.decode("utf-8", errors="replace")
	return value


def _classify_mode(matchmaking: bytes, lobby: bytes, map_name: str) -> str:
	mm = _decode(matchmaking).strip()
	lb = _decode(lobby).strip()

	if mm == "Priv":
		if lb in ("drft", "tour"):
			return "CustomDraft"
		return "CustomStandard"

	if mm == "Amm":
		if lb == "drft":
			return "StormLeague"
		if map_name in ARAM_MAPS:
			return "ARAM"
		return "QuickMatch"

	return "Unknown"


def _extract_tracker_map_id(archive, protocol) -> str | None:
	"""Extract internal map ID from tracker events. Only called as ARAM fallback."""
	if not hasattr(protocol, "decode_replay_tracker_events"):
		return None
	tracker_content = archive.read_file("replay.tracker.events")
	if not tracker_content:
		return None
	for event in protocol.decode_replay_tracker_events(tracker_content):
		if event.get("_event") != "NNet.Replay.Tracker.SStatGameEvent":
			continue
		if _decode(event.get("m_eventName", b"")) == "EndOfGameTalentChoices":
			for item in event.get("m_stringData", []):
				if _decode(item["m_key"]) == "Map":
					return _decode(item["m_value"])
	return None


def _load_roster_toons() -> frozenset[str]:
	"""Load roster toon IDs from pipeline.json."""
	config_path = os.path.join(_PROJECT_ROOT, "pipeline.json")
	with open(config_path, "r", encoding="utf-8") as f:
		config = json.load(f)
	toons = set()
	for entry in config["roster"]:
		for toon in entry.get("toons", []):
			toons.add(toon)
	return frozenset(toons)


def check_replay(path: str, roster_toons: frozenset[str]) -> tuple[bool, str, str]:
	"""Check if a replay meets acceptance criteria.

	Returns (accepted, category, detail) where category is the game mode
	if accepted, or the rejection reason if not.
	"""
	try:
		archive = mpyq.MPQArchive(path)
	except Exception as e:
		return (False, "unparseable", f"bad archive: {e}")

	try:
		header_content = archive.header["user_data_header"]["content"]
		header = latest().decode_replay_header(header_content)
		base_build = header["m_version"]["m_baseBuild"]
		protocol = build(base_build)
	except Exception as e:
		return (False, "unparseable", f"protocol error: {e}")

	for method in ("decode_replay_details", "decode_replay_attributes_events"):
		if not hasattr(protocol, method):
			return (False, "unparseable", f"build {base_build} missing {method}")

	try:
		details = protocol.decode_replay_details(archive.read_file("replay.details"))
	except Exception as e:
		return (False, "unparseable", f"details decode failed: {e}")

	players = details["m_playerList"]

	# Check for AI players (only among actual players, not observers)
	for p in players:
		if p.get("m_observe", 0) == 0 and p["m_control"] != 2:
			return (False, "ai_detected", f"non-human player (control={p['m_control']})")

	# Check game completion (m_result: 1=win, 2=loss, 0=undecided)
	for p in players:
		if p.get("m_observe", 0) == 0 and p["m_result"] not in (1, 2):
			return (False, "incomplete", f"unresolved result ({p['m_result']})")

	try:
		attr_content = archive.read_file("replay.attributes.events")
		attributes = protocol.decode_replay_attributes_events(attr_content)
	except Exception as e:
		return (False, "unparseable", f"attributes decode failed: {e}")

	scopes = attributes.get("scopes", {})
	global_scope = scopes.get(16, {})
	matchmaking = global_scope.get(3009, [{}])[0].get("value", b"")
	lobby = global_scope.get(4010, [{}])[0].get("value", b"")

	map_name = _decode(details["m_title"])

	# Reject sandbox/try mode maps
	if "Sandbox" in map_name:
		return (False, "sandbox", map_name)

	mode = _classify_mode(matchmaking, lobby, map_name)

	# Fallback for non-English clients: display name won't match ARAM_MAPS,
	# so check tracker events for the internal map ID.
	if mode == "QuickMatch":
		tracker_map_id = _extract_tracker_map_id(archive, protocol)
		if tracker_map_id in ARAM_MAP_IDS:
			mode = "ARAM"

	if mode not in ACCEPTED_MODES:
		return (False, mode.lower(), f"{map_name}")

	# Count roster players per team
	roster_by_team: dict[int, int] = {}
	for p in players:
		t = p.get("m_toon", {})
		toon_key = f"{t.get('m_region')}-{t.get('m_realm')}-{t.get('m_id')}"
		if toon_key in roster_toons:
			team = p.get("m_teamId", -1)
			roster_by_team[team] = roster_by_team.get(team, 0) + 1

	if not roster_by_team:
		return (False, "no_roster_player", map_name)

	# Custom games require a full 5-stack on one team
	if mode in ("CustomDraft", "CustomStandard"):
		max_on_team = max(roster_by_team.values())
		if max_on_team < 5:
			return (False, "custom_no_5stack", f"{map_name} (max {max_on_team} roster on one team)")

	return (True, mode, "ok")


def scan_unwanted(replay_dir: str) -> tuple[list[tuple[str, str, str]], dict[str, int]]:
	"""Scan replays and identify unwanted files.

	Returns (unwanted, mode_counts) where unwanted is [(path, category, detail)]
	and mode_counts tracks accepted game mode distribution.
	"""
	replays = find_replays(replay_dir)
	total = len(replays)

	roster_toons = _load_roster_toons()
	unwanted = []
	mode_counts: Counter = Counter()
	start = time.monotonic()
	last_report = start

	for i, path in enumerate(replays):
		accepted, category, detail = check_replay(path, roster_toons)
		if accepted:
			mode_counts[category] += 1
		else:
			unwanted.append((path, category, detail))

		now = time.monotonic()
		if now - last_report >= 5:
			checked = i + 1
			elapsed = now - start
			rate = checked / elapsed
			remaining = (total - checked) / rate if rate > 0 else 0
			print(f"  [{checked}/{total}] {len(unwanted)} unwanted "
				f"({rate:.0f}/s, ~{remaining:.0f}s left)", flush=True)
			last_report = now

	elapsed = time.monotonic() - start
	print(f"  Scanned {total} files in {elapsed:.1f}s")

	return unwanted, mode_counts


def remove_unwanted(replay_dir: str) -> int:
	"""Find and remove unwanted replay files. Returns count removed.

	Always requires explicit user confirmation before deleting anything.
	"""
	replays = find_replays(replay_dir)
	total = len(replays)
	if total == 0:
		print("No replay files found.")
		return 0

	print(f"Scanning {total} replay files for unwanted replays...")
	unwanted, mode_counts = scan_unwanted(replay_dir)

	kept = total - len(unwanted)
	print(f"\nResults:")
	print(f"  Total files: {total}")
	print(f"  Accepted:    {kept}")
	for mode, count in mode_counts.most_common():
		print(f"    {mode}: {count}")
	print(f"  Rejected:    {len(unwanted)}")

	if not unwanted:
		print("\nNo unwanted replays found.")
		return 0

	# Group by rejection reason
	by_reason: dict[str, list[tuple[str, str]]] = {}
	for path, category, detail in unwanted:
		by_reason.setdefault(category, []).append((os.path.basename(path), detail))

	print(f"\nRejection breakdown:")
	for reason, files in sorted(by_reason.items(), key=lambda x: -len(x[1])):
		print(f"  {reason}: {len(files)}")
		for name, detail in files[:5]:
			print(f"    {name} ({detail})")
		if len(files) > 5:
			print(f"    ... and {len(files) - 5} more")

	unparseable = by_reason.get("unparseable", [])
	if unparseable:
		print(f"\nRemoval blocked: {len(unparseable)} file(s) failed to parse. Fix the errors and re-run.")
		return 0

	print(f"\n{len(unwanted)} unwanted files can be removed, leaving {kept} accepted replays.")
	answer = input("Remove unwanted replays? [y/N] ").strip().lower()
	if answer != "y":
		print("Aborted. No files were deleted.")
		return 0

	deleted = 0
	for path, _category, _detail in unwanted:
		os.remove(path)
		deleted += 1

	print(f"Removed {deleted} unwanted files.")
	return deleted


def main():
	import argparse
	parser = argparse.ArgumentParser(description="Find and remove unwanted HotS replay files")
	parser.add_argument("--replay-dir",
		default=os.path.join(_PROJECT_ROOT, "replays"),
		help="Directory containing replay files")
	args = parser.parse_args()

	if not os.path.isdir(args.replay_dir):
		print(f"Replay directory not found: {args.replay_dir}", file=sys.stderr)
		sys.exit(1)

	remove_unwanted(args.replay_dir)


if __name__ == "__main__":
	main()
