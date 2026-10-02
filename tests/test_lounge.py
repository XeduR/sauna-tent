import copy
import io
import json
import os
import tempfile
import unittest
import urllib.request
from datetime import datetime, timedelta, timezone
from unittest import mock

from pipeline import lounge
from pipeline.lounge import LoungeStructureError, LoungeUrlError

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "lounge")
TEAM = "ST"
CUTOFF = "2021-12-07"
MATCH_URL = "https://heroeslounge.gg/match/view/27399"
REPLAY_1 = "https://heroeslounge.gg/storage/app/uploads/public/6a9/9c1/ddc/6a99c1ddcf066862094303.stormreplay"
REPLAY_2 = "https://heroeslounge.gg/storage/app/uploads/public/6a9/9c1/f44/6a99c1f4447c2725094939.stormreplay"


def _fixture(name: str) -> str:
	with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
		return f.read()


def _page_game(n: int, map_name: str | None = "Alterac Pass", winner: str | None = "ST", replay: str | None = None, picks: int = 10) -> dict:
	return {
		"game": n,
		"map": map_name,
		"winnerSlug": winner,
		"picks": [{"hero": f"Hero{i}", "player": f"p{i}"} for i in range(picks)],
		"replayUrl": replay,
	}


def _page(match_id: int, games: list[dict], opponent: tuple = ("AH", "Apes Hunters"), scheduled: str | None = "16 Aug 2026 18:00 (UTC +00:00)") -> dict:
	return {
		"id": match_id,
		"title": "[EU] Season 30 Round 7 Division 2",
		"scheduledRaw": scheduled,
		"teams": [[TEAM, "Sauna Tent"], list(opponent)],
		"games": games,
	}


def _row(match_id: int, score: list[int] | None) -> dict:
	return {"id": match_id, "event": "[EU] Season 30 - Division 2", "score": score}


class UrlValidationTests(unittest.TestCase):
	def test_accepts_both_forms(self):
		self.assertEqual(lounge.validate_page_url("https://heroeslounge.gg/team/view/ST"), ("team", "ST"))
		self.assertEqual(lounge.validate_page_url("https://www.heroeslounge.gg/match/view/27399"), ("match", 27399))
		self.assertEqual(lounge.validate_page_url("https://HEROESLOUNGE.GG/team/view/GD!"), ("team", "GD!"))

	def test_rejects(self):
		bad = [
			"http://heroeslounge.gg/team/view/ST",
			"ftp://heroeslounge.gg/team/view/ST",
			"https://example.com/team/view/ST",
			"https://heroeslounge.gg.evil.com/team/view/ST",
			"https://evilheroeslounge.gg/team/view/ST",
			"https://sub.heroeslounge.gg/team/view/ST",
			"https://user@heroeslounge.gg/team/view/ST",
			"https://user:pw@heroeslounge.gg/team/view/ST",
			"https://heroeslounge.gg@evil.com/team/view/ST",
			"https://heroeslounge.gg:443/team/view/ST",
			"https://heroeslounge.gg:8443/match/view/1",
			"https://heroeslounge.gg:/match/view/1",
			"https://heroeslounge.gg:abc/match/view/1",
			"https://heroeslounge.gg/team/view/ST?x=1",
			"https://heroeslounge.gg/team/view/ST?",
			"https://heroeslounge.gg/team/view/ST#top",
			"https://heroeslounge.gg/team/view/ST/",
			"https://heroeslounge.gg/team/view/",
			"https://heroeslounge.gg/team/view/ST/extra",
			"https://heroeslounge.gg/teams/view/ST",
			"https://heroeslounge.gg/match/view/12a",
			"https://heroeslounge.gg/match/view/-1",
			"https://heroeslounge.gg/match/view/",
			"https://heroeslounge.gg/match/view/1/../2",
			"https://heroeslounge.gg/team/view/S%2FT/../x",
			"https://heroeslounge.gg/team/view/a b",
			"https://heroeslounge.gg/team/view/<x>",
			"https://heroeslounge.gg/",
			"heroeslounge.gg/team/view/ST",
			"",
		]

		for url in bad:
			with self.subTest(url=url), self.assertRaises(LoungeUrlError) as ctx:
				lounge.validate_page_url(url)

			self.assertIn("/team/view/<slug>", str(ctx.exception))
			self.assertIn("/match/view/<id>", str(ctx.exception))

	def test_slug(self):
		for slug in ("ST", "GD!", "a_b-c.d", "x%26y", "A&B"):
			self.assertEqual(lounge.validate_slug(slug), slug)

		for slug in ("", "a/b", "a b", "..\\x", "a\"b", "ä", "a\n"):
			with self.subTest(slug=slug), self.assertRaises(LoungeUrlError):
				lounge.validate_slug(slug)

	def test_url_builders(self):
		self.assertEqual(lounge.team_url("ST"), "https://heroeslounge.gg/team/view/ST")
		self.assertEqual(lounge.match_url(27399), MATCH_URL)

		with self.assertRaises(LoungeUrlError):
			lounge.team_url("../admin")


