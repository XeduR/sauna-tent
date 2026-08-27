# Batch replay processor. Classifies and parses new/changed replays in a single
# pass, writing per-match JSON. The committed data/matches/*.json files are the
# canonical registry of processed matches; manifest.json is a purely local
# performance cache (content hash -> classification / matchId) and is never
# allowed to delete a committed match file.
#
# Subcommands:
#   process       Classify + parse new replays, write match JSON (default)
#   retag         Re-derive roster/alt tags on every committed match in place
#   remove-match  Delete one match from data/matches/
#
# Usage:
#   python -m pipeline.batch process [--reprocess] [--generate] [--pretty]
#                                    [--ci] [--summary-out PATH]
#   python -m pipeline.batch retag [--pretty]
#   python -m pipeline.batch remove-match <matchId>

import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter

from pipeline.run import (
	load_config, tag_players, write_match, write_match_archive, archive_path,
	generate_match_id, PROJECT_ROOT, DEFAULT_CONFIG_PATH, DEFAULT_ARCHIVE_DIR,
)
from pipeline.parser import ensure_parser_available, parse_replay_raw, analyze_raw, resolve_game_mode
from replay_utils import find_replays

DEFAULT_MANIFEST_PATH = os.path.join(PROJECT_ROOT, "manifest.json")

# Cache schema version. Bumped when the entry shape changes so a stale manifest
# is migrated rather than trusted blindly.
MANIFEST_VERSION = 2

# Accepted game modes (post-resolution). Everything else is rejected as unwanted.
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

# Rejection category -> display label, in presentation order. "duplicate" is
# reported separately from the other reasons (it is not a data-quality reject).
_REJECTION_LABELS = {
	"duplicate": "Duplicate (match already processed)",
	"removed": "Removed (tombstoned)",
	"before_cutoff": "Before cutoff date",
	"unwanted_mode": "Unwanted game mode",
	"ai_detected": "AI players detected",
	"incomplete": "Incomplete games",
	"no_sauna_player": "No Sauna Tent player",
	"custom_no_5stack": "Custom without 3+ roster (or alt present)",
	"unparseable": "Failed to parse",
}


def _format_time(seconds):
	"""Format seconds as a human-readable duration."""
	seconds = max(0, int(seconds))
	if seconds < 60:
		return f"{seconds}s"
	m, s = divmod(seconds, 60)
	if m < 60:
		return f"{m}m {s:02d}s"
	h, m = divmod(m, 60)
	return f"{h}h {m:02d}m {s:02d}s"


def _config_hash(config: dict) -> str:
	"""Hash the roster + alts + cutoffDate config fields.

	A change here means committed matches carry stale roster/alt tags (or the
	cutoff moved); the pipeline prints guidance to run `retag` rather than
	reprocessing replays.
	"""
	hashable = {
		"roster": config.get("roster", []),
		"alts": config.get("alts", []),
		"cutoffDate": config.get("cutoffDate"),
	}
	raw = json.dumps(hashable, sort_keys=True, ensure_ascii=True)
	return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _file_content_hash(path: str) -> str:
	"""SHA-256 content hash of a file, truncated to 16 hex chars."""
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for chunk in iter(lambda: f.read(1 << 20), b""):
			h.update(chunk)
	return h.hexdigest()[:16]


def _cache_key(path: str) -> str:
	"""Project-root-relative path with forward slashes (cross-platform cache key)."""
	return os.path.relpath(path, PROJECT_ROOT).replace("\\", "/")


def _toon_key(toon: dict) -> str:
	"""Render a toon dict as the 'region-realm-profile' key used in pipeline.json."""
	return f"{toon.get('region')}-{toon.get('realmId')}-{toon.get('profileId')}"


