# Scans replay files and removes unwanted ones by category.
# Combines duplicate detection and content-based filtering into a single pass.
# All replay decoding goes through the C# sidecar via parse_replay_raw.
# Usage: python remove_replays.py [--replay-dir path]

import hashlib
import json
import os
import sys
import time
from collections import Counter

from pipeline.parser import parse_replay_raw, resolve_game_mode, ensure_parser_available
from replay_utils import find_replays

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# Filter-summary cache. The classification pass spawns the C# sidecar per
# replay (~300-500 ms each), which dominates Step 1 runtime on big libraries.
# We keep a small per-file summary of the sidecar output keyed by SHA-256 of
# the file contents so subsequent runs skip the parse for unchanged replays.
_FILTER_CACHE_PATH = os.path.join(_PROJECT_ROOT, ".scratch", "replay-filter-cache.json")
_FILTER_CACHE_VERSION = 1
_CACHE_SAVE_INTERVAL = 30  # seconds between incremental writes during a scan

ACCEPTED_MODES = frozenset({"StormLeague", "CustomDraft", "ARAM"})

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
	"custom_no_5stack": "Custom without 3+ roster (or alt present)",
	"unparseable": "Failed to parse",
}

_CATEGORY_ORDER = list(_CATEGORY_LABELS.keys())


def _load_sauna_toons() -> tuple[frozenset[str], frozenset[str]]:
	"""Load roster and alt toon IDs separately from pipeline.json.

	Returns (roster_toons, alt_toons). Kept separate so custom game filtering
	can distinguish roster from alt players.
	"""
	config_path = os.path.join(_PROJECT_ROOT, "pipeline.json")
	with open(config_path, "r", encoding="utf-8") as f:
		config = json.load(f)
	roster_toons = set()
	for entry in config["roster"]:
		for toon in entry.get("toons", []):
			roster_toons.add(toon)
	alt_toons = set()
	for entry in config.get("alts", []):
		for toon in entry.get("toons", []):
			alt_toons.add(toon)
	return frozenset(roster_toons), frozenset(alt_toons)


def _load_cutoff_date() -> str | None:
	"""Load cutoff date from pipeline.json. Returns ISO date string or None."""
	config_path = os.path.join(_PROJECT_ROOT, "pipeline.json")
	with open(config_path, "r", encoding="utf-8") as f:
		config = json.load(f)
	return config.get("cutoffDate")


def _match_fingerprint(raw: dict) -> str:
	"""MD5 of sorted player profile IDs + randomSeed."""
	player_ids = sorted(
		p["toon"]["profileId"] for p in raw.get("players", [])
		if p.get("toon", {}).get("profileId") is not None
	)
	random_seed = raw.get("randomSeed", 0)
	identity = "".join(str(pid) for pid in player_ids) + str(random_seed)
	return hashlib.md5(identity.encode()).hexdigest()


def _toon_key(toon: dict) -> str:
	"""Render a C#-shaped toon dict as the 'region-realm-profile' key used in pipeline.json."""
	return f"{toon.get('region')}-{toon.get('realmId')}-{toon.get('profileId')}"


def _file_content_hash(path: str) -> str:
	"""SHA-256 of file contents, truncated to 16 hex chars for compact storage."""
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for chunk in iter(lambda: f.read(1 << 20), b""):
			h.update(chunk)
	return h.hexdigest()[:16]


def _compute_filter_config_hash(
	roster_toons: frozenset[str],
	alt_toons: frozenset[str],
	cutoff_date: str | None,
) -> str:
	"""Hash inputs that change the meaning of a cached summary.

	If the roster, alts, cutoff date, or accept/brawl lists change, every
	cache entry's verdict could shift. The hash invalidates the whole cache
	in one shot when any of these change.
	"""
	payload = {
		"version": _FILTER_CACHE_VERSION,
		"roster": sorted(roster_toons),
		"alts": sorted(alt_toons),
		"cutoff": cutoff_date or "",
		"acceptedModes": sorted(ACCEPTED_MODES),
		"brawlMaps": sorted(BRAWL_MAPS),
	}
	body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
	return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def _load_filter_cache(config_hash: str) -> dict[str, dict]:
	"""Load the on-disk cache. Returns {} on missing, malformed, or stale."""
	try:
		with open(_FILTER_CACHE_PATH, "r", encoding="utf-8") as f:
			data = json.load(f)
	except (FileNotFoundError, json.JSONDecodeError, OSError):
		return {}
	if data.get("version") != _FILTER_CACHE_VERSION:
		return {}
	if data.get("configHash") != config_hash:
		return {}
	files = data.get("files")
	if not isinstance(files, dict):
		return {}
	return files


