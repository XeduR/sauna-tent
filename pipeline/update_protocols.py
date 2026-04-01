# Fetches the latest heroprotocol version files from the Blizzard GitHub repo.
# Only updates protocol*.py files; leaves the local __init__.py intact
# (patched for Python 3.12 compatibility).

import io
import os
import re
import tarfile
import urllib.request

_TARBALL_URL = "https://github.com/Blizzard/heroprotocol/archive/refs/heads/master.tar.gz"
_PROTOCOL_PATTERN = re.compile(r"protocol\d+\.py$")
_TARBALL_MEMBER_PATTERN = re.compile(r".*/heroprotocol/versions/protocol\d+\.py$")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSIONS_DIR = os.path.join(PROJECT_ROOT, "tools", "heroprotocol", "heroprotocol", "versions")


def _local_protocol_files() -> set[str]:
	"""Return the set of protocol filenames currently on disk."""
	return {f for f in os.listdir(VERSIONS_DIR) if _PROTOCOL_PATTERN.match(f)}


def update_protocols(quiet: bool = False) -> dict:
	"""Download and sync protocol files from the Blizzard heroprotocol repo.

	Returns a dict with keys: added (list[str]), total_local (int), total_remote (int).
	"""
	if not quiet:
		print("  Fetching heroprotocol updates...", end="", flush=True)

	req = urllib.request.Request(_TARBALL_URL)
	with urllib.request.urlopen(req, timeout=30) as resp:
		data = resp.read()

	local_before = _local_protocol_files()

	added = []
	remote_count = 0

	with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
		for member in tar.getmembers():
			if not _TARBALL_MEMBER_PATTERN.match(member.name):
				continue

			remote_count += 1
			filename = os.path.basename(member.name)

			if filename not in local_before:
				content = tar.extractfile(member)
				if content is None:
					continue
				dest = os.path.join(VERSIONS_DIR, filename)
				with open(dest, "wb") as f:
					f.write(content.read())
				added.append(filename)

	result = {
		"added": sorted(added),
		"total_local": len(local_before) + len(added),
		"total_remote": remote_count,
	}

	if not quiet:
		if added:
			print(f" +{len(added)} new protocols ({result['total_local']} total)")
			for name in result["added"]:
				print(f"    {name}")
		else:
			print(f" up to date ({result['total_local']} protocols)")

	return result