class ReplayHrefTests(unittest.TestCase):
	def test_accepts(self):
		self.assertEqual(lounge.validate_replay_href(REPLAY_1, MATCH_URL), REPLAY_1)
		rel = "/storage/app/uploads/public/6a9/9c1/ddc/x.StormReplay"
		self.assertEqual(lounge.validate_replay_href(rel, MATCH_URL), "https://heroeslounge.gg" + rel)

	def test_rejects(self):
		bad = [
			"http://heroeslounge.gg/storage/app/uploads/public/a/x.stormreplay",
			"https://evil.com/storage/app/uploads/public/a/x.stormreplay",
			"//evil.com/storage/app/uploads/public/a/x.stormreplay",
			"https://u@heroeslounge.gg/storage/app/uploads/public/a/x.stormreplay",
			"https://heroeslounge.gg:444/storage/app/uploads/public/a/x.stormreplay",
			"https://heroeslounge.gg/storage/app/uploads/private/a/x.stormreplay",
			"https://heroeslounge.gg/storage/app/uploads/public/a/x.stormreplay.exe",
			"https://heroeslounge.gg/storage/app/uploads/public/a/x.stormreplay?dl=1",
			"https://heroeslounge.gg/storage/app/uploads/public/a/x.stormreplay#f",
			"https://heroeslounge.gg/storage/app/uploads/public/../../x.stormreplay",
			"https://heroeslounge.gg/storage/app/uploads/public/a/x.zip",
			"x.stormreplay",
		]

		for href in bad:
			with self.subTest(href=href), self.assertRaises(LoungeUrlError):
				lounge.validate_replay_href(href, MATCH_URL)


class RedirectTests(unittest.TestCase):
	def _redirect(self, newurl: str):
		handler = lounge.SafeRedirectHandler()
		req = urllib.request.Request("https://heroeslounge.gg/match/view/1")
		return handler.redirect_request(req, io.BytesIO(), 302, "Found", {}, newurl)

	def test_refuses_off_site_and_http(self):
		for newurl in ("https://evil.com/x", "http://heroeslounge.gg/match/view/1", "https://heroeslounge.gg.evil.com/", "https://a@heroeslounge.gg/", "https://heroeslounge.gg:8080/", "//evil.com/x"):
			with self.subTest(newurl=newurl), self.assertRaises(LoungeUrlError):
				self._redirect(newurl)

	def test_follows_on_site(self):
		req = self._redirect("https://www.heroeslounge.gg/match/view/2")
		self.assertEqual(req.full_url, "https://www.heroeslounge.gg/match/view/2")

	def test_opener_uses_handler(self):
		opener = lounge.build_opener()
		self.assertTrue(any(isinstance(h, lounge.SafeRedirectHandler) for h in opener.handlers))
		self.assertFalse(any(type(h) is urllib.request.HTTPRedirectHandler for h in opener.handlers))


class _Response(io.BytesIO):
	pass


class _Opener:
	def __init__(self, data: bytes):
		self.data = data
		self.requests = []

	def open(self, req, timeout=None):
		self.requests.append((req, timeout))
		return _Response(self.data)


