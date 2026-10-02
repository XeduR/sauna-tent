import contextlib
import http.client
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
from datetime import datetime, timezone
from unittest import mock

from pipeline import batch, lounge, parser
from pipeline.batch import ReplayContext, classify_replay, process_replay, _cache_key, _file_content_hash
from pipeline.run import load_config, DEFAULT_CONFIG_PATH, PROJECT_ROOT

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "lounge")
DATA_MATCHES = os.path.join(PROJECT_ROOT, "data", "matches")
TEAM_URL = "https://heroeslounge.gg/team/view/ST"
MATCH_URL = "https://heroeslounge.gg/match/view/27399"
GAME_1_ID = "e52207cf03fbddd68165929b26bdf234"
GAME_2_ID = "a0cf5fa10a145aed77f82610681c253b"
GAME_IDS = {"_G1_": GAME_1_ID, "_G2_": GAME_2_ID}
NOW = datetime(2026, 9, 10, tzinfo=timezone.utc)


def _fixture(name: str) -> str:
	with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
		return f.read()


class _Response(io.BytesIO):
	def __enter__(self):
		return self

	def __exit__(self, *exc):
		self.close()


class StubOpener:
	def __init__(self):
		self.pages = {TEAM_URL: _fixture("team.html").encode(), MATCH_URL: _fixture("match-27399.html").encode()}
		self.urls: list[str] = []

	def open(self, request, timeout=None):
		url = request.full_url
		self.urls.append(url)

		if url in self.pages:
			return _Response(self.pages[url])

		if url.endswith(".stormreplay"):
			return _Response(b"replay bytes")

		raise urllib.error.URLError(f"unexpected fetch {url}")


def _tree(root: str) -> dict[str, bytes]:
	out = {}

	for directory, _, names in os.walk(root):
		for name in names:
			path = os.path.join(directory, name)

			with open(path, "rb") as f:
				out[os.path.relpath(path, root)] = f.read()

	return out


