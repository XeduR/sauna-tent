# Toxicity detection for in-game chat messages.
# Loads keywords from toxic_keywords.txt and checks messages via substring matching.

import os

_KEYWORDS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toxic_keywords.txt")
_keywords: list[str] = []


def _load_keywords() -> None:
	"""Load toxic keywords from the config file (once)."""
	global _keywords
	if _keywords:
		return
	if not os.path.isfile(_KEYWORDS_FILE):
		return
	with open(_KEYWORDS_FILE, "r", encoding="utf-8") as f:
		for line in f:
			word = line.strip().lower()
			if word and not word.startswith("#"):
				_keywords.append(word)


def is_toxic(message: str) -> bool:
	"""Check if a chat message contains any toxic keyword (case-insensitive)."""
	_load_keywords()
	if not _keywords:
		return False
	text = message.lower()
	for keyword in _keywords:
		if keyword in text:
			return True
	return False