def _load_sauna_toons(config: dict) -> tuple[frozenset[str], frozenset[str]]:
	"""Return (roster_toons, alt_toons) from config. Kept separate so custom-game
	filtering can distinguish roster from alt players."""
	roster = set()
	for member in config.get("roster", []):
		for toon in member.get("toons", []):
			roster.add(toon)
	alts = set()
	for member in config.get("alts", []):
		for toon in member.get("toons", []):
			alts.add(toon)
	return frozenset(roster), frozenset(alts)


def _migrate_manifest(data: dict) -> dict:
	"""Return a current-schema manifest, migrating a legacy one in place.

	Legacy manifests (pre-v2) used OS-native path keys (Windows backslashes on
	the machine that wrote the committed checkout) and stored duplicate/noSauna
	booleans instead of a status/reason. Both are normalised here so a Linux run
	reuses the cache instead of silently reprocessing every replay.
	"""
	files = data.get("files", {})

	if data.get("version") == MANIFEST_VERSION:
		# Already current; still normalise keys defensively (idempotent).
		data["files"] = {k.replace("\\", "/"): v for k, v in files.items()}
		return data

	migrated: dict[str, dict] = {}
	for key, value in files.items():
		norm_key = key.replace("\\", "/")
		entry = {"contentHash": value.get("contentHash")}
		if value.get("matchId"):
			entry["matchId"] = value["matchId"]
		if value.get("timestamp"):
			entry["timestamp"] = value["timestamp"]
		if value.get("duplicate"):
			entry["status"] = "rejected"
			entry["reason"] = "duplicate"
		elif value.get("noSauna"):
			entry["status"] = "rejected"
			entry["reason"] = "no_sauna_player"
		else:
			entry["status"] = "accepted"
		migrated[norm_key] = entry

	return {
		"version": MANIFEST_VERSION,
		"configHash": data.get("configHash"),
		"files": migrated,
	}


def load_manifest(manifest_path: str) -> dict:
	"""Load the cache manifest, migrating a legacy schema, or return a fresh one."""
	if not os.path.isfile(manifest_path):
		return {"version": MANIFEST_VERSION, "configHash": None, "files": {}}
	with open(manifest_path, "r", encoding="utf-8") as f:
		data = json.load(f)
	return _migrate_manifest(data)


def save_manifest(manifest: dict, manifest_path: str) -> None:
	"""Write the manifest to disk."""
	manifest["version"] = MANIFEST_VERSION
	parent = os.path.dirname(manifest_path)
	if parent:
		os.makedirs(parent, exist_ok=True)
	with open(manifest_path, "w", encoding="utf-8") as f:
		json.dump(manifest, f, indent=2, ensure_ascii=False)


# Legacy dotted time separator in committed timestamps, e.g. 2024-05-24T19.12.17.
# New parses emit ISO colons; the two must not be mixed in one dataset.
_DOTTED_TS_RE = re.compile(r"T\d\d\.\d\d\.\d\d")


def _committed_has_dotted_timestamps(matches_dir: str, sample_limit: int = 50) -> bool:
	"""Sample committed match files for the legacy dotted timestamp format.

	The committed dataset was written on a `fi-FI` machine and carries dotted
	times; a pre-backfill dataset is entirely dotted, so a bounded sample detects
	the state cheaply. Used only to warn about mixed-format appends.
	"""
	if not os.path.isdir(matches_dir):
		return False
	checked = 0
	for fname in os.listdir(matches_dir):
		if not fname.endswith(".json") or fname == "index.json":
			continue
		try:
			with open(os.path.join(matches_dir, fname), "r", encoding="utf-8") as f:
				timestamp = json.load(f).get("timestamp", "")
		except (OSError, json.JSONDecodeError):
			continue
		if _DOTTED_TS_RE.search(timestamp):
			return True
		checked += 1
		if checked >= sample_limit:
			break
	return False


def _seed_seen_match_ids(matches_dir: str) -> set[str]:
	"""Seed the dedup set from the canonical registry: committed match filenames.

	Each committed file is named <matchId>.json, so the filename set IS the set
	of matches already on record. This is the source of truth, not the manifest.
	"""
	seen: set[str] = set()
	if not os.path.isdir(matches_dir):
		return seen
	for fname in os.listdir(matches_dir):
		if fname.endswith(".json") and fname != "index.json":
			seen.add(fname[:-5])
	return seen