class IntakeFlowTests(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.mkdtemp(prefix="lounge-intake-")
		self.out_dir = os.path.join(self.tmp, "data")
		os.makedirs(os.path.join(self.out_dir, "matches"))

		for match_id in (GAME_1_ID, GAME_2_ID):
			shutil.copy(os.path.join(DATA_MATCHES, f"{match_id}.json"), os.path.join(self.out_dir, "matches"))

		self.config = load_config(DEFAULT_CONFIG_PATH)
		self.config["replayDirectory"] = os.path.join(self.tmp, "replays")
		self.config["lounge"] = {"teamSlug": "ST", "replayDirectory": os.path.join(self.tmp, "replays", "lounge")}
		self.manifest = os.path.join(self.tmp, "manifest.json")
		self.registry_path = os.path.join(self.out_dir, "lounge.json")
		self.processed: list[str] = []

		# Every other team-page match is resolved so a team-page run fetches only 27399.
		rows = lounge.parse_team_page(_fixture("team.html"), "ST")
		registry = {"site": lounge.SITE, "team": "ST", "matches": [
			{"id": r["id"], "status": "pre-cutoff", "games": []} for r in rows if r["id"] != 27399
		]}
		lounge.save_registry(self.registry_path, registry)
		self.addCleanup(shutil.rmtree, self.tmp)
		patcher = mock.patch.object(lounge, "REQUEST_DELAY_SECONDS", 0)
		patcher.start()
		self.addCleanup(patcher.stop)

	def _processor(self, ids: dict[str, str]):
		def process(path: str, ctx: ReplayContext, **kwargs) -> tuple[str, str | None, str | None]:
			self.processed.append(os.path.basename(path))
			match_id = next(v for k, v in ids.items() if k in os.path.basename(path))
			return ("duplicate", "duplicate", match_id)

		return process

	def _run(self, url: str | None = None, ids: dict[str, str] = GAME_IDS, **kwargs) -> tuple[int, StubOpener, str]:
		opener = StubOpener()
		buffer = io.StringIO()

		with contextlib.redirect_stdout(buffer):
			code = lounge.run_intake(
				self.config, url, output_dir=self.out_dir, archive_dir=os.path.join(self.tmp, "archive"),
				manifest_path=self.manifest, opener=opener, replay_processor=self._processor(ids),
				parser_check=lambda non_interactive: None, now=NOW, **kwargs,
			)

		return code, opener, buffer.getvalue()

	def _match_27399(self) -> dict | None:
		with open(self.registry_path, encoding="utf-8") as f:
			return next((m for m in json.load(f)["matches"] if m["id"] == 27399), None)

	def _edit_match(self, match_id: str, edit) -> None:
		path = os.path.join(self.out_dir, "matches", f"{match_id}.json")

		with open(path, encoding="utf-8") as f:
			match = json.load(f)

		edit(match)

		with open(path, "w", encoding="utf-8") as f:
			json.dump(match, f)

	def test_duplicates_register_and_rerun_is_noop(self):
		code, opener, out = self._run()
		self.assertEqual(code, 0, out)
		self.assertEqual(opener.urls[:2], [TEAM_URL, MATCH_URL])
		self.assertEqual(len(opener.urls), 4)
		games = self._match_27399()["games"]
		self.assertEqual([(g["status"], g["matchId"]) for g in games], [("registered", GAME_1_ID), ("registered", GAME_2_ID)])
		self.assertIn("2 registered duplicate", out)

		with open(self.registry_path, "rb") as f:
			before = f.read()

		code, opener, out = self._run()
		self.assertEqual(code, 0, out)
		self.assertEqual(opener.urls, [TEAM_URL])

		with open(self.registry_path, "rb") as f:
			self.assertEqual(f.read(), before)

	def test_present_replay_is_not_downloaded(self):
		os.makedirs(self.config["lounge"]["replayDirectory"])
		name = "27399_G1_Alterac-Pass_vs-Ruby-Goose-Agents.StormReplay"

		with open(os.path.join(self.config["lounge"]["replayDirectory"], name), "wb") as f:
			f.write(b"x")

		code, opener, out = self._run()
		self.assertEqual(code, 0, out)
		self.assertEqual(len(opener.urls), 3)
		self.assertEqual(len(self.processed), 2)

	def test_wrong_winner_is_page_mismatch(self):
		def flip(match):
			for p in match["players"]:
				p["result"] = "win" if p["result"] == "loss" else "loss"

		self._edit_match(GAME_2_ID, flip)
		code, _, out = self._run()
		self.assertEqual(code, 0, out)
		games = self._match_27399()["games"]
		self.assertEqual(games[0]["status"], "registered")
		self.assertEqual((games[1]["status"], games[1]["reason"]), ("rejected", "page-mismatch"))
		self.assertIn("page-mismatch (winner)", out)

	def test_out_of_order_series_is_conflict(self):
		self._edit_match(GAME_1_ID, lambda m: m.update(timestamp="2026-09-03T19:30:00+00:00"))
		code, _, out = self._run()
		self.assertEqual(code, 1, out)
		self.assertIn("conflict", out)
		self.assertIsNone(self._match_27399())

	def test_dry_run_writes_nothing(self):
		before = _tree(self.tmp)
		code, opener, out = self._run(dry_run=True)
		self.assertEqual(code, 0, out)
		self.assertEqual(opener.urls, [TEAM_URL, MATCH_URL])
		self.assertEqual(self.processed, [])
		self.assertEqual(_tree(self.tmp), before)
		self.assertIn("would download 27399_G1_", out)

	def test_series_mode_new_match_touches_only_that_match(self):
		with open(self.registry_path, encoding="utf-8") as f:
			before = {m["id"]: json.dumps(m) for m in json.load(f)["matches"]}

		code, opener, out = self._run(MATCH_URL, mode="series")
		self.assertEqual(code, 0, out)
		self.assertEqual(opener.urls[:2], [TEAM_URL, MATCH_URL])
		self.assertEqual(len(opener.urls), 4)
		self.assertTrue(all(u.endswith(".stormreplay") for u in opener.urls[2:]))

		with open(self.registry_path, encoding="utf-8") as f:
			after = {m["id"]: json.dumps(m) for m in json.load(f)["matches"]}

		self.assertEqual(set(after) - set(before), {27399})
		self.assertEqual({k: v for k, v in after.items() if k != 27399}, before)

	def test_mode_rejections_exit_2_before_network(self):
		cases = [
			(None, "series"),
			(TEAM_URL, "series"),
			(MATCH_URL, "team"),
		]

		for url, mode in cases:
			code, opener, out = self._run(url, mode=mode)
			self.assertEqual(code, 2, (url, mode))
			self.assertEqual(opener.urls, [])
			self.assertIn("--mode " + mode, out)

	def test_team_mode_accepts_team_url_or_none(self):
		for url in (None, TEAM_URL):
			code, opener, out = self._run(url, mode="team")
			self.assertEqual(code, 0, out)

	def test_match_url_refetches_registered_match(self):
		self._run()
		code, opener, out = self._run(MATCH_URL)
		self.assertEqual(code, 0, out)
		self.assertEqual(opener.urls, [TEAM_URL, MATCH_URL])

	def test_unparseable_is_rejected_and_fails_run(self):
		def process(path, ctx, **kwargs):
			return ("rejected", "unparseable", None)

		buffer = io.StringIO()

		with contextlib.redirect_stdout(buffer):
			code = lounge.run_intake(
				self.config, None, output_dir=self.out_dir, manifest_path=self.manifest, opener=StubOpener(),
				replay_processor=process, parser_check=lambda non_interactive: None, now=NOW,
			)

		self.assertEqual(code, 1)
		games = self._match_27399()["games"]
		self.assertEqual([(g["status"], g["reason"]) for g in games], [("rejected", "unparseable")] * 2)

	def test_incomplete_read_is_download_failure(self):
		class Opener(StubOpener):
			def open(self, request, timeout=None):
				if request.full_url.endswith(".stormreplay"):
					raise http.client.IncompleteRead(b"partial", 100)

				return super().open(request, timeout)

		buffer = io.StringIO()

		with contextlib.redirect_stdout(buffer):
			code = lounge.run_intake(
				self.config, None, output_dir=self.out_dir, manifest_path=self.manifest, opener=Opener(),
				replay_processor=self._processor(GAME_IDS), parser_check=lambda non_interactive: None, now=NOW,
			)

		self.assertEqual(code, 1, buffer.getvalue())
		self.assertIn("download failed", buffer.getvalue())
		self.assertIsNone(self._match_27399())
		self.assertEqual(self.processed, [])

	def test_non_official_rows_skipped_without_fetch(self):
		rows = lounge.parse_team_page(_fixture("team.html"), "ST")
		unofficial = [r["id"] for r in rows if not lounge.is_official_event(r["event"])]
		self.assertEqual(len(unofficial), 14)
		registry = {"site": lounge.SITE, "team": "ST", "matches": [
			{"id": r["id"], "event": r["event"], "status": "pre-cutoff", "games": []}
			for r in rows if r["id"] != 27399 and lounge.is_official_event(r["event"])
		]}
		lounge.save_registry(self.registry_path, registry)
		code, opener, out = self._run(mode="team")
		self.assertEqual(code, 0, out)
		self.assertEqual(opener.urls[:2], [TEAM_URL, MATCH_URL])
		self.assertEqual(len(opener.urls), 4)
		self.assertEqual(out.count("skipped (not an official season)"), len(unofficial))

		with open(self.registry_path, encoding="utf-8") as f:
			ids = {m["id"] for m in json.load(f)["matches"]}

		self.assertFalse(ids & set(unofficial))

	def test_series_mode_on_non_official_match_exits_2(self):
		rows = lounge.parse_team_page(_fixture("team.html"), "ST")
		offseason = next(r["id"] for r in rows if "Offseason" in r["event"])

		with open(self.registry_path, "rb") as f:
			before = f.read()

		code, opener, out = self._run(f"https://heroeslounge.gg/match/view/{offseason}", mode="series")
		self.assertEqual(code, 2, out)
		self.assertEqual(opener.urls, [TEAM_URL])
		self.assertIn("nothing was registered", out)

		with open(self.registry_path, "rb") as f:
			self.assertEqual(f.read(), before)

	def test_new_match_page_mismatch_writes_nothing(self):
		with open(os.path.join(DATA_MATCHES, f"{GAME_1_ID}.json"), encoding="utf-8") as f:
			wrong_map = dict(json.load(f), map="Sky Temple")

		archive = os.path.join(self.tmp, "archive")

		with mock.patch.object(batch, "parse_replay_raw", return_value={"timestamp": "2026-09-03T18:23:27"}), \
				mock.patch.object(batch, "generate_match_id", return_value="feedface"), \
				mock.patch.object(batch, "classify_replay", return_value=(True, "CustomDraft")), \
				mock.patch.object(batch, "analyze_raw", side_effect=lambda raw: json.loads(json.dumps(wrong_map))), \
				mock.patch.object(batch, "tag_players"), \
				contextlib.redirect_stdout(io.StringIO()) as buffer:
			code = lounge.run_intake(
				self.config, MATCH_URL, output_dir=self.out_dir, archive_dir=archive, manifest_path=self.manifest,
				opener=StubOpener(), parser_check=lambda non_interactive: None, now=NOW,
			)

		self.assertEqual(code, 0, buffer.getvalue())
		self.assertFalse(os.path.exists(os.path.join(self.out_dir, "matches", "feedface.json")))
		self.assertFalse(os.path.exists(archive) and os.listdir(archive))
		games = self._match_27399()["games"]
		self.assertEqual([(g["status"], g["reason"]) for g in games], [("rejected", "page-mismatch")] * 2)

		with open(self.manifest, encoding="utf-8") as f:
			entries = list(json.load(f)["files"].values())

		self.assertEqual([(e["reason"], e["matchId"]) for e in entries], [("page-mismatch", "feedface")] * 2)

	def test_invalid_inputs_exit_2(self):
		self.assertEqual(self._run("https://heroeslounge.gg/team/view/XX")[0], 2)
		self.assertEqual(self._run("http://heroeslounge.gg/team/view/ST")[0], 2)
		self.config["lounge"]["replayDirectory"] = os.path.join(self.tmp, "elsewhere")
		self.assertEqual(self._run()[0], 2)
		del self.config["lounge"]
		self.assertEqual(self._run()[0], 2)


class ProcessReplayTests(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.mkdtemp(prefix="lounge-replay-")
		self.addCleanup(shutil.rmtree, self.tmp)

	def _ctx(self, files: dict) -> ReplayContext:
		return ReplayContext(
			config={}, files=files, roster_toons=frozenset(), alt_toons=frozenset(), cutoff_date=None,
			seen_match_ids=set(), removed_ids={"gone"}, out_dir=self.tmp, archive_dir=self.tmp, pretty=False,
		)

	def _replay(self, name: str) -> str:
		path = os.path.join(self.tmp, name)

		with open(path, "wb") as f:
			f.write(name.encode())

		return path

	def test_cached_verdicts(self):
		cases = [
			({"status": "accepted", "matchId": "m1"}, ("cached", None, "m1")),
			({"status": "rejected", "reason": "duplicate", "matchId": "m2"}, ("duplicate", "duplicate", "m2")),
			({"status": "accepted", "matchId": "gone"}, ("rejected", "removed", "gone")),
			({"status": "rejected", "reason": "ai_detected"}, ("rejected", "ai_detected", None)),
		]

		for verdict, expected in cases:
			path = self._replay("a.StormReplay")
			files = {_cache_key(path): {"contentHash": _file_content_hash(path), **verdict}}
			ctx = self._ctx(files)
			self.assertEqual(process_replay(path, ctx), expected)

	def test_sandbox_and_unreadable(self):
		path = self._replay("x Sandbox.StormReplay")
		files: dict = {}
		self.assertEqual(process_replay(path, self._ctx(files)), ("rejected", "unwanted_mode", None))
		self.assertEqual(files[_cache_key(path)]["reason"], "unwanted_mode")
		ctx = self._ctx({})
		self.assertEqual(process_replay(os.path.join(self.tmp, "missing.StormReplay"), ctx), ("rejected", "unparseable", None))
		self.assertEqual(ctx.files, {})
		self.assertEqual(len(ctx.errors), 1)


def _custom_raw(roster: int = 5) -> dict:
	toons = [{"region": 2, "realmId": 1, "profileId": 900 + i} for i in range(10)]
	return {
		"timestamp": "2026-09-03T18:23:27", "mapLocalizedName": "Alterac Pass", "gameMode": "Custom", "lobbyMode": "Draft",
		"players": [{"toon": t, "isComputer": False} for t in toons],
	}


class LoungeAcceptanceTests(unittest.TestCase):
	ROSTER = frozenset(f"2-1-{900 + i}" for i in range(5))

	def _classify(self, **kwargs) -> tuple[bool, str]:
		return classify_replay(_custom_raw(), self.ROSTER, frozenset(), None, set(), "m1", frozenset(), **kwargs)

	def test_custom_needs_lounge_registration_or_caller_allowance(self):
		self.assertEqual(self._classify(), (False, "custom_not_lounge"))
		self.assertEqual(self._classify(lounge_ids={"m1"}), (True, "CustomDraft"))
		self.assertEqual(self._classify(allow_custom=True), (True, "CustomDraft"))

	def test_custom_rules_still_apply_after_allowance(self):
		accepted = classify_replay(_custom_raw(), frozenset(["2-1-900", "2-1-901"]), frozenset(), None, set(), "m1", frozenset(), {"m1"})
		self.assertEqual(accepted, (False, "custom_no_5stack"))

	def test_intake_retry_reclassifies_cached_custom_not_lounge(self):
		tmp = tempfile.mkdtemp(prefix="lounge-retry-")
		self.addCleanup(shutil.rmtree, tmp)
		path = os.path.join(tmp, "27399_G1.StormReplay")

		with open(path, "wb") as f:
			f.write(b"lounge copy")

		cached = {"contentHash": _file_content_hash(path), "matchId": "m1", "status": "rejected", "reason": "custom_not_lounge"}
		ctx = ReplayContext(
			config={}, files={_cache_key(path): cached}, roster_toons=self.ROSTER, alt_toons=frozenset(),
			cutoff_date=None, seen_match_ids=set(), removed_ids=set(), out_dir=tmp, archive_dir=tmp, pretty=False,
		)

		with mock.patch.object(batch, "parse_replay_raw", return_value=_custom_raw()), \
				mock.patch.object(batch, "generate_match_id", return_value="m1"), \
				mock.patch.object(batch, "analyze_raw", return_value={"timestamp": "2026-09-03T18:23:27"}), \
				mock.patch.object(batch, "tag_players"), mock.patch.object(batch, "write_match"), \
				mock.patch.object(batch, "write_match_archive"):
			self.assertEqual(process_replay(path, ctx), ("rejected", "custom_not_lounge", "m1"))
			self.assertEqual(process_replay(path, ctx, allow_custom=True), ("new", None, "m1"))

		self.assertEqual(ctx.files[_cache_key(path)]["status"], "accepted")

	def test_official_event_spacing(self):
		self.assertTrue(lounge.is_official_event("[eu]season 9 - division 3 cup"))
		self.assertFalse(lounge.is_official_event("[EU]  Season 9 - Division 3"))

	def test_cached_custom_not_lounge_becomes_duplicate(self):
		tmp = tempfile.mkdtemp(prefix="lounge-cached-")
		self.addCleanup(shutil.rmtree, tmp)
		path = os.path.join(tmp, "own.StormReplay")

		with open(path, "wb") as f:
			f.write(b"own copy")

		entry = {"contentHash": _file_content_hash(path), "matchId": "m1", "status": "rejected", "reason": "custom_not_lounge"}
		ctx = ReplayContext(
			config={}, files={_cache_key(path): dict(entry)}, roster_toons=frozenset(), alt_toons=frozenset(),
			cutoff_date=None, seen_match_ids=set(), removed_ids=set(), out_dir=tmp, archive_dir=tmp, pretty=False,
		)
		self.assertEqual(process_replay(path, ctx), ("rejected", "custom_not_lounge", "m1"))
		ctx.lounge_ids = {"m1"}
		self.assertEqual(process_replay(path, ctx), ("duplicate", "duplicate", "m1"))
		self.assertEqual(ctx.files[_cache_key(path)], dict(entry, reason="duplicate"))

	def test_stamps_ignore_non_official_events(self):
		game = {"game": 1, "won": True, "status": "registered", "matchId": "m1"}
		base = {"id": 1, "season": "S", "seasonNumber": 1, "stage": "regular", "round": "R", "opponent": {"slug": "x", "name": "X"}, "scheduled": None, "bestOf": 1, "score": [1, 0], "games": [game]}
		registry = {"matches": [dict(base, event="[EU] Offseason 25-26 - Group B"), dict(base, id=2, event="Heroes 10th - Heroes 10 Division 2", games=[dict(game, matchId="m2")])]}
		self.assertEqual(lounge.build_stamps(registry), {})
		self.assertEqual(lounge.official_registered_ids(registry), set())
		registry["matches"].append(dict(base, id=3, event="[EU]Season 9 - Division 3 Cup", games=[dict(game, matchId="m3")]))
		self.assertEqual(set(lounge.build_stamps(registry)), {"m3"})
		self.assertEqual(lounge.official_registered_ids(registry), {"m3"})


class _ShortResponse(_Response):
	def __init__(self, body: bytes, length: int):
		super().__init__(body)
		self.headers = {"Content-Length": str(length)}


class DownloadTests(unittest.TestCase):
	REPLAY = "https://heroeslounge.gg/storage/app/uploads/public/6a9/9c1/ddc/6a99c1ddcf066862094303.stormreplay"

	def setUp(self):
		self.tmp = tempfile.mkdtemp(prefix="lounge-download-")
		self.addCleanup(shutil.rmtree, self.tmp)
		patcher = mock.patch.object(lounge, "REQUEST_DELAY_SECONDS", 0)
		patcher.start()
		self.addCleanup(patcher.stop)

	def _opener(self, response):
		opener = mock.Mock()
		opener.open.return_value = response
		return opener

	def test_short_read_raises_and_leaves_nothing(self):
		dest = os.path.join(self.tmp, "r.StormReplay")

		with self.assertRaisesRegex(ValueError, "truncated"):
			lounge.download_replay(self._opener(_ShortResponse(b"x" * 10, 100)), self.REPLAY, dest)

		self.assertEqual(os.listdir(self.tmp), [])

	def test_full_read_with_length(self):
		dest = os.path.join(self.tmp, "r.StormReplay")
		self.assertEqual(lounge.download_replay(self._opener(_ShortResponse(b"x" * 10, 10)), self.REPLAY, dest), 10)
		self.assertTrue(os.path.isfile(dest))


class SidecarTimeoutTests(unittest.TestCase):
	def test_timeout_kills_and_raises(self):
		start = time.monotonic()

		with self.assertRaisesRegex(ValueError, "Replay parser timed out"):
			parser._run_sidecar("unused", timeout=0.5, command=[sys.executable, "-c", "import time; time.sleep(30)"])

		self.assertLess(time.monotonic() - start, 10)

	def test_success_and_failure(self):
		self.assertEqual(parser._run_sidecar("unused", timeout=30, command=[sys.executable, "-c", "print('{\"a\": 1}')"]), {"a": 1})

		with self.assertRaisesRegex(ValueError, "exit 3"):
			parser._run_sidecar("unused", timeout=30, command=[sys.executable, "-c", "import sys; sys.exit(3)"])


if __name__ == "__main__":
	unittest.main()
