# Shared utilities for replay file operations.

import os


def find_replays(replay_dir: str) -> list[str]:
	"""Find all .StormReplay files in a directory (recursive, sorted)."""
	replays = []
	for root, _dirs, files in os.walk(replay_dir):
		for f in files:
			if f.lower().endswith(".stormreplay"):
				replays.append(os.path.join(root, f))
	replays.sort()
	return replays
