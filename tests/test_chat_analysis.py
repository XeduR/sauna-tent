import unittest

from pipeline.parser import _LOOPS_PER_SECOND, _apply_chat_analysis

GAME_END = 1200 * _LOOPS_PER_SECOND


def _players() -> list[dict]:
	return [
		{"team": 0, "result": "win", "stats": {}},
		{"team": 1, "result": "loss", "stats": {}},
	]


def _gg(player: int, seconds_from_end: float, text: str = "gg") -> dict:
	return {
		"playerIndex": player,
		"gameloop": GAME_END + int(seconds_from_end * _LOOPS_PER_SECOND),
		"text": text,
		"recipient": 0,
	}


def _flagged(players: list[dict]) -> list[int]:
	return [i for i, p in enumerate(players) if p["stats"].get("chatOffensiveGg")]


class OffensiveGgTests(unittest.TestCase):
	def test_lounge_draft_game_flags_early_gg(self):
		players = _players()
		_apply_chat_analysis(players, [_gg(1, -40)], GAME_END, GAME_END, "CustomDraft")

		self.assertEqual(_flagged(players), [1])

	def test_gg_after_core_death_is_not_early_despite_long_score_screen(self):
		players = _players()
		records = [_gg(1, 2), _gg(0, 3)]
		_apply_chat_analysis(players, records, GAME_END + 40 * _LOOPS_PER_SECOND, GAME_END, "CustomDraft")

		self.assertEqual(_flagged(players), [])

	def test_winner_gg_before_loser_gg_is_premature(self):
		players = _players()
		records = [_gg(0, -5), _gg(1, 1)]
		_apply_chat_analysis(players, records, GAME_END, GAME_END, "CustomDraft")

		self.assertEqual(_flagged(players), [0])

	def test_ranked_game_never_flags(self):
		players = _players()
		_apply_chat_analysis(players, [_gg(1, -40)], GAME_END, GAME_END, "StormLeague")

		self.assertEqual(_flagged(players), [])

	def test_custom_game_without_game_end_raises(self):
		with self.assertRaises(ValueError):
			_apply_chat_analysis(_players(), [_gg(1, -40)], GAME_END, None, "CustomDraft")


if __name__ == "__main__":
	unittest.main()