def _removed_matches_path(out_dir: str) -> str:
	"""Path to the committed tombstone registry."""
	return os.path.join(out_dir, "removed-matches.json")


def _load_removed_ids(out_dir: str) -> set[str]:
	"""Load tombstoned match IDs. These are matches an operator explicitly removed;
	they must never be re-created from a replay. Accepts a plain JSON array (the
	format written by remove-match) or {"removed": [...]}. Missing -> empty.

	An unreadable registry aborts the run: silently treating it as empty would
	let tombstoned matches come back, and the next remove-match would overwrite
	the file with a single id, discarding every prior tombstone.
	"""
	path = _removed_matches_path(out_dir)
	if not os.path.isfile(path):
		return set()
	try:
		with open(path, "r", encoding="utf-8") as f:
			data = json.load(f)
	except (json.JSONDecodeError, OSError) as e:
		raise SystemExit(f"ERROR: cannot read the tombstone registry {path}: {e}")
	if isinstance(data, list):
		return set(data)
	if isinstance(data, dict):
		return set(data.get("removed", []))
	raise SystemExit(
		f"ERROR: tombstone registry {path} must be a JSON array (or an object with a "
		f"'removed' array), got {type(data).__name__}."
	)


def classify_replay(
	raw: dict,
	roster_toons: frozenset[str],
	alt_toons: frozenset[str],
	cutoff_date: str | None,
	seen_match_ids: set[str],
	match_id: str,
	removed_ids: frozenset[str] | set[str] = frozenset(),
) -> tuple[bool, str]:
	"""Classify a raw sidecar dict against every acceptance rule.

	Returns (accepted, reason). On accept, reason is the resolved game mode.
	On reject, reason is a category from _REJECTION_LABELS. Only matches already
	on record are "duplicate"; a second copy of an otherwise-rejected match keeps
	that match's actual reject reason.
	"""
	# Tombstone: an operator removed this match; never re-create it.
	if match_id in removed_ids:
		return (False, "removed")

	# Duplicate: this match is already on record (registry or earlier this run).
	if match_id in seen_match_ids:
		return (False, "duplicate")

	# Cutoff date (compare the date portion; time separator is culture-dependent).
	if cutoff_date:
		timestamp = raw.get("timestamp", "")
		if timestamp and timestamp[:10] < cutoff_date:
			return (False, "before_cutoff")

	players = raw.get("players", [])

	# AI players (library exposes PlayerType.Computer via isComputer).
	for p in players:
		if p.get("isComputer"):
			return (False, "ai_detected")

	# Incomplete games (one or more players missing a ScoreResult).
	if raw.get("isIncomplete"):
		return (False, "incomplete")

	map_name = raw.get("mapLocalizedName", "")

	# Sandbox (from map name) and brawl-only maps.
	if "Sandbox" in map_name:
		return (False, "unwanted_mode")
	if map_name in BRAWL_MAPS:
		return (False, "unwanted_mode")

	mode = resolve_game_mode(raw)
	if mode not in ACCEPTED_MODES:
		return (False, "unwanted_mode")

	# Sauna Tent presence (roster OR alt). Alt-only games are legitimate.
	all_sauna_toons = roster_toons | alt_toons
	roster_count = 0
	alt_in_match = False
	has_sauna_player = False
	for p in players:
		key = _toon_key(p.get("toon", {}))
		if key in all_sauna_toons:
			has_sauna_player = True
			if key in roster_toons:
				roster_count += 1
			if key in alt_toons:
				alt_in_match = True

	if not has_sauna_player:
		return (False, "no_sauna_player")

	# Custom games: require 3+ roster players and no alts.
	if mode in ("CustomDraft", "CustomStandard"):
		if alt_in_match or roster_count < 3:
			return (False, "custom_no_5stack")

	return (True, mode)