@mock.patch("pipeline.lounge.time.sleep")
class NetworkTests(unittest.TestCase):
	def test_fetch_text(self, sleep):
		opener = _Opener("päivä".encode("utf-8"))
		self.assertEqual(lounge.fetch_text(opener, MATCH_URL), "päivä")
		req, timeout = opener.requests[0]
		self.assertEqual(req.get_header("User-agent"), lounge.USER_AGENT)
		self.assertEqual(timeout, lounge.TIMEOUT_SECONDS)
		sleep.assert_called_once_with(lounge.REQUEST_DELAY_SECONDS)

	def test_fetch_rejects_before_request(self, sleep):
		opener = _Opener(b"")

		with self.assertRaises(LoungeUrlError):
			lounge.fetch_text(opener, "https://evil.com/")

		self.assertEqual(opener.requests, [])

	def test_download(self, sleep):
		with tempfile.TemporaryDirectory() as d:
			dest = os.path.join(d, "a.StormReplay")
			self.assertEqual(lounge.download_replay(_Opener(b"x" * 100000), REPLAY_1, dest), 100000)
			self.assertEqual(os.path.getsize(dest), 100000)
			self.assertFalse(os.path.exists(dest + ".part"))
			sleep.assert_called_with(lounge.REQUEST_DELAY_SECONDS)

	def test_download_cap(self, sleep):
		with tempfile.TemporaryDirectory() as d, mock.patch.object(lounge, "MAX_DOWNLOAD_BYTES", 1000):
			dest = os.path.join(d, "a.StormReplay")

			with self.assertRaises(ValueError):
				lounge.download_replay(_Opener(b"x" * 1001), REPLAY_1, dest)

			self.assertEqual(os.listdir(d), [])

	def test_download_rejects_bad_url(self, sleep):
		opener = _Opener(b"x")

		with tempfile.TemporaryDirectory() as d:
			with self.assertRaises(LoungeUrlError):
				lounge.download_replay(opener, "https://heroeslounge.gg/other/x.stormreplay", os.path.join(d, "a"))

			self.assertEqual(os.listdir(d), [])

		self.assertEqual(opener.requests, [])


class EventParsingTests(unittest.TestCase):
	CASES = [
		("[EU] Season 30 - Division 2", "[EU] Season 30 Round 10 Division 2", ("Season 30", 30, "2", "Round 10", "regular")),
		("[EU]Season 11 - Division 2", "[EU]Season 11 Round 3 Division 2", ("Season 11", 11, "2", "Round 3", "regular")),
		("[EU] Season 24 - Division 3", "[EU] Season 24 Round 1 Division 3", ("Season 24", 24, "3", "Round 1", "regular")),
		("[EU] Season 29 - Division 3 Cup", "[EU] Season 29 - Division 3 Cup Winner Bracket Round 2 - Match 2", ("Season 29", 29, "3", "Winner Bracket Round 2 - Match 2", "bracket")),
		("[EU] Season 25 - Division 3 Cup", "[EU] Season 25 - Division 3 Cup Winner Bracket Round 1 - Match 2", ("Season 25", 25, "3", "Winner Bracket Round 1 - Match 2", "bracket")),
		("[EU]Season 9 - Legendary Cup - Group D", "[EU]Season 9 - Legendary Cup Group D", ("Season 9", 9, None, "Legendary Cup Group D", "group")),
		("Heroes 10th - Heroes 10 Division 2 - Group A", "Heroes 10th - Heroes 10 Division 2 Group A", ("Heroes 10th", None, "2", "Group A", "group")),
		("Heroes 10th - Heroes 10 Division 2", "Heroes 10th - Heroes 10 Division 2 Winner Bracket Round 1 - Match 1", ("Heroes 10th", None, "2", "Winner Bracket Round 1 - Match 1", "bracket")),
		("Khaldor Underdog Cup Jan.26 - Khaldor Underdog Cup Jan 26", "Khaldor Underdog Cup Jan.26 Round 1 Khaldor Underdog Cup Jan 26", ("Khaldor Underdog Cup Jan.26", None, None, "Round 1", "regular")),
		("[EU] Offseason 25-26 - Group B", "[EU] Offseason 25-26 Round 1 Group B", ("Offseason 25-26", None, None, "Round 1 Group B", "group")),
	]

	def test_shapes(self):
		for event, title, expected in self.CASES:
			with self.subTest(title=title):
				got = lounge.parse_event(event, title)
				self.assertEqual(list(got), ["season", "seasonNumber", "division", "round", "stage"])
				self.assertEqual(tuple(got.values()), expected)

	def test_division_is_digit_string(self):
		self.assertEqual(lounge.parse_event("[EU] Season 30 - Division 12", "[EU] Season 30 Round 1 Division 12")["division"], "12")


