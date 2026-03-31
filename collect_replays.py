# Collects .StormReplay files from the HotS documents folder into the project's
# replay directory. Copies new files, skips duplicates by filename.
# Usage: python collect_replays.py [--source path] [--dest path]

import argparse
import os
import shutil
import sys

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# Default HotS replay location on Windows
DEFAULT_SOURCE = os.path.join(
	os.environ.get("USERPROFILE", os.path.expanduser("~")),
	"Documents", "Heroes of the Storm", "Accounts"
)
DEFAULT_DEST = os.path.join(PROJECT_ROOT, "replays")


def find_replays(source_dir: str) -> list[str]:
	"""Recursively find all .StormReplay files under source_dir."""
	replays = []
	for root, _dirs, files in os.walk(source_dir):
		for f in files:
			if f.lower().endswith(".stormreplay"):
				replays.append(os.path.join(root, f))
	return replays


def collect(source_dir: str, dest_dir: str) -> tuple[int, int, int]:
	"""Copy new replays from source to destination.

	Deduplicates by filename (case-insensitive). HotS replay filenames
	contain unique identifiers, so filename matching is sufficient.

	Returns (found, copied, skipped).
	"""
	os.makedirs(dest_dir, exist_ok=True)

	existing = set()
	for f in os.listdir(dest_dir):
		if f.lower().endswith(".stormreplay"):
			existing.add(f.lower())

	replays = find_replays(source_dir)
	copied = 0
	skipped = 0

	for path in replays:
		filename = os.path.basename(path)
		if filename.lower() in existing:
			skipped += 1
			continue

		dest_path = os.path.join(dest_dir, filename)
		shutil.copy2(path, dest_path)
		existing.add(filename.lower())
		copied += 1

	return len(replays), copied, skipped


def main() -> None:
	parser = argparse.ArgumentParser(
		description="Collect HotS replay files into the project replay directory"
	)
	parser.add_argument(
		"--source", default=DEFAULT_SOURCE,
		help="Source directory to search for replays (default: HotS documents folder)"
	)
	parser.add_argument(
		"--dest", default=DEFAULT_DEST,
		help="Destination directory for collected replays (default: project replays/)"
	)
	args = parser.parse_args()

	if not os.path.isdir(args.source):
		print(f"Source directory not found: {args.source}", file=sys.stderr)
		sys.exit(1)

	print(f"Source: {args.source}")
	print(f"Destination: {args.dest}")
	print()

	found, copied, skipped = collect(args.source, args.dest)

	print(f"Found:   {found}")
	print(f"Copied:  {copied}")
	print(f"Skipped: {skipped} (already exist)")


if __name__ == "__main__":
	main()
