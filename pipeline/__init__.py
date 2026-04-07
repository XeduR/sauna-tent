# HotS replay processing pipeline

import subprocess
import sys


def _check_dependencies():
	"""Check required third-party packages and offer to install missing ones."""
	missing = []
	for package in ("mpyq", "six"):
		try:
			__import__(package)
		except ImportError:
			missing.append(package)

	if not missing:
		return

	names = ", ".join(missing)

	if not sys.stdin.isatty():
		raise ImportError(
			f"Required packages not installed: {names}. "
			f"Install with: pip install {' '.join(missing)}"
		)

	answer = input(f"Required packages not installed: {names}. Install them? [y/n]: ").strip().lower()
	if answer == "y":
		subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing)
		print()
	else:
		print(f"Pipeline requires {names} to run. Exiting.")
		sys.exit(1)


_check_dependencies()