class ScheduledTests(unittest.TestCase):
	def test_offsets(self):
		self.assertEqual(lounge.parse_scheduled("03 Sep 2026 18:00 (UTC +00:00)"), "2026-09-03T18:00:00+00:00")
		self.assertEqual(lounge.parse_scheduled("03 Sep 2026 01:30 (UTC +02:00)"), "2026-09-02T23:30:00+00:00")
		self.assertEqual(lounge.parse_scheduled("31 Dec 2025 22:15 (UTC -05:30)"), "2026-01-01T03:45:00+00:00")
		self.assertEqual(lounge.parse_scheduled("1 May 2019 18:30 (UTC +00:00)"), "2019-05-01T18:30:00+00:00")
		self.assertIsNone(lounge.parse_scheduled(None))

	def test_rejects(self):
		for raw in ("03 Sept 2026 18:00 (UTC +00:00)", "03 sep 2026 18:00 (UTC +00:00)", "03 Sep 2026 18:00", "03 Okt 2026 18:00 (UTC +00:00)", "31 Feb 2026 18:00 (UTC +00:00)", "Not scheduled", ""):
			with self.subTest(raw=raw), self.assertRaises(ValueError):
				lounge.parse_scheduled(raw)


class HelperTests(unittest.TestCase):
	def test_replay_filename(self):
		self.assertEqual(lounge.replay_filename(27399, 1, "Alterac Pass", "Ruby Goose Agents"), "27399_G1_Alterac-Pass_vs-Ruby-Goose-Agents.StormReplay")
		self.assertEqual(lounge.replay_filename(5, 3, None, "GodDammit!"), "5_G3_map_vs-GodDammit.StormReplay")

	def test_norm(self):
		self.assertEqual(lounge.norm("Lúcio"), "lucio")
		self.assertEqual(lounge.norm("E.T.C."), "etc")
		self.assertEqual(lounge.norm("Sgt. Hammer"), lounge.norm("sgt hammer"))

	def test_best_of(self):
		self.assertEqual(lounge.best_of([2, 0]), 3)
		self.assertEqual(lounge.best_of([1, 2]), 3)
		self.assertEqual(lounge.best_of([3, 1]), 5)
		self.assertIsNone(lounge.best_of(None))
		self.assertIsNone(lounge.best_of([0, 0]))


class FixtureTests(unittest.TestCase):
	def test_team_page(self):
		rows = lounge.parse_team_page(_fixture("team.html"), TEAM)
		self.assertEqual(len(rows), 115)
		self.assertEqual(len({r["id"] for r in rows}), 115)
		self.assertEqual(rows[0], {"id": 27399, "event": "[EU] Season 30 - Division 2", "score": [0, 2]})
		self.assertEqual(rows[1]["score"], [2, 0])
		self.assertEqual(rows[2]["score"], [2, 1])
		self.assertEqual(rows[-1], {"id": 4989, "event": "[EU]Season 9 - Division 3", "score": [0, 2]})

	def test_team_page_other_slug_is_structure_error(self):
		with self.assertRaises(LoungeStructureError):
			lounge.parse_team_page(_fixture("team.html"), "NOPE")

	def test_team_page_structure_errors(self):
		with self.assertRaises(LoungeStructureError):
			lounge.parse_team_page("<html></html>", TEAM)

		with self.assertRaises(LoungeStructureError):
			lounge.parse_team_page('<a href="#roundmatches_group_1">S</a><div id="roundmatches_group_1"></div>', TEAM)

	def test_match_page(self):
		page = lounge.parse_match_page(_fixture("match-27399.html"), 27399, MATCH_URL)
		self.assertEqual(page["title"], "[EU] Season 30 Round 10 Division 2")
		self.assertEqual(page["scheduledRaw"], "03 Sep 2026 18:00 (UTC +00:00)")
		self.assertEqual(page["teams"], [["RGA", "Ruby Goose Agents"], ["ST", "Sauna Tent"]])
		self.assertEqual([(g["game"], g["map"], g["winnerSlug"], g["replayUrl"]) for g in page["games"]], [(1, "Alterac Pass", "RGA", REPLAY_1), (2, "Garden of Terror", "RGA", REPLAY_2)])
		self.assertEqual([len(g["picks"]) for g in page["games"]], [10, 10])
		self.assertEqual(page["games"][0]["picks"][0]["hero"], "Johanna")
		self.assertEqual(page["games"][1]["picks"][2]["hero"], "Lúcio")

	def test_match_page_odd_replay_link_fails_whole_match(self):
		html = _fixture("match-27399.html").replace(REPLAY_1, "https://evil.com/storage/app/uploads/public/x.stormreplay")

		with self.assertRaises(LoungeUrlError):
			lounge.parse_match_page(html, 27399, MATCH_URL)

	def test_match_page_without_teams(self):
		html = _fixture("match-27399.html").replace("https://heroeslounge.gg/team/view/", "https://heroeslounge.gg/x/")

		with self.assertRaises(LoungeStructureError):
			lounge.parse_match_page(html, 27399, MATCH_URL)

	def test_match_entry(self):
		page = lounge.parse_match_page(_fixture("match-27399.html"), 27399, MATCH_URL)
		entry = lounge.build_match_entry(_row(27399, [0, 2]), page, TEAM, CUTOFF)
		self.assertEqual(list(entry), ["id", "event", "title", "season", "seasonNumber", "division", "round", "stage", "opponent", "scheduled", "score", "bestOf", "status", "games"])
		self.assertEqual(entry["opponent"], {"slug": "RGA", "name": "Ruby Goose Agents"})
		self.assertEqual((entry["season"], entry["seasonNumber"], entry["division"], entry["round"], entry["stage"]), ("Season 30", 30, "2", "Round 10", "regular"))
		self.assertEqual((entry["scheduled"], entry["bestOf"], entry["status"]), ("2026-09-03T18:00:00+00:00", 3, "played"))
		first = entry["games"][0]
		self.assertEqual(list(first), ["game", "map", "won", "status", "reason", "matchId", "replayUrl", "replayFile"])
		self.assertEqual(first, {"game": 1, "map": "Alterac Pass", "won": False, "status": None, "reason": None, "matchId": None, "replayUrl": REPLAY_1, "replayFile": "27399_G1_Alterac-Pass_vs-Ruby-Goose-Agents.StormReplay"})
		self.assertEqual(entry["games"][1]["replayFile"], "27399_G2_Garden-of-Terror_vs-Ruby-Goose-Agents.StormReplay")