def process_replays(
	config: dict,
	output_dir: str | None = None,
	manifest_path: str = DEFAULT_MANIFEST_PATH,
	force_reprocess: bool = False,
	pretty: bool = False,
	non_interactive: bool = False,
	archive_dir: str | None = None,
) -> dict:
	"""Classify + parse new/changed replays in a single pass and write match JSON.

	Returns a stats dict (processed, duplicates, skipped, rejected-by-reason,
	newMatchIds, ...). Never deletes a committed match file.
	"""
	replay_dir = os.path.join(PROJECT_ROOT, config["replayDirectory"])
	out_dir = output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
	matches_dir = os.path.join(out_dir, "matches")
	archive_dir = archive_dir or DEFAULT_ARCHIVE_DIR

	manifest = load_manifest(manifest_path)
	current_hash = _config_hash(config)
	stored_hash = manifest.get("configHash")

	if force_reprocess:
		print("  Forced reprocess: clearing cache; re-deriving from replays present on disk")
		manifest["files"] = {}
	elif stored_hash is not None and stored_hash != current_hash:
		# A config change does not touch the cache or reprocess replays. The
		# committed matches are canonical; re-derive their tags with `retag`.
		print(f"  Config changed ({stored_hash} -> {current_hash}).")
		print("  Committed matches are NOT reprocessed. Run `python -m pipeline.batch retag`")
		print("  to re-derive roster/alt tags on them, then regenerate output.")
		print("  New replays below are classified with the current config.")
		print("  (Use --reprocess to also re-examine previously rejected replays.)")
	manifest["configHash"] = current_hash

	files = manifest["files"]
	roster_toons, alt_toons = _load_sauna_toons(config)
	cutoff_date = config.get("cutoffDate")
	removed_ids = _load_removed_ids(out_dir)

	# Dedup seed: the canonical registry, not the cache. Reprocess starts empty
	# so every present replay rewrites its own match file. Tombstoned ids are
	# always seeded as seen so a removed match can never come back, even under
	# --reprocess or a re-uploaded overlapping replay.
	registry_ids = _seed_seen_match_ids(matches_dir)
	seen_match_ids = set(removed_ids) if force_reprocess else (registry_ids | removed_ids)

	# Detected before any new (ISO-timestamp) match is written. A --reprocess run
	# is the atomic backfill that rewrites every match to ISO, so it never warns.
	committed_dotted = (not force_reprocess) and _committed_has_dotted_timestamps(matches_dir)

	all_replays = find_replays(replay_dir) if os.path.isdir(replay_dir) else []
	total = len(all_replays)

	# Drop cache entries for replays no longer on disk, but only when the library
	# is populated. An absent/empty replays dir must not wipe the cache, and it
	# must never delete committed match files.
	if all_replays:
		live = {_cache_key(p) for p in all_replays}
		stale = [k for k in files if k not in live]
		for k in stale:
			del files[k]
		if stale:
			print(f"  Dropped {len(stale)} cache entries for replays no longer on disk")

	if not os.path.isdir(replay_dir):
		print(f"  Replay directory absent ({replay_dir}); nothing new to process")
	elif total == 0:
		print("  Replay directory empty; nothing new to process")
	else:
		print(f"  {total} replay files; {len(registry_ids)} matches already on record")

	# The sidecar is only needed when there is something to parse. Skipping it
	# lets the pipeline run (and --generate) with replays absent and no dotnet.
	if all_replays:
		ensure_parser_available(non_interactive=non_interactive)

	processed = 0
	duplicates = 0
	skipped = 0
	rejected: Counter = Counter()
	new_match_ids: list[str] = []
	errors: list[tuple[str, str]] = []

	start_time = time.monotonic()
	last_report = start_time

	for i, replay_path in enumerate(all_replays):
		rel = _cache_key(replay_path)
		try:
			content_hash = _file_content_hash(replay_path)
		except OSError as e:
			rejected["unparseable"] += 1
			errors.append((rel, str(e)))
			continue

		existing = files.get(rel)
		if existing and existing.get("contentHash") == content_hash:
			# Unchanged file: reuse the cached verdict (never re-parsed).
			status = existing.get("status")
			mid = existing.get("matchId")
			if mid and mid in removed_ids:
				# Tombstoned since it was cached: report as removed, don't count
				# it as on-record (its match file is already gone).
				rejected["removed"] += 1
			elif status == "accepted":
				if mid:
					seen_match_ids.add(mid)
				skipped += 1
			elif existing.get("reason") == "duplicate":
				duplicates += 1
			else:
				rejected[existing.get("reason", "unparseable")] += 1
		else:
			# New or changed file: classify with a single sidecar parse.
			if "Sandbox" in os.path.basename(replay_path):
				files[rel] = {"contentHash": content_hash, "status": "rejected", "reason": "unwanted_mode"}
				rejected["unwanted_mode"] += 1
			else:
				try:
					raw = parse_replay_raw(replay_path)
				except (ValueError, FileNotFoundError) as e:
					files[rel] = {"contentHash": content_hash, "status": "rejected", "reason": "unparseable"}
					rejected["unparseable"] += 1
					errors.append((rel, str(e)))
				else:
					match_id = generate_match_id(raw)
					accepted, reason = classify_replay(
						raw, roster_toons, alt_toons, cutoff_date, seen_match_ids, match_id, removed_ids,
					)
					if accepted:
						try:
							match_data = analyze_raw(raw)
							match_data["matchId"] = match_id
							match_data["replayFile"] = os.path.basename(replay_path)
							tag_players(match_data, config)
							write_match(match_data, out_dir, pretty)
							# Tier-2: full extract archived at the repo-root archive
							# dir, so the replay becomes disposable.
							write_match_archive(raw, match_id, os.path.basename(replay_path), archive_dir)
						except (ValueError, KeyError, OSError) as e:
							# A replay that classified as accepted but fails analysis/write
							# is recorded as unparseable so one bad file cannot abort the run.
							files[rel] = {"contentHash": content_hash, "status": "rejected", "reason": "unparseable"}
							rejected["unparseable"] += 1
							errors.append((rel, str(e)))
						else:
							seen_match_ids.add(match_id)
							files[rel] = {
								"contentHash": content_hash,
								"matchId": match_id,
								"timestamp": match_data.get("timestamp", ""),
								"status": "accepted",
							}
							processed += 1
							new_match_ids.append(match_id)
					else:
						files[rel] = {
							"contentHash": content_hash,
							"matchId": match_id,
							"status": "rejected",
							"reason": reason,
						}
						if reason == "duplicate":
							duplicates += 1
						else:
							rejected[reason] += 1

		now = time.monotonic()
		if now - last_report >= 5:
			elapsed = now - start_time
			done = i + 1
			rate = done / elapsed if elapsed > 0 else 0
			remaining = (total - done) / rate if rate > 0 else 0
			print(
				f"  [{done}/{total}] {processed} new, {duplicates} dupes, "
				f"{skipped} skipped, {sum(rejected.values())} rejected "
				f"({rate:.0f}/s, ~{_format_time(remaining)} left)",
				flush=True,
			)
			last_report = now

	save_manifest(manifest, manifest_path)

	# Report the count from the actual committed match files, not the dedup set
	# (which also holds tombstones and cache-skip re-adds). Files are the registry.
	on_record = len(_seed_seen_match_ids(matches_dir))

	elapsed = time.monotonic() - start_time
	stats = {
		"total": total,
		"processed": processed,
		"duplicates": duplicates,
		"skipped": skipped,
		"rejected": dict(rejected),
		"newMatchIds": new_match_ids,
		"uniqueMatches": on_record,
		"elapsedSeconds": round(elapsed, 1),
		"errors": errors,
	}

	print(
		f"  Result: {processed} new, {duplicates} dupes, {skipped} skipped, "
		f"{sum(rejected.values())} rejected in {_format_time(elapsed)}"
	)
	if rejected:
		for reason, count in sorted(rejected.items()):
			label = _REJECTION_LABELS.get(reason, reason)
			print(f"    {label}: {count}")
	print(f"  Matches on record: {on_record}")
	if errors:
		print(f"  Parse failures ({len(errors)}):")
		for path, err in errors[:20]:
			print(f"    {path}: {err}")
		if len(errors) > 20:
			print(f"    ... and {len(errors) - 20} more")

	if committed_dotted and processed > 0:
		bar = "!" * 66
		print(f"\n  {bar}")
		print(f"  TIMESTAMP FORMAT WARNING: appended {processed} match(es) with ISO colon")
		print("  timestamps (2024-05-24T19:12:17) into a dataset whose committed matches")
		print("  still use the legacy dotted format (2024-05-24T19.12.17). Mixed formats")
		print("  break full-string timestamp comparisons in aggregation, output, and the")
		print("  frontend. Incremental appends before the backfill are unsupported: run the")
		print("  one-time atomic backfill to rewrite every match to ISO (all replays must")
		print("  be present on disk):")
		print("    python -m pipeline.batch process --reprocess --generate")
		print(f"  {bar}")

	return stats