def _save_filter_cache(config_hash: str, files: dict[str, dict]) -> None:
	"""Write the cache atomically. Creates .scratch/ if missing."""
	os.makedirs(os.path.dirname(_FILTER_CACHE_PATH), exist_ok=True)
	payload = {
		"version": _FILTER_CACHE_VERSION,
		"configHash": config_hash,
		"files": files,
	}
	tmp = _FILTER_CACHE_PATH + ".tmp"
	with open(tmp, "w", encoding="utf-8") as f:
		json.dump(payload, f, separators=(",", ":"))
	os.replace(tmp, _FILTER_CACHE_PATH)


def _summarize_raw(raw: dict) -> dict:
	"""Project the sidecar JSON down to just the fields check_replay reads.

	Storing the full raw blob would bloat the cache by 10x or more; this
	keeps cache writes small and the JSON readable when debugging.
	"""
	players = []
	for p in raw.get("players", []) or []:
		toon = p.get("toon") or {}
		players.append({
			"isComputer": bool(p.get("isComputer")),
			"toon": {
				"region": toon.get("region"),
				"realmId": toon.get("realmId"),
				"profileId": toon.get("profileId"),
			},
		})
	return {
		"timestamp": raw.get("timestamp", ""),
		"randomSeed": raw.get("randomSeed", 0),
		"isIncomplete": bool(raw.get("isIncomplete")),
		"mapLocalizedName": raw.get("mapLocalizedName", ""),
		"mapInternalId": raw.get("mapInternalId"),
		"gameMode": raw.get("gameMode") or "",
		"lobbyMode": raw.get("lobbyMode") or "",
		"players": players,
	}


def _cache_key(path: str) -> str:
	"""Project-root-relative path with forward slashes for cross-platform cache keys."""
	return os.path.relpath(path, _PROJECT_ROOT).replace("\\", "/")