class MatchEntryTests(unittest.TestCase):
	def test_missing_game_proven_by_score(self):
		games = [_page_game(1, winner="AH", replay=REPLAY_1), _page_game(2, winner="AH", replay=REPLAY_2), _page_game(3, None, None, None, 0)]
		entry = lounge.build_match_entry(_row(27276, [1, 2]), _page(27276, games), TEAM, CUTOFF)
		self.assertEqual([(g["game"], g["won"], g["status"]) for g in entry["games"]], [(1, False, None), (2, False, None), (3, True, "no-replay")])
		self.assertIsNone(entry["games"][2]["replayFile"])
		self.assertEqual(entry["bestOf"], 3)

	def test_two_missing_games_have_unknown_result(self):
		games = [_page_game(1, winner="ST", replay=REPLAY_1)]
		entry = lounge.build_match_entry(_row(1, [2, 1]), _page(1, games), TEAM, CUTOFF)
		self.assertEqual([(g["game"], g["won"], g["status"]) for g in entry["games"]], [(1, True, None), (2, None, "no-replay"), (3, None, "no-replay")])

	def test_missing_game_with_unknown_winner(self):
		games = [_page_game(1, winner=None, replay=REPLAY_1), _page_game(2, winner="ST")]
		entry = lounge.build_match_entry(_row(1, [2, 1]), _page(1, games), TEAM, CUTOFF)
		self.assertEqual([(g["game"], g["won"], g["status"]) for g in entry["games"]], [(1, None, None), (2, True, "no-replay"), (3, None, "no-replay")])

	def test_forfeit(self):
		entry = lounge.build_match_entry(_row(5, [2, 0]), _page(5, [_page_game(1, None, None, None, 0), _page_game(2, None, None, None, 0)]), TEAM, CUTOFF)
		self.assertEqual((entry["status"], entry["games"], entry["bestOf"], entry["score"]), ("forfeit", [], 3, [2, 0]))

	def test_byes(self):
		for score in ([2, 0], [0, 0]):
			with self.subTest(score=score):
				entry = lounge.build_match_entry(_row(6, score), _page(6, [], opponent=("bye", "BYE!")), TEAM, CUTOFF)
				self.assertEqual((entry["status"], entry["bestOf"], entry["games"]), ("forfeit", None, []))

	def test_pre_cutoff(self):
		games = [_page_game(1, replay=REPLAY_1)]
		entry = lounge.build_match_entry(_row(7, [2, 0]), _page(7, games, scheduled="06 Dec 2021 23:59 (UTC +00:00)"), TEAM, CUTOFF)
		self.assertEqual((entry["status"], entry["games"]), ("pre-cutoff", []))
		entry = lounge.build_match_entry(_row(7, [2, 0]), _page(7, games, scheduled="07 Dec 2021 00:00 (UTC +00:00)"), TEAM, CUTOFF)
		self.assertEqual(entry["status"], "played")

	def test_unplayed_and_bad_input(self):
		with self.assertRaises(ValueError):
			lounge.build_match_entry(_row(8, None), _page(8, []), TEAM, CUTOFF)

		with self.assertRaises(ValueError):
			lounge.build_match_entry(_row(9, [2, 0]), _page(8, []), TEAM, CUTOFF)

		with self.assertRaises(LoungeStructureError):
			lounge.build_match_entry(_row(8, [2, 0]), _page(8, [], opponent=(TEAM, "Sauna Tent")), TEAM, CUTOFF)


