# Batch replay processor with manifest-based incremental processing.
# Scans replay directory, processes new/changed files, skips unchanged ones.
# Usage: python -m pipeline.batch [--config path] [--output-dir dir] [--manifest path] [--reprocess] [--pretty] [--generate]

import argparse
import hashlib
import json
import os
import sys
import time

from pipeline.run import load_config, process_single, PROJECT_ROOT, DEFAULT_CONFIG_PATH
from pipeline.update_protocols import update_protocols
from pipeline.aggregate import load_matches, aggregate_all
from pipeline.output import write_output
from remove_replays import remove_replays

DEFAULT_MANIFEST_PATH = os.path.join(PROJECT_ROOT, "manifest.json")

# Approximate processing rates (replays/second) for time estimation.
# Based on observed throughput; actual rates vary by machine.
_RATE_SCAN = 10
_RATE_PROCESS = 2.2
_TIME_GENERATE = 15


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


def _estimate_step(count, rate):
	"""Estimate step duration from replay count and rate."""
	return count / rate if rate > 0 else 0


def _config_hash(config: dict) -> str:
	"""Hash the roster + alts + cutoffDate config fields.

	Changes to roster, alts, or the cutoff date trigger reprocessing.
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
		for chunk in iter(lambda: f.read(8192), b""):
			h.update(chunk)
	return h.hexdigest()[:16]


def _scan_replays(replay_dir: str) -> list[str]:
	"""Recursively find all .StormReplay files (case-insensitive extension)."""
	replays = []
	for root, _dirs, files in os.walk(replay_dir):
		for f in files:
			if f.lower().endswith(".stormreplay"):
				replays.append(os.path.join(root, f))
	replays.sort()
	return replays


def load_manifest(manifest_path: str) -> dict:
	"""Load the processing manifest, or return a fresh one."""
	if os.path.isfile(manifest_path):
		with open(manifest_path, "r", encoding="utf-8") as f:
			return json.load(f)
	return {"configHash": None, "files": {}}


def save_manifest(manifest: dict, manifest_path: str) -> None:
	"""Write the manifest to disk."""
	parent = os.path.dirname(manifest_path)
	if parent:
		os.makedirs(parent, exist_ok=True)
	with open(manifest_path, "w", encoding="utf-8") as f:
		json.dump(manifest, f, indent=2, ensure_ascii=False)


def process_replays(
	config: dict,
	output_dir: str | None = None,
	manifest_path: str = DEFAULT_MANIFEST_PATH,
	force_reprocess: bool = False,
	pretty: bool = False,
	pipeline_start: float | None = None,
	generate_after: bool = False,
) -> dict:
	"""Parse replay files and write per-match JSON.

	Returns a stats dict with counts of processed, skipped, failed, total.
	"""
	replay_dir = os.path.join(PROJECT_ROOT, config["replayDirectory"])
	if not os.path.isdir(replay_dir):
		raise FileNotFoundError(f"Replay directory not found: {replay_dir}")

	manifest = load_manifest(manifest_path)
	current_config_hash = _config_hash(config)

	config_changed = manifest["configHash"] != current_config_hash
	if config_changed and not force_reprocess:
		print(f"  Config changed ({manifest['configHash']} -> {current_config_hash}), reprocessing all")
	if force_reprocess:
		print("  Forced reprocess: all replays will be processed")

	needs_full_reprocess = config_changed or force_reprocess
	if needs_full_reprocess:
		manifest["files"] = {}

	manifest["configHash"] = current_config_hash

	all_replays = _scan_replays(replay_dir)
	total = len(all_replays)

	# Purge manifest entries for replay files that no longer exist on disk
	all_replay_set = set(os.path.relpath(p, PROJECT_ROOT) for p in all_replays)
	stale_paths = [p for p in manifest["files"] if p not in all_replay_set]
	if stale_paths:
		for p in stale_paths:
			del manifest["files"][p]
		print(f"  Cleared {len(stale_paths)} stale manifest entries")

	processed = 0
	duplicates = 0
	no_sauna = 0
	skipped = 0
	failed = 0
	errors = []

	seen_match_ids = set()
	for entry in manifest["files"].values():
		mid = entry.get("matchId")
		if mid:
			seen_match_ids.add(mid)

	print(f"  {total} replay files, {len(seen_match_ids)} already in manifest")

	start_time = time.monotonic()
	last_report = start_time

	for i, replay_path in enumerate(all_replays):
		rel_path = os.path.relpath(replay_path, PROJECT_ROOT)

		content_hash = _file_content_hash(replay_path)
		existing = manifest["files"].get(rel_path)

		if existing and existing["contentHash"] == content_hash:
			skipped += 1
		else:
			try:
				match_data = process_single(replay_path, config, output_dir, pretty, seen_match_ids)
				is_dup = match_data.get("isDuplicate", False)
				has_roster = match_data.get("hasRoster", True)
				has_alt = match_data.get("hasAlt", False)
				has_sauna = has_roster or has_alt
				manifest["files"][rel_path] = {
					"contentHash": content_hash,
					"matchId": match_data["matchId"],
					"timestamp": match_data["timestamp"],
					"duplicate": is_dup,
					"noSauna": not has_sauna,
				}
				if not has_sauna:
					no_sauna += 1
				elif is_dup:
					duplicates += 1
				else:
					processed += 1
			except (ValueError, OSError) as e:
				failed += 1
				errors.append((rel_path, str(e)))

		now = time.monotonic()
		if now - last_report >= 5:
			elapsed = now - start_time
			done = processed + duplicates + no_sauna + skipped + failed
			rate = done / elapsed if elapsed > 0 else 0
			remaining = (total - done) / rate if rate > 0 else 0

			line = (f"  [{done}/{total}] {processed} new, {duplicates} dupes, "
					f"{skipped} skipped, {failed} failed ({rate:.0f}/s)")
			line += f" | Step: ~{_format_time(remaining)}"

			if pipeline_start is not None:
				pipeline_remaining = remaining + (_TIME_GENERATE if generate_after else 0)
				line += f" | Pipeline: ~{_format_time(pipeline_remaining)}"

			print(line, flush=True)
			last_report = now

	save_manifest(manifest, manifest_path)

	# Remove match JSON files not referenced by any manifest entry (noSauna matches have no output file to protect)
	out_dir = output_dir or os.path.join(PROJECT_ROOT, config["outputDirectory"])
	matches_dir = os.path.join(out_dir, "matches")
	if os.path.isdir(matches_dir):
		known_ids = {
			e["matchId"] for e in manifest["files"].values()
			if e.get("matchId") and not e.get("noSauna")
		}
		orphaned = 0
		for fname in os.listdir(matches_dir):
			if not fname.endswith(".json") or fname == "index.json":
				continue
			if fname[:-5] not in known_ids:
				os.remove(os.path.join(matches_dir, fname))
				orphaned += 1
		if orphaned:
			print(f"  Removed {orphaned} orphaned match files")

	elapsed = time.monotonic() - start_time
	unique_matches = len({e["matchId"] for e in manifest["files"].values() if e.get("matchId")})
	stats = {
		"total": total,
		"processed": processed,
		"duplicates": duplicates,
		"noSauna": no_sauna,
		"skipped": skipped,
		"failed": failed,
		"uniqueMatches": unique_matches,
		"elapsed": round(elapsed, 1),
		"errors": errors,
	}

	print(f"  Result: {processed} new, {duplicates} dupes, "
		  f"{skipped} skipped, {failed} failed in {_format_time(elapsed)}")
	if no_sauna:
		print(f"  Skipped {no_sauna} replays with no Sauna Tent players (roster or alt)")
	print(f"  Unique matches: {unique_matches}")
	if errors:
		print(f"  Failed replays ({len(errors)}):")
		for path, err in errors[:20]:
			print(f"    {path}: {err}")
		if len(errors) > 20:
			print(f"    ... and {len(errors) - 20} more")

	return stats


def generate_output(config: dict, output_dir: str | None = None, pretty: bool = False) -> dict:
	"""Run aggregation and write all dashboard JSON output files.

	Returns counts dict from write_output.
	"""
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


def main():
	parser = argparse.ArgumentParser(description="Batch process HotS replay files")
	parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Pipeline config path")
	parser.add_argument("--output-dir", default=None, help="Override output directory")
	parser.add_argument("--manifest", default=DEFAULT_MANIFEST_PATH, help="Manifest file path")
	parser.add_argument("--reprocess", action="store_true", help="Force reprocess all replays")
	parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
	parser.add_argument("--generate", action="store_true",
		help="Generate dashboard output files (aggregation + split JSON) after batch processing")
	args = parser.parse_args()

	try:
		config = load_config(args.config)
	except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
		print(f"Config error: {e}", file=sys.stderr)
		sys.exit(1)

	replay_dir = os.path.join(PROJECT_ROOT, config["replayDirectory"])
	if not os.path.isdir(replay_dir):
		print(f"Error: Replay directory not found: {replay_dir}", file=sys.stderr)
		sys.exit(1)

	pipeline_start = time.monotonic()
	total_steps = 4 if args.generate else 3

	# Initial estimate based on replay count
	initial_count = len(_scan_replays(replay_dir))
	est_scan = _estimate_step(initial_count, _RATE_SCAN)
	est_process = _estimate_step(initial_count, _RATE_PROCESS)
	est_total = est_scan + est_process
	if args.generate:
		est_total += _TIME_GENERATE

	print(f"\nPipeline: {initial_count} replays, estimated ~{_format_time(est_total)}")
	print(f"  Step 1: Update protocols  (network)")
	print(f"  Step 2: Remove replays    ~{_format_time(est_scan)}")
	print(f"  Step 3: Process replays   ~{_format_time(est_process)}")
	if args.generate:
		print(f"  Step 4: Generate output   ~{_format_time(_TIME_GENERATE)}")

	# Step 1: Update protocol files
	step_start = time.monotonic()
	print(f"\n[Step 1/{total_steps}] Updating heroprotocol")
	try:
		update_protocols()
	except Exception as e:
		print(f"  Update failed ({e}), continuing with existing protocols")
	print(f"  Step 1 done in {_format_time(time.monotonic() - step_start)}"
		  f" | Pipeline: {_format_time(time.monotonic() - pipeline_start)} elapsed")

	# Step 2: Remove unwanted replays (duplicates, wrong mode, etc.)
	step_start = time.monotonic()
	print(f"\n[Step 2/{total_steps}] Removing unwanted replays")
	remove_replays(replay_dir)
	print(f"  Step 2 done in {_format_time(time.monotonic() - step_start)}"
		  f" | Pipeline: {_format_time(time.monotonic() - pipeline_start)} elapsed")

	# Step 3: Process replays
	step_start = time.monotonic()
	print(f"\n[Step 3/{total_steps}] Processing replays")
	try:
		stats = process_replays(
			config, args.output_dir, args.manifest, args.reprocess, args.pretty,
			pipeline_start, args.generate,
		)
	except FileNotFoundError as e:
		print(f"Error: {e}", file=sys.stderr)
		sys.exit(1)
	print(f"  Step 3 done in {_format_time(time.monotonic() - step_start)}"
		  f" | Pipeline: {_format_time(time.monotonic() - pipeline_start)} elapsed")

	# Step 4: Generate dashboard output
	counts = None
	if args.generate:
		step_start = time.monotonic()
		print(f"\n[Step 4/{total_steps}] Generating dashboard")
		counts = generate_output(config, args.output_dir, args.pretty)
		print(f"  Step 4 done in {_format_time(time.monotonic() - step_start)}"
			  f" | Pipeline: {_format_time(time.monotonic() - pipeline_start)} elapsed")

	# Final summary
	total_elapsed = time.monotonic() - pipeline_start
	print(f"\n{'=' * 50}")
	print(f"Pipeline complete in {_format_time(total_elapsed)}")
	print(f"  {stats['uniqueMatches']} unique matches, {stats['failed']} failed")
	if counts:
		print(f"  Output: {counts['players']} players, {counts['heroes']} heroes, {counts['maps']} maps")


if __name__ == "__main__":
	main()
