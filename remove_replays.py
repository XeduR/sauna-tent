# Scans replay files and removes unwanted ones by category.
# Combines duplicate detection and content-based filtering into a single pass.
# Usage: python remove_replays.py [--replay-dir path]

import hashlib
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_PROJECT_ROOT, "tools", "heroprotocol"))

import mpyq
from heroprotocol.versions import build, latest
from pipeline.herodata import ARAM_MAP_IDS, ARAM_MAP_NAMES as ARAM_MAPS
from replay_utils import find_replays

ACCEPTED_MODES = frozenset({"StormLeague", "CustomDraft", "ARAM"})
_FILETIME_EPOCH_DIFF = 116444736000000000

# Game modes that map to the "unwanted_mode" category.
_UNWANTED_MODE_REASONS = frozenset({
	"sandbox", "brawl", "quickmatch", "customstandard", "unknown",
})

# Brawl-exclusive maps that should never pass regardless of mode classification.
BRAWL_MAPS = frozenset({
	"Bash 'Em Smash 'Em Robots",
	"Blackheart's Revenge",
	"Bloodlust Brawl",
	"Booty Coffers",
	"Checkpoint: Hanamura",
	"Deadman's Stand",
	"Dodge-BRAWL",
	"Escape From Braxis",
	"Garden Arena",
	"Ghost Protocol",
	"Hallow's End",
	"Hammer Time",
	"Heroes of the Stars",
	"Lunar Rocket Racing",
	"Mage Wars",
	"Mineral Madness",
	"Pull Party",
	"Punisher Arena",
	"Snow Brawl",
	"Special Delivery",
	"Temple Arena",
	"Trial Grounds",
})

# Display labels for rejection categories, in presentation order.
_CATEGORY_LABELS = {
	"duplicate": "Duplicate replays",
	"before_cutoff": "Before cutoff date",
	"unwanted_mode": "Unwanted game mode",
	"ai_detected": "AI players detected",
	"incomplete": "Incomplete games",
	"no_sauna_player": "No Sauna Tent player",
	"custom_no_5stack": "Custom without 5-stack",
	"unparseable": "Failed to parse",
}

# Presentation order for the summary.
_CATEGORY_ORDER = list(_CATEGORY_LABELS.keys())


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


def _load_sauna_toons() -> frozenset[str]:
	"""Load roster and alt toon IDs from pipeline.json.

	Alts are loose Sauna Tent membership; games containing only alts are still
	legitimate Sauna Tent games and must not be rejected here.
	"""
	config_path = os.path.join(_PROJECT_ROOT, "pipeline.json")
	with open(config_path, "r", encoding="utf-8") as f:
		config = json.load(f)
	toons = set()
	for entry in config["roster"]:
		for toon in entry.get("toons", []):
			toons.add(toon)
	for entry in config.get("alts", []):
		for toon in entry.get("toons", []):
			toons.add(toon)
	return frozenset(toons)


def _load_cutoff_date() -> str | None:
	"""Load cutoff date from pipeline.json. Returns ISO date string or None."""
	config_path = os.path.join(_PROJECT_ROOT, "pipeline.json")
	with open(config_path, "r", encoding="utf-8") as f:
		config = json.load(f)
	return config.get("cutoffDate")


def _match_fingerprint(archive, protocol) -> str:
	"""MD5 of sorted player IDs + randomSeed."""
	details = protocol.decode_replay_details(archive.read_file("replay.details"))
	player_ids = sorted(p["m_toon"]["m_id"] for p in details["m_playerList"])
	initdata = protocol.decode_replay_initdata(archive.read_file("replay.initdata"))
	random_seed = initdata["m_syncLobbyState"]["m_lobbyState"]["m_randomSeed"]
	identity = "".join(str(pid) for pid in player_ids) + str(random_seed)
	return hashlib.md5(identity.encode()).hexdigest()