def _registered(entry: dict, ids: list[str | None]) -> dict:
	entry = copy.deepcopy(entry)

	for game, mid in zip(entry["games"], ids):
		if mid:
			game["status"] = "registered"
			game["matchId"] = mid

	return entry


class RegistryTests(unittest.TestCase):
	def _entry(self, match_id: int = 27276) -> dict:
		games = [_page_game(1, winner="AH", replay=REPLAY_1), _page_game(2, winner="AH", replay=REPLAY_2)]
		return lounge.build_match_entry(_row(match_id, [1, 2]), _page(match_id, games), TEAM, CUTOFF)

	def test_load_missing_and_wrong_team(self):
		with tempfile.TemporaryDirectory() as d:
			path = os.path.join(d, "lounge.json")
			self.assertEqual(lounge.load_registry(path, TEAM), {"site": lounge.SITE, "team": TEAM, "matches": []})

			with open(path, "w", encoding="utf-8") as f:
				json.dump({"site": lounge.SITE, "team": "XX", "matches": []}, f)

			with self.assertRaises(ValueError):
				lounge.load_registry(path, TEAM)

	def test_merge_idempotent_and_hand_edits_survive(self):
		registry = {"site": lounge.SITE, "team": TEAM, "matches": []}
		entry = _registered(self._entry(), ["a1", "a2"])
		self.assertTrue(lounge.merge_match(registry, entry))
		self.assertFalse(lounge.merge_match(registry, entry))

		match = registry["matches"][0]
		match["round"] = "Round 7 (replayed)"
		match["games"][0]["map"] = "Hand Map"
		match["games"][2]["won"] = False
		self.assertFalse(lounge.merge_match(registry, entry))
		self.assertEqual(match["round"], "Round 7 (replayed)")
		self.assertEqual(match["games"][0]["map"], "Hand Map")
		self.assertFalse(match["games"][2]["won"])

		entry["games"][0]["status"] = "registered"
		entry["title"] = "changed on site"
		self.assertFalse(lounge.merge_match(registry, entry))
		self.assertEqual(match["title"], "[EU] Season 30 Round 7 Division 2")

	def test_merge_does_not_alias_input(self):
		registry = {"site": lounge.SITE, "team": TEAM, "matches": []}
		entry = self._entry()
		lounge.merge_match(registry, entry)
		entry["games"][0]["map"] = "mutated"
		self.assertEqual(registry["matches"][0]["games"][0]["map"], "Alterac Pass")

	def test_merge_fills_unresolved_games_only(self):
		registry = {"site": lounge.SITE, "team": TEAM, "matches": []}
		first = _registered(self._entry(), ["a1"])
		del first["games"][1]
		lounge.merge_match(registry, first)

		late = _registered(self._entry(), ["zz", "a2", "a3"])
		self.assertTrue(lounge.merge_match(registry, late))
		games = registry["matches"][0]["games"]
		self.assertEqual([(g["game"], g["status"], g["matchId"]) for g in games], [(1, "registered", "a1"), (2, "registered", "a2"), (3, "registered", "a3")])
		self.assertFalse(lounge.merge_match(registry, late))

	def test_unprocessed_game_does_not_replace_no_replay(self):
		registry = {"site": lounge.SITE, "team": TEAM, "matches": []}
		lounge.merge_match(registry, self._entry())
		self.assertFalse(lounge.merge_match(registry, self._entry()))

	def test_save_round_trip_and_sort(self):
		registry = {"site": lounge.SITE, "team": TEAM, "matches": []}
		lounge.merge_match(registry, _registered(self._entry(300), ["b1", "b2"]))
		lounge.merge_match(registry, self._entry(20))
		lounge.merge_match(registry, self._entry(1000))
		registry["matches"][0]["games"][1]["status"] = "rejected"
		registry["matches"][0]["games"][1]["reason"] = "custom_no_5stack"
		registry["matches"][1]["opponent"]["name"] = "Ääkköset"

		with tempfile.TemporaryDirectory() as d:
			path = os.path.join(d, "lounge.json")
			lounge.save_registry(path, registry)

			with open(path, "rb") as f:
				raw = f.read()

			self.assertTrue(raw.endswith(b"}\n"))
			self.assertNotIn(b"\r", raw)
			self.assertIn("Ääkköset".encode("utf-8"), raw)
			self.assertIn(b'\n\t"matches": [', raw)
			self.assertEqual(os.listdir(d), ["lounge.json"])

			loaded = lounge.load_registry(path, TEAM)
			self.assertEqual([m["id"] for m in loaded["matches"]], [20, 300, 1000])
			self.assertEqual([m["id"] for m in registry["matches"]], [300, 20, 1000])

			games = loaded["matches"][1]["games"]
			self.assertNotIn("reason", games[0])
			self.assertEqual(games[1]["reason"], "custom_no_5stack")
			self.assertEqual(list(games[1]), ["game", "map", "won", "status", "reason", "matchId", "replayUrl", "replayFile"])

			lounge.save_registry(path, loaded)

			with open(path, "rb") as f:
				self.assertEqual(f.read(), raw)

	def test_reconcile_removed(self):
		registry = {"site": lounge.SITE, "team": TEAM, "matches": []}
		lounge.merge_match(registry, _registered(self._entry(), ["a1", "a2"]))
		self.assertEqual(lounge.reconcile_removed(registry, {"a2", "zz"}), ["a2"])
		self.assertEqual([g["status"] for g in registry["matches"][0]["games"]], ["registered", "removed", "no-replay"])
		self.assertEqual(lounge.reconcile_removed(registry, {"a2"}), [])