def generate_output(config: dict, output_dir: str | None = None, pretty: bool = False) -> dict:
	"""Run aggregation and write all dashboard JSON output files.

	Imports the aggregate/output modules lazily so `process` (without
	--generate), `retag`, and `remove-match` do not depend on them.
	"""
	from pipeline.aggregate import load_matches, aggregate_all
	from pipeline.output import write_output

	out_dir = output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
	matches_dir = os.path.join(out_dir, "matches")

	print("  Loading matches...", flush=True)
	t0 = time.monotonic()
	matches = load_matches(matches_dir)
	print(f"  Loaded {len(matches)} matches ({_format_time(time.monotonic() - t0)})")

	if not matches:
		print("  No matches to aggregate. Run batch processing first.")
		return {"summary": 0, "roster": 0, "players": 0, "heroes": 0, "maps": 0, "matchIndex": 0}

	print("  Aggregating stats...", flush=True)
	t1 = time.monotonic()
	aggregates = aggregate_all(
		matches,
		config["roster"],
		config.get("cutoffDate"),
		alts=config.get("alts", []),
	)
	print(f"  Aggregated ({_format_time(time.monotonic() - t1)})")

	print("  Writing output files...", flush=True)
	t2 = time.monotonic()
	counts = write_output(aggregates, out_dir, config, pretty)
	print(f"  Written: {counts['players']} players, {counts['heroes']} heroes, "
		  f"{counts['maps']} maps ({_format_time(time.monotonic() - t2)})")

	return counts