def check_replay(
	path: str,
	sauna_toons: frozenset[str],
	seen_fingerprints: dict[str, str],
	cutoff_date: str | None = None,
) -> tuple[bool, str, str]:
	"""Check a replay against all rejection criteria.

	Args:
		seen_fingerprints: Maps fingerprint -> first path seen. Updated in place.
		cutoff_date: ISO date string (YYYY-MM-DD). Replays before this date are rejected.

	Returns (accepted, category, detail).
	"""
	basename = os.path.basename(path)

	# Sandbox pre-filter (avoids protocol errors on unpublished builds)
	if "Sandbox" in basename:
		return (False, "unwanted_mode", f"sandbox: {basename}")

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

	# Duplicate check (before full content parsing)
	try:
		fp = _match_fingerprint(archive, protocol)
	except Exception as e:
		return (False, "unparseable", f"fingerprint failed: {e}")

	first_seen = seen_fingerprints.get(fp)
	if first_seen is not None:
		return (False, "duplicate", os.path.basename(first_seen))
	seen_fingerprints[fp] = path

	try:
		details = protocol.decode_replay_details(archive.read_file("replay.details"))
	except Exception as e:
		return (False, "unparseable", f"details decode failed: {e}")

	# Cutoff date
	if cutoff_date:
		filetime = details.get("m_timeUTC", 0)
		if filetime > 0:
			unix_ts = (filetime - _FILETIME_EPOCH_DIFF) / 10_000_000
			replay_date = datetime.fromtimestamp(unix_ts, tz=timezone.utc).strftime("%Y-%m-%d")
			if replay_date < cutoff_date:
				return (False, "before_cutoff", replay_date)

	players = details["m_playerList"]

	# AI players
	for p in players:
		if p.get("m_observe", 0) == 0 and p["m_control"] != 2:
			return (False, "ai_detected", f"non-human player (control={p['m_control']})")

	# Incomplete games
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

	# Sandbox (from map name, backup for the filename pre-filter)
	if "Sandbox" in map_name:
		return (False, "unwanted_mode", f"sandbox: {map_name}")

	# Brawl maps
	if map_name in BRAWL_MAPS:
		return (False, "unwanted_mode", f"brawl: {map_name}")

	mode = _classify_mode(matchmaking, lobby, map_name)

	# ARAM fallback for non-English clients
	if mode == "QuickMatch":
		tracker_map_id = _extract_tracker_map_id(archive, protocol)
		if tracker_map_id in ARAM_MAP_IDS:
			mode = "ARAM"

	if mode not in ACCEPTED_MODES:
		return (False, "unwanted_mode", f"{mode.lower()}: {map_name}")

	# Sauna Tent presence (roster OR alt). Alt-only games are legitimate.
	sauna_by_team: dict[int, int] = {}
	for p in players:
		t = p.get("m_toon", {})
		toon_key = f"{t.get('m_region')}-{t.get('m_realm')}-{t.get('m_id')}"
		if toon_key in sauna_toons:
			team = p.get("m_teamId", -1)
			sauna_by_team[team] = sauna_by_team.get(team, 0) + 1

	if not sauna_by_team:
		return (False, "no_sauna_player", map_name)

	# Custom games require a full 5-stack. Alts count toward the stack to match
	# the party-detection rule in pipeline/run.py.
	if mode in ("CustomDraft", "CustomStandard"):
		max_on_team = max(sauna_by_team.values())
		if max_on_team < 5:
			return (False, "custom_no_5stack", f"{map_name} (max {max_on_team} Sauna Tent on one team)")

	return (True, mode, "ok")