class NeedsFetchTests(unittest.TestCase):
	NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)

	def _entry(self, status: str, game_statuses: list[str], days_ago: float | None) -> dict:
		scheduled = None if days_ago is None else (self.NOW - timedelta(days=days_ago)).isoformat()
		return {"status": status, "scheduled": scheduled, "games": [{"game": i + 1, "status": s} for i, s in enumerate(game_statuses)]}

	def test_matrix(self):
		cases = [
			(None, False, True),
			(self._entry("forfeit", [], 1), False, False),
			(self._entry("forfeit", [], 1), True, False),
			(self._entry("pre-cutoff", [], 2000), True, False),
			(self._entry("played", ["registered", "rejected", "removed"], 1), False, False),
			(self._entry("played", ["registered", "rejected", "removed"], 1), True, False),
			(self._entry("played", ["registered", "no-replay"], 1), False, True),
			(self._entry("played", ["registered", "no-replay"], 13.9), False, True),
			(self._entry("played", ["registered", "no-replay"], 14), False, False),
			(self._entry("played", ["registered", "no-replay"], 100), False, False),
			(self._entry("played", ["registered", "no-replay"], 100), True, True),
			(self._entry("played", ["no-replay"], None), False, False),
			(self._entry("played", ["no-replay"], None), True, True),
		]

		for entry, recheck, expected in cases:
			with self.subTest(entry=entry, recheck=recheck):
				self.assertEqual(lounge.needs_fetch(entry, self.NOW, recheck), expected)

	def test_naive_now_is_utc(self):
		entry = self._entry("played", ["no-replay"], 1)
		self.assertTrue(lounge.needs_fetch(entry, self.NOW.replace(tzinfo=None), False))