def retag_matches(config: dict, output_dir: str | None = None, pretty: bool = False) -> dict:
	"""Re-derive roster/alt tags on every committed match in place.

	Reads the toon IDs stored inside each match JSON, re-applies tag_players with
	the current config, normalises replayFile to forward slashes, and rewrites the
	file. Everything needed is inside the match files, so replays are not required.
	"""
	out_dir = output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
	matches_dir = os.path.join(out_dir, "matches")
	if not os.path.isdir(matches_dir):
		print(f"No matches directory: {matches_dir}")
		return {"retagged": 0, "failed": 0}

	fnames = sorted(f for f in os.listdir(matches_dir) if f.endswith(".json") and f != "index.json")
	total = len(fnames)
	print(f"Retagging {total} matches from current pipeline.json...")

	retagged = 0
	errors: list[tuple[str, str]] = []
	indent = 2 if pretty else None
	start = time.monotonic()
	last_report = start

	for i, fname in enumerate(fnames):
		path = os.path.join(matches_dir, fname)
		try:
			with open(path, "r", encoding="utf-8") as f:
				match = json.load(f)
			tag_players(match, config)
			if "replayFile" in match:
				match["replayFile"] = match["replayFile"].replace("\\", "/")
			with open(path, "w", encoding="utf-8") as f:
				json.dump(match, f, indent=indent, ensure_ascii=False)
			retagged += 1
		except (ValueError, KeyError, OSError) as e:
			errors.append((fname, str(e)))

		now = time.monotonic()
		if now - last_report >= 5:
			print(f"  [{i + 1}/{total}] {retagged} retagged", flush=True)
			last_report = now

	print(f"  Retagged {retagged} matches in place ({_format_time(time.monotonic() - start)}).")
	if errors:
		print(f"  Failed on {len(errors)} files:")
		for fname, err in errors[:20]:
			print(f"    {fname}: {err}")
	print("  Aggregates are now stale. Regenerate with:")
	print("    python -m pipeline.batch process --generate")
	return {"retagged": retagged, "failed": len(errors)}