def scan_replays(replay_dir: str) -> tuple[
	dict[str, list[tuple[str, str]]],
	dict[str, int],
	int,
]:
	"""Scan all replays and classify them.

	Returns (by_category, accepted_modes, total) where by_category maps
	category -> [(path, detail)] and accepted_modes counts accepted game modes.
	"""
	replays = find_replays(replay_dir)
	total = len(replays)

	sauna_toons = _load_sauna_toons()
	cutoff_date = _load_cutoff_date()
	seen_fingerprints: dict[str, str] = {}
	by_category: dict[str, list[tuple[str, str]]] = {}
	accepted_modes: Counter = Counter()
	start = time.monotonic()
	last_report = start

	for i, path in enumerate(replays):
		accepted, category, detail = check_replay(path, sauna_toons, seen_fingerprints, cutoff_date)
		if accepted:
			accepted_modes[category] += 1
		else:
			by_category.setdefault(category, []).append((path, detail))

		now = time.monotonic()
		if now - last_report >= 5:
			checked = i + 1
			elapsed = now - start
			rate = checked / elapsed
			remaining = (total - checked) / rate if rate > 0 else 0
			rejected = sum(len(v) for v in by_category.values())
			print(f"  [{checked}/{total}] {rejected} rejected "
				f"({rate:.0f}/s, ~{remaining:.0f}s left)", flush=True)
			last_report = now

	elapsed = time.monotonic() - start
	print(f"  Scanned {total} files in {elapsed:.1f}s")

	return by_category, accepted_modes, total


def remove_replays(replay_dir: str) -> int:
	"""Scan replays, present results by category, prompt for removal per category."""
	replays = find_replays(replay_dir)
	total = len(replays)
	if total == 0:
		print("No replay files found.")
		return 0

	print(f"Scanning {total} replay files...")
	by_category, accepted_modes, total = scan_replays(replay_dir)

	rejected_total = sum(len(v) for v in by_category.values())
	accepted_total = total - rejected_total

	# Summary
	print(f"\nResults:")
	print(f"  Total files: {total}")
	print(f"  Accepted:    {accepted_total}")
	for mode, count in accepted_modes.most_common():
		print(f"    {mode}: {count}")
	print(f"  Rejected:    {rejected_total}")

	if not by_category:
		print("\nNo unwanted replays found.")
		return 0

	# Breakdown by category
	print(f"\nBreakdown:")
	for cat in _CATEGORY_ORDER:
		if cat not in by_category:
			continue
		entries = by_category[cat]
		label = _CATEGORY_LABELS.get(cat, cat)
		if cat == "unparseable":
			print(f"  {label}: {len(entries)} (not removable)")
		else:
			print(f"  {label}: {len(entries)}")

	# Flag unparseable files
	unparseable = by_category.get("unparseable", [])
	if unparseable:
		print(f"\nFailed to parse ({len(unparseable)}):")
		for path, detail in unparseable:
			print(f"  {os.path.basename(path)}: {detail}")

	# Prompt per removable category
	removable = [cat for cat in _CATEGORY_ORDER if cat != "unparseable" and cat in by_category]
	if not removable:
		print("\nNo removable categories found.")
		return 0

	deleted = 0
	for cat in removable:
		entries = by_category[cat]
		label = _CATEGORY_LABELS.get(cat, cat)
		print(f"\n{label} ({len(entries)} files):")
		for path, detail in entries[:10]:
			print(f"  {os.path.basename(path)} ({detail})")
		if len(entries) > 10:
			print(f"  ... and {len(entries) - 10} more")

		answer = input(f"Remove {len(entries)} {label.lower()}? [y/N] ").strip().lower()
		if answer == "y":
			for path, _detail in entries:
				os.remove(path)
				deleted += 1
			print(f"  Removed {len(entries)} files.")
		else:
			print(f"  Skipped.")

	if deleted:
		remaining = total - deleted
		print(f"\nRemoved {deleted} files total. {remaining} replays remaining.")
	else:
		print(f"\nNo files removed.")

	return deleted


def main():
	import argparse
	parser = argparse.ArgumentParser(description="Scan and remove unwanted HotS replay files")
	parser.add_argument("--replay-dir",
		default=os.path.join(_PROJECT_ROOT, "replays"),
		help="Directory containing replay files")
	args = parser.parse_args()

	if not os.path.isdir(args.replay_dir):
		print(f"Replay directory not found: {args.replay_dir}", file=sys.stderr)
		sys.exit(1)

	remove_replays(args.replay_dir)


if __name__ == "__main__":
	main()