def check_replay(
	path: str,
	roster_toons: frozenset[str],
	alt_toons: frozenset[str],
	seen_fingerprints: dict[str, str],
	cutoff_date: str | None = None,
	cache: dict[str, dict] | None = None,
) -> tuple[bool, str, str, bool]:
	"""Check a replay against all rejection criteria.

	Args:
		seen_fingerprints: Maps fingerprint -> first path seen. Updated in place.
		cutoff_date: ISO date string (YYYY-MM-DD). Replays before this date are rejected.
		cache: Filter-summary cache keyed by relative path. Hits skip the
			sidecar; misses update the dict in place.

	Returns (accepted, category, detail, used_cache). used_cache is True
	only when the cache provided the summary (the sidecar was skipped).
	"""
	basename = os.path.basename(path)

	# Sandbox pre-filter from filename (avoids cache lookup + sidecar parse for clearly-irrelevant replays).
	if "Sandbox" in basename:
		return (False, "unwanted_mode", f"sandbox: {basename}", False)

	summary: dict | None = None
	used_cache = False
	content_hash: str | None = None
	key = _cache_key(path) if cache is not None else ""

	if cache is not None:
		try:
			content_hash = _file_content_hash(path)
		except OSError as e:
			return (False, "unparseable", str(e), False)
		entry = cache.get(key)
		if entry is not None and entry.get("contentHash") == content_hash:
			cached_summary = entry.get("summary")
			if isinstance(cached_summary, dict):
				summary = cached_summary
				used_cache = True

	if summary is None:
		try:
			raw = parse_replay_raw(path)
		except FileNotFoundError as e:
			return (False, "unparseable", str(e), False)
		except ValueError as e:
			return (False, "unparseable", str(e), False)
		summary = _summarize_raw(raw)
		if cache is not None and content_hash is not None:
			cache[key] = {
				"contentHash": content_hash,
				"summary": summary,
			}

	# Duplicate check (before mode/content checks so dupes get a stable category)
	fp = _match_fingerprint(summary)
	first_seen = seen_fingerprints.get(fp)
	if first_seen is not None:
		return (False, "duplicate", os.path.basename(first_seen), used_cache)
	seen_fingerprints[fp] = path

	# Cutoff date
	if cutoff_date:
		timestamp = summary.get("timestamp", "")
		if timestamp:
			replay_date = timestamp[:10]
			if replay_date < cutoff_date:
				return (False, "before_cutoff", replay_date, used_cache)

	players = summary.get("players", [])

	# AI players (C# library exposes PlayerType.Computer via the isComputer flag).
	for p in players:
		if p.get("isComputer"):
			return (False, "ai_detected", "non-human player", used_cache)

	# Incomplete games (one or more players missing ScoreResult on the C# side).
	if summary.get("isIncomplete"):
		return (False, "incomplete", "unresolved score result", used_cache)

	map_name = summary.get("mapLocalizedName", "")

	# Sandbox (from map name, backup for the filename pre-filter)
	if "Sandbox" in map_name:
		return (False, "unwanted_mode", f"sandbox: {map_name}", used_cache)

	# Brawl maps
	if map_name in BRAWL_MAPS:
		return (False, "unwanted_mode", f"brawl: {map_name}", used_cache)

	mode = resolve_game_mode(summary)

	if mode not in ACCEPTED_MODES:
		return (False, "unwanted_mode", f"{mode.lower()}: {map_name}", used_cache)

	# Sauna Tent presence (roster OR alt). Alt-only games are legitimate.
	all_sauna_toons = roster_toons | alt_toons
	roster_count = 0
	alt_in_match = False
	has_sauna_player = False
	for p in players:
		toon_key = _toon_key(p.get("toon", {}))
		if toon_key in all_sauna_toons:
			has_sauna_player = True
			if toon_key in roster_toons:
				roster_count += 1
			if toon_key in alt_toons:
				alt_in_match = True

	if not has_sauna_player:
		return (False, "no_sauna_player", map_name, used_cache)

	# Custom games: 3+ roster players, no alts allowed
	if mode in ("CustomDraft", "CustomStandard"):
		if alt_in_match:
			return (False, "custom_no_5stack", f"{map_name} (alt player present)", used_cache)
		if roster_count < 3:
			return (False, "custom_no_5stack", f"{map_name} ({roster_count} roster players)", used_cache)

	return (True, mode, "ok", used_cache)


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

	roster_toons, alt_toons = _load_sauna_toons()
	cutoff_date = _load_cutoff_date()
	config_hash = _compute_filter_config_hash(roster_toons, alt_toons, cutoff_date)
	cache = _load_filter_cache(config_hash)

	# Drop entries for replays that no longer exist on disk so the cache file stays bounded.
	if cache:
		live_keys = {_cache_key(p) for p in replays}
		stale = [k for k in cache if k not in live_keys]
		for k in stale:
			del cache[k]

	initial_cache_size = len(cache)
	seen_fingerprints: dict[str, str] = {}
	by_category: dict[str, list[tuple[str, str]]] = {}
	accepted_modes: Counter = Counter()
	start = time.monotonic()
	last_report = start
	last_save = start
	cache_hits = 0
	cache_misses = 0

	for i, path in enumerate(replays):
		accepted, category, detail, used_cache = check_replay(
			path, roster_toons, alt_toons, seen_fingerprints, cutoff_date, cache,
		)
		if used_cache:
			cache_hits += 1
		else:
			cache_misses += 1

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
			print(
				f"  [{checked}/{total}] {rejected} rejected, "
				f"{cache_hits} cached / {cache_misses} fresh "
				f"({rate:.1f}/s, ~{remaining:.0f}s left)",
				flush=True,
			)
			last_report = now

		if now - last_save >= _CACHE_SAVE_INTERVAL:
			_save_filter_cache(config_hash, cache)
			last_save = now

	_save_filter_cache(config_hash, cache)

	elapsed = time.monotonic() - start
	print(
		f"  Scanned {total} files in {elapsed:.1f}s "
		f"(cache: {cache_hits} hit / {cache_misses} fresh, "
		f"started with {initial_cache_size} entries)"
	)

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

	# Verify the C# parser sidecar is available before doing any work.
	ensure_parser_available()

	remove_replays(args.replay_dir)


if __name__ == "__main__":
	main()
