# Identifies and removes duplicate replay files using match fingerprinting.
# Fingerprint: MD5 of sorted player IDs + randomSeed (same method as Heroes Profile / HotsLogs).
# Usage: python remove_duplicates.py [--replay-dir path]

import hashlib
import os
import sys
import time

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_PROJECT_ROOT, "tools", "heroprotocol"))

import mpyq
from heroprotocol.versions import build, latest
from replay_utils import find_replays


def match_fingerprint(path: str) -> str:
	"""MD5 of sorted player IDs + randomSeed. Compatible with Heroes Profile / HotsLogs."""
	archive = mpyq.MPQArchive(path)
	header_content = archive.header["user_data_header"]["content"]
	header = latest().decode_replay_header(header_content)
	base_build = header["m_version"]["m_baseBuild"]
	protocol = build(base_build)

	if not hasattr(protocol, "decode_replay_details"):
		raise ValueError(f"Protocol build {base_build} missing decode_replay_details")

	details = protocol.decode_replay_details(archive.read_file("replay.details"))
	player_ids = sorted(p["m_toon"]["m_id"] for p in details["m_playerList"])

	initdata = protocol.decode_replay_initdata(archive.read_file("replay.initdata"))
	random_seed = initdata["m_syncLobbyState"]["m_lobbyState"]["m_randomSeed"]

	identity = "".join(str(pid) for pid in player_ids) + str(random_seed)
	return hashlib.md5(identity.encode()).hexdigest()


def find_duplicates(replay_dir: str) -> tuple[dict[str, list[str]], list[tuple[str, str]]]:
	"""Fingerprint all replays and group by match.

	Returns (by_fingerprint, failed) where by_fingerprint maps
	fingerprint -> [paths] and failed is [(filename, error)].
	"""
	replays = find_replays(replay_dir)
	total = len(replays)

	by_fp: dict[str, list[str]] = {}
	failed = []
	start = time.monotonic()
	last_report = start

	for i, path in enumerate(replays):
		try:
			fp = match_fingerprint(path)
			by_fp.setdefault(fp, []).append(path)
		except Exception as e:
			failed.append((os.path.basename(path), str(e)))

		now = time.monotonic()
		if now - last_report >= 5:
			checked = i + 1
			elapsed = now - start
			rate = checked / elapsed
			remaining = (total - checked) / rate if rate > 0 else 0
			print(f"  [{checked}/{total}] {len(by_fp)} unique, {len(failed)} failed "
				f"({rate:.0f}/s, ~{remaining:.0f}s left)", flush=True)
			last_report = now

	elapsed = time.monotonic() - start
	print(f"  Fingerprinted {total} files in {elapsed:.1f}s")

	return by_fp, failed


def deduplicate(replay_dir: str) -> int:
	"""Find and remove duplicate replay files. Returns count removed.

	Always requires explicit user confirmation before deleting anything.
	"""
	replays = find_replays(replay_dir)
	total = len(replays)
	if total == 0:
		print("No replay files found.")
		return 0

	print(f"Scanning {total} replay files for duplicates...")
	by_fp, failed = find_duplicates(replay_dir)

	dup_groups = {fp: paths for fp, paths in by_fp.items() if len(paths) > 1}
	dup_count = sum(len(paths) - 1 for paths in dup_groups.values())
	unique = len(by_fp)

	print(f"\nResults:")
	print(f"  Total files:     {total}")
	print(f"  Parsed OK:       {total - len(failed)}")
	print(f"  Unique matches:  {unique}")
	print(f"  Duplicate files: {dup_count} (across {len(dup_groups)} matches)")
	if failed:
		print(f"  Failed to parse: {len(failed)}")
		for name, err in failed[:5]:
			print(f"    {name}: {err}")
		if len(failed) > 5:
			print(f"    ... and {len(failed) - 5} more")
		print(f"\nRemoval blocked: {len(failed)} file(s) failed to parse. Fix the errors and re-run.")
		return 0

	if dup_count == 0:
		print("No duplicates found.")
		return 0

	print(f"\nDuplicate groups:")
	shown = 0
	for fp, paths in sorted(dup_groups.items()):
		if shown >= 20:
			print(f"  ... and {len(dup_groups) - shown} more groups")
			break
		names = [os.path.basename(p) for p in paths]
		print(f"  [{len(paths)} copies] {names[0]}")
		for name in names[1:]:
			print(f"    dup: {name}")
		shown += 1

	print(f"\n{dup_count} duplicate files will be removed, leaving {unique} unique matches.")
	answer = input("Remove duplicates? [y/N] ").strip().lower()
	if answer != "y":
		print("Aborted. No files were deleted.")
		return 0

	deleted = 0
	for fp, paths in dup_groups.items():
		for p in paths[1:]:
			os.remove(p)
			deleted += 1

	print(f"Removed {deleted} duplicate files.")
	return deleted


def main():
	import argparse
	parser = argparse.ArgumentParser(description="Find and remove duplicate HotS replay files")
	parser.add_argument("--replay-dir",
		default=os.path.join(_PROJECT_ROOT, "replays"),
		help="Directory containing replay files")
	args = parser.parse_args()

	if not os.path.isdir(args.replay_dir):
		print(f"Replay directory not found: {args.replay_dir}", file=sys.stderr)
		sys.exit(1)

	deduplicate(args.replay_dir)


if __name__ == "__main__":
	main()