def remove_match(match_id: str, out_dir: str, archive_dir: str | None = None) -> bool:
	"""Delete one match's tier-1 JSON + tier-2 archive and tombstone its id.

	The id is appended to the committed removed-matches.json registry so the
	match can never be re-created by `process` or `--reprocess`, nor by a
	re-uploaded overlapping replay. Idempotent. Aggregates must be regenerated.
	"""
	archive_dir = archive_dir or DEFAULT_ARCHIVE_DIR
	path = os.path.join(out_dir, "matches", f"{match_id}.json")
	if os.path.isfile(path):
		os.remove(path)
		print(f"Removed {path}")
	else:
		print(f"No match file at {path}; tombstoning the id anyway")

	# Tier-2 archive is removed with the match; retag never touches it.
	arch = archive_path(archive_dir, match_id)
	if os.path.isfile(arch):
		os.remove(arch)
		print(f"Removed {arch}")

	removed = _load_removed_ids(out_dir)
	was_new = match_id not in removed
	removed.add(match_id)
	os.makedirs(out_dir, exist_ok=True)
	with open(_removed_matches_path(out_dir), "w", encoding="utf-8") as f:
		json.dump(sorted(removed), f, indent=2, ensure_ascii=False)
	print(f"Tombstoned {match_id} ({'added' if was_new else 'already present'}) in {_removed_matches_path(out_dir)}")
	print("To un-remove: delete its id from removed-matches.json and run `process --reprocess`.")
	print("Aggregates (data/*.json incl. matches/index.json) are now stale.")
	print("Regenerate with: python -m pipeline.batch process --generate")
	return True


def _load_config_or_exit(config_path: str) -> dict:
	try:
		return load_config(config_path)
	except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
		print(f"Config error: {e}", file=sys.stderr)
		sys.exit(1)


def _display_path(path: str) -> str:
	"""Render a path relative to the repo root when it lives under it."""
	if path == PROJECT_ROOT or path.startswith(PROJECT_ROOT + os.sep):
		return os.path.relpath(path, PROJECT_ROOT)
	return path