class StampTests(unittest.TestCase):
	def test_stamps(self):
		games = [_page_game(1, winner="AH", replay=REPLAY_1), _page_game(2, winner="AH", replay=REPLAY_2)]
		entry = lounge.build_match_entry(_row(27276, [1, 2]), _page(27276, games), TEAM, CUTOFF)
		entry["games"][0]["status"] = "registered"
		entry["games"][0]["matchId"] = "m1"
		entry["games"][1]["status"] = "rejected"
		entry["games"][1]["matchId"] = "m2"
		forfeit = lounge.build_match_entry(_row(5, [2, 0]), _page(5, []), TEAM, CUTOFF)
		stamps = lounge.build_stamps({"site": lounge.SITE, "team": TEAM, "matches": [entry, forfeit]})

		self.assertEqual(list(stamps), ["m1"])
		stamp = stamps["m1"]
		self.assertEqual(list(stamp), ["id", "game", "season", "seasonNumber", "stage", "round", "opponent", "scheduled", "bestOf", "score", "results"])
		self.assertEqual(stamp["results"], ["loss", "loss", "win"])
		self.assertEqual(stamp["opponent"], {"slug": "AH", "name": "Apes Hunters"})
		self.assertEqual((stamp["id"], stamp["game"], stamp["bestOf"], stamp["score"]), (27276, 1, 3, [1, 2]))

	def test_unknown_result_is_null(self):
		match = {"id": 1, "event": "[EU] Season 30 - Division 2", "season": "S", "seasonNumber": None, "stage": "regular", "round": "R", "opponent": {"slug": "x", "name": "X"}, "scheduled": None, "bestOf": 3, "score": [2, 1], "games": [{"game": 1, "won": True, "status": "registered", "matchId": "m"}, {"game": 2, "won": None, "status": "no-replay", "matchId": None}]}
		self.assertEqual(lounge.build_stamps({"matches": [match]})["m"]["results"], ["win", None])


class CrossCheckTests(unittest.TestCase):
	HEROES = ["Lúcio", "E.T.C.", "Sgt. Hammer", "Li-Ming", "Anduin", "Blaze", "Falstad", "Garrosh", "Junkrat", "Genji"]

	def _page_game(self, winner: str | None = "ST", picks: list[str] | None = None) -> dict:
		names = self.HEROES if picks is None else picks
		return {"game": 1, "map": "Garden of Terror", "winnerSlug": winner, "picks": [{"hero": h, "player": "p"} for h in names], "replayUrl": None}

	def _replay(self, **overrides) -> dict:
		replay = {"map": "Garden Of Terror", "heroes": ["Lucio", "ETC", "Sgt Hammer", "Li Ming", "Anduin", "Blaze", "Falstad", "Garrosh", "Junkrat", "Genji"][::-1], "rosterWon": True}
		replay.update(overrides)
		return replay

	def test_match(self):
		self.assertIsNone(lounge.page_mismatch(self._page_game(), self._replay(), TEAM))
		self.assertIsNone(lounge.page_mismatch(self._page_game(winner="AH"), self._replay(rosterWon=False), TEAM))

	def test_each_field(self):
		self.assertEqual(lounge.page_mismatch(self._page_game(), self._replay(map="Towers of Doom"), TEAM), "map")
		self.assertEqual(lounge.page_mismatch(self._page_game(), self._replay(heroes=self.HEROES[:9] + ["Hogger"]), TEAM), "heroes")
		self.assertEqual(lounge.page_mismatch(self._page_game(), self._replay(rosterWon=False), TEAM), "winner")
		self.assertEqual(lounge.page_mismatch(self._page_game(winner=None), self._replay(), TEAM), "winner")
		self.assertEqual(lounge.page_mismatch(self._page_game(picks=self.HEROES[:9]), self._replay(heroes=self.HEROES[:9]), TEAM), "heroes")

		no_map = self._page_game()
		no_map["map"] = None
		self.assertEqual(lounge.page_mismatch(no_map, self._replay(rosterWon=False), TEAM), "map, winner")

	def test_game_order(self):
		self.assertTrue(lounge.game_order_ok([]))
		self.assertTrue(lounge.game_order_ok(["2026-09-03T18:05:00+00:00", "2026-09-03T18:40:00+00:00"]))
		self.assertFalse(lounge.game_order_ok(["2026-09-03T18:40:00+00:00", "2026-09-03T18:05:00+00:00"]))
		self.assertFalse(lounge.game_order_ok(["2026-09-03T18:05:00+00:00", "2026-09-03T18:05:00+00:00"]))
		self.assertTrue(lounge.game_order_ok(["2026-09-03T20:05:00+02:00", "2026-09-03T18:06:00+00:00"]))

	def test_schedule_drift(self):
		self.assertIsNone(lounge.schedule_drift_days(None, "2026-09-03T18:00:00+00:00"))
		self.assertAlmostEqual(lounge.schedule_drift_days("2026-09-03T18:00:00+00:00", "2026-09-05T06:00:00+00:00"), 1.5)
		self.assertAlmostEqual(lounge.schedule_drift_days("2026-09-03T18:00:00+00:00", "2026-09-03T12:00:00+00:00"), -0.25)


if __name__ == "__main__":
	unittest.main()