def _cmd_process(args) -> None:
	config = _load_config_or_exit(args.config)
	archive_dir = args.archive_dir or DEFAULT_ARCHIVE_DIR

	pipeline_start = time.monotonic()
	total_steps = 2 if args.generate else 1

	print(f"\n[Step 1/{total_steps}] Processing replays")
	stats = process_replays(
		config, args.output_dir, args.manifest, args.reprocess, args.pretty, args.ci,
		archive_dir=archive_dir,
	)

	counts = None
	if args.generate:
		print(f"\n[Step 2/{total_steps}] Generating dashboard")
		counts = generate_output(config, args.output_dir, args.pretty)

	total_elapsed = time.monotonic() - pipeline_start
	print(f"\n{'=' * 50}")
	print(f"Pipeline complete in {_format_time(total_elapsed)}")
	print(f"  {stats['processed']} new, {stats['duplicates']} dupes, "
		  f"{stats['uniqueMatches']} matches on record")
	if counts:
		print(f"  Output: {counts['players']} players, {counts['heroes']} heroes, {counts['maps']} maps")

	if args.summary_out:
		summary = {
			"processed": stats["processed"],
			"duplicates": stats["duplicates"],
			"rejected": stats["rejected"],
			"newMatchIds": stats["newMatchIds"],
			"skipped": stats["skipped"],
			"total": stats["total"],
			"uniqueMatches": stats["uniqueMatches"],
			"elapsedSeconds": stats["elapsedSeconds"],
			# Tier-2 archive written for each newly-accepted match. Paths derive
			# from archive_path(), the single source of truth for the location.
			"tier2ArchiveDir": _display_path(archive_dir),
			"tier2Archives": [
				_display_path(archive_path(archive_dir, mid)) for mid in stats["newMatchIds"]
			],
		}
		parent = os.path.dirname(os.path.abspath(args.summary_out))
		os.makedirs(parent, exist_ok=True)
		with open(args.summary_out, "w", encoding="utf-8") as f:
			json.dump(summary, f, indent=2, ensure_ascii=False)
		print(f"  Run summary written to {args.summary_out}")


def _cmd_retag(args) -> None:
	config = _load_config_or_exit(args.config)
	retag_matches(config, args.output_dir, args.pretty)


def _cmd_remove_match(args) -> None:
	config = _load_config_or_exit(args.config)
	out_dir = args.output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
	archive_dir = args.archive_dir or DEFAULT_ARCHIVE_DIR
	if not remove_match(args.matchId, out_dir, archive_dir):
		sys.exit(1)


def main():
	parser = argparse.ArgumentParser(
		prog="python -m pipeline.batch",
		description="Classify, parse, and manage HotS replay match data",
	)
	sub = parser.add_subparsers(dest="command")

	p = sub.add_parser("process", help="Classify + parse new replays, write match JSON (default)")
	p.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Pipeline config path")
	p.add_argument("--output-dir", default=None, help="Override output directory")
	p.add_argument("--manifest", default=DEFAULT_MANIFEST_PATH, help="Cache manifest path")
	p.add_argument("--reprocess", action="store_true", help="Clear the cache and re-derive from present replays")
	p.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
	p.add_argument("--generate", action="store_true", help="Aggregate + write dashboard output after processing")
	p.add_argument("--ci", action="store_true", help="Non-interactive: never prompt (auto-install sidecar)")
	p.add_argument("--summary-out", default=None, help="Write a machine-readable JSON run summary to this path")
	p.add_argument("--archive-dir", default=None, help="Override tier-2 archive directory (default: repo-root archive/)")

	r = sub.add_parser("retag", help="Re-derive roster/alt tags on every committed match in place")
	r.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Pipeline config path")
	r.add_argument("--output-dir", default=None, help="Override output directory")
	r.add_argument("--pretty", action="store_true", help="Pretty-print rewritten match JSON")

	rm = sub.add_parser("remove-match", help="Delete one match from data/matches/")
	rm.add_argument("matchId", help="Match ID (data/matches/<matchId>.json)")
	rm.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Pipeline config path")
	rm.add_argument("--output-dir", default=None, help="Override output directory")
	rm.add_argument("--archive-dir", default=None, help="Override tier-2 archive directory (default: repo-root archive/)")

	# Default to `process` when no subcommand is given, so bare invocation and
	# the old flag-only form (--reprocess --generate) still work.
	argv = sys.argv[1:]
	if not argv or argv[0] not in {"process", "retag", "remove-match", "-h", "--help"}:
		argv = ["process"] + argv
	args = parser.parse_args(argv)

	if args.command == "retag":
		_cmd_retag(args)
	elif args.command == "remove-match":
		_cmd_remove_match(args)
	else:
		_cmd_process(args)


if __name__ == "__main__":
	main()
