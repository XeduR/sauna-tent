# Heroes Lounge intake core: URL policy, page parsing, registry and index stamps.

import copy
import html as html_lib
import http.client
import json
import os
import re
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

SITE = "https://heroeslounge.gg"
ALLOWED_HOSTS = ("heroeslounge.gg", "www.heroeslounge.gg")
USER_AGENT = "sauna-tent-lounge-intake/1.0 (Sauna Tent match history; one request per second)"
REQUEST_DELAY_SECONDS = 1.0
TIMEOUT_SECONDS = 60
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
RECHECK_DAYS = 14
SCHEDULE_WARN_DAYS = 3
REPLAY_PATH_PREFIX = "/storage/app/uploads/public/"

_SLUG_RE = re.compile(r"[A-Za-z0-9_%&!.-]+")
_TEAM_PATH_RE = re.compile(r"/team/view/([^/]+)")
_MATCH_PATH_RE = re.compile(r"/match/view/(\d+)")
_URL_FORMS = f"{SITE}/team/view/<slug> or {SITE}/match/view/<id>"
_CHUNK_BYTES = 64 * 1024

_MONTHS = {
	"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
	"Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

_SCHEDULED_RE = re.compile(r"(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{1,2}):(\d{2}) \(UTC ([+-])(\d{2}):(\d{2})\)")
_REGION_RE = re.compile(r"^\[[A-Z]{2,3}\]\s*")
_SEASON_NUMBER_RE = re.compile(r"\bSeason (\d+)\b")
_DIVISION_RE = re.compile(r"\bDivision (\d+)\b")
OFFICIAL_EVENT_RE = re.compile(r"^\[EU\] ?Season \d+ - Division \d+( Cup)?$", re.IGNORECASE)

_UNRESOLVED_GAME_STATUSES = (None, "no-replay")
_RESOLVED_GAME_STATUSES = ("registered", "rejected", "removed")


class LoungeUrlError(ValueError):
	pass


class LoungeStructureError(ValueError):
	pass


# URL policy

def _check_site_url(url: str) -> tuple:
	"""Scheme, host, userinfo and port rules shared by every URL the intake touches."""
	parts = urlsplit(url)

	try:
		port = parts.port
	except ValueError as e:
		raise LoungeUrlError(f"invalid port in {url!r}") from e

	if parts.scheme != "https":
		raise LoungeUrlError(f"not an https URL: {url!r}")

	if parts.hostname not in ALLOWED_HOSTS:
		raise LoungeUrlError(f"host not allowed: {url!r}")

	if parts.username is not None or parts.password is not None or "@" in parts.netloc:
		raise LoungeUrlError(f"userinfo not allowed: {url!r}")

	if port is not None or parts.netloc.endswith(":"):
		raise LoungeUrlError(f"explicit port not allowed: {url!r}")

	return parts


def validate_slug(slug: str) -> str:
	if not isinstance(slug, str) or not _SLUG_RE.fullmatch(slug):
		raise LoungeUrlError(f"invalid team slug: {slug!r}")

	return slug


def validate_page_url(url: str) -> tuple[str, str | int]:
	try:
		parts = _check_site_url(url)
	except LoungeUrlError as e:
		raise LoungeUrlError(f"{e}; accepted forms: {_URL_FORMS}") from e

	if parts.query or parts.fragment or "?" in url or "#" in url:
		raise LoungeUrlError(f"query or fragment not allowed: {url!r}; accepted forms: {_URL_FORMS}")

	team = _TEAM_PATH_RE.fullmatch(parts.path)

	if team:
		try:
			return "team", validate_slug(team.group(1))
		except LoungeUrlError as e:
			raise LoungeUrlError(f"{e}; accepted forms: {_URL_FORMS}") from e

	match = _MATCH_PATH_RE.fullmatch(parts.path)

	if match:
		return "match", int(match.group(1))

	raise LoungeUrlError(f"unsupported page {url!r}; accepted forms: {_URL_FORMS}")


def team_url(slug: str) -> str:
	return f"{SITE}/team/view/{validate_slug(slug)}"


def match_url(match_id: int) -> str:
	return f"{SITE}/match/view/{int(match_id)}"


def validate_replay_href(href: str, page_url: str) -> str:
	url = urljoin(page_url, href)
	parts = _check_site_url(url)

	if parts.query or parts.fragment or "?" in url or "#" in url:
		raise LoungeUrlError(f"query or fragment not allowed in replay link: {url!r}")

	if not parts.path.startswith(REPLAY_PATH_PREFIX) or not parts.path.lower().endswith(".stormreplay"):
		raise LoungeUrlError(f"unexpected replay link: {url!r}")

	if "/../" in parts.path or "/./" in parts.path:
		raise LoungeUrlError(f"dot segments in replay link: {url!r}")

	return url


# Network

class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
	def redirect_request(self, req, fp, code, msg, headers, newurl):
		_check_site_url(urljoin(req.full_url, newurl))
		return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_opener() -> urllib.request.OpenerDirector:
	return urllib.request.build_opener(SafeRedirectHandler)


def _request(url: str) -> urllib.request.Request:
	return urllib.request.Request(url, headers={"User-Agent": USER_AGENT})


def fetch_text(opener, url: str) -> str:
	_check_site_url(url)

	try:
		with opener.open(_request(url), timeout=TIMEOUT_SECONDS) as response:
			data = response.read(MAX_DOWNLOAD_BYTES + 1)
	finally:
		time.sleep(REQUEST_DELAY_SECONDS)

	if len(data) > MAX_DOWNLOAD_BYTES:
		raise ValueError(f"page larger than {MAX_DOWNLOAD_BYTES} bytes: {url}")

	return data.decode("utf-8")


def download_replay(opener, url: str, dest_path: str) -> int:
	validate_replay_href(url, url)
	part_path = dest_path + ".part"
	written = 0

	try:
		with opener.open(_request(url), timeout=TIMEOUT_SECONDS) as response, open(part_path, "wb") as f:
			while True:
				chunk = response.read(_CHUNK_BYTES)

				if not chunk:
					break

				written += len(chunk)

				if written > MAX_DOWNLOAD_BYTES:
					raise ValueError(f"replay larger than {MAX_DOWNLOAD_BYTES} bytes: {url}")

				f.write(chunk)

			# A dropped connection ends read() early without raising, so a short body must be caught here.
			headers = getattr(response, "headers", None)
			expected = headers.get("Content-Length") if headers is not None else None

			if expected is not None and expected.isdigit() and written != int(expected):
				raise ValueError(f"replay truncated: {written} of {expected} bytes: {url}")

		os.replace(part_path, dest_path)
	except BaseException:
		if os.path.exists(part_path):
			os.remove(part_path)

		raise
	finally:
		time.sleep(REQUEST_DELAY_SECONDS)

	return written


# Page parsing

def _text(s: str) -> str:
	s = re.sub(r"<[^>]+>", " ", s)
	return re.sub(r"\s+", " ", html_lib.unescape(s)).strip()


def _orient_score(slugs: list[str], scores: list[int], team_slug: str, match_id: int) -> list[int]:
	if len(slugs) != 2 or slugs[0] == slugs[1] or team_slug not in slugs:
		raise LoungeStructureError(f"match {match_id}: cannot orient score {list(zip(slugs, scores))} to {team_slug}")

	us = slugs.index(team_slug)
	return [scores[us], scores[1 - us]]


def parse_team_page(html: str, team_slug: str) -> list[dict]:
	tabs = re.findall(r'href="#(roundmatches_group_\d+)"[^>]*>(.*?)</a>', html, re.S)

	if not tabs:
		raise LoungeStructureError("team page has no event tabs")

	rows = {}
	cards = 0

	for tab_id, label in tabs:
		start = html.find(f'id="{tab_id}"')

		if start < 0:
			raise LoungeStructureError(f"team page tab {tab_id} has no pane")

		end = html.find('id="roundmatches_group_', start + 30)
		pane = html[start:end if end > 0 else len(html)]

		for card in re.split(r'<div class="card mb-1', pane)[1:]:
			mid = re.search(r"match/view/(\d+)", card)

			if not mid:
				continue

			cards += 1
			match_id = int(mid.group(1))

			if match_id in rows:
				continue

			# The last card of a pane runs on into trailing page content, so only its first two team links are its own.
			slugs = re.findall(r'team/view/([^"]+)"', card)
			scores = re.findall(r'<span class="f100 spoiler badge[^"]*">\s*(\d+)\s*</span>', card)
			score = None

			if len(scores) == 2:
				score = _orient_score(slugs[:2], [int(s) for s in scores], team_slug, match_id)

			rows[match_id] = {"id": match_id, "event": _text(label), "score": score}

	if not cards:
		raise LoungeStructureError("team page has no match cards")

	return list(rows.values())


def parse_match_page(html: str, match_id: int, page_url: str) -> dict:
	header_end = html.find('id="gameNav"')

	# A match with no games (a bye) has no game navigation; its header is then the whole page.
	header = html[:header_end] if header_end >= 0 else html
	header_text = _text(re.sub(r"<script.*?</script>", "", header, flags=re.S))
	login = re.search(r"Blog Login Username Password Login (.*?)$", header_text)

	if not login:
		raise LoungeStructureError(f"match {match_id}: page header layout not recognised")

	header_text = login.group(1)
	scheduled = re.search(r"Scheduled for (.+?\(UTC [^)]*\))", header_text)
	title = re.split(r" Casted by:| Scheduled for| Not scheduled", header_text)[0].strip()

	if not title:
		raise LoungeStructureError(f"match {match_id}: empty title")

	teams = re.findall(r'<a href="https://heroeslounge.gg/team/view/([^"]+)"[^>]*>\s*([^<]+?)\s*</a>', header)

	if len(teams) < 2:
		raise LoungeStructureError(f"match {match_id}: page has no team links")

	teams = [[validate_slug(slug), html_lib.unescape(name)] for slug, name in teams[-2:]]
	games = []
	panes = re.split(r'<div class="tab-pane[^"]*" id="game(\d+)" role="tabpanel">', html)

	for i in range(1, len(panes), 2):
		body = panes[i + 1]
		replay = re.search(r'href="([^"]+\.stormreplay)"', body, re.I)
		map_name = re.search(r'<span class="badge badge-info">([^<]+)</span>', body)
		side_teams = re.findall(r'<h3>\s*<a href="https://heroeslounge.gg/team/view/([^"]+)"', body)
		levels = re.search(r'<div class="row text-center mb-2">\s*<div class="col-6">(.*?)</div>\s*<div class="col-6">(.*?)</div>', body, re.S)
		winner = None

		if levels and len(side_teams) >= 2:
			if "Winner" in levels.group(1):
				winner = side_teams[0]
			elif "Winner" in levels.group(2):
				winner = side_teams[1]

		picks = re.findall(r'<img src="[^"]*/heroes/[^"]+" title="([^"]+)"[^>]*class="rounded Icon75x"[^>]*/>\s*<figcaption[^>]*title="([^"]*)"', body)

		games.append({
			"game": len(games) + 1,
			"map": html_lib.unescape(map_name.group(1)) if map_name else None,
			"winnerSlug": validate_slug(winner) if winner else None,
			"picks": [{"hero": html_lib.unescape(h), "player": html_lib.unescape(p)} for h, p in picks],
			"replayUrl": validate_replay_href(html_lib.unescape(replay.group(1)), page_url) if replay else None,
		})

	return {
		"id": match_id,
		"title": title,
		"scheduledRaw": scheduled.group(1) if scheduled else None,
		"teams": teams,
		"games": games,
	}


def _strip_region(s: str) -> str:
	return _REGION_RE.sub("", s.strip())


def parse_event(event: str, title: str) -> dict:
	segments = _strip_region(event).split(" - ")
	season = segments[0].strip()
	season_number = _SEASON_NUMBER_RE.search(season)
	division = _DIVISION_RE.search(event)
	stage = "regular"

	if "Bracket" in title:
		stage = "bracket"
	elif "Group" in event or "Group" in title:
		stage = "group"

	rest = _strip_region(title).replace(season, " ", 1)

	for segment in segments[1:]:
		segment = segment.strip()

		# The division segment and a restatement of the season label are context, not round.
		if _DIVISION_RE.search(segment) or norm(segment) == norm(season):
			if segment in rest:
				rest = rest.replace(segment, " ", 1)
			elif division:
				rest = rest.replace(division.group(0), " ", 1)

	round_name = re.sub(r"\s+", " ", rest).strip(" -")

	return {
		"season": season,
		"seasonNumber": int(season_number.group(1)) if season_number else None,
		"division": division.group(1) if division else None,
		"round": round_name or _strip_region(title),
		"stage": stage,
	}


def parse_scheduled(raw: str | None) -> str | None:
	if raw is None:
		return None

	m = _SCHEDULED_RE.fullmatch(raw.strip())

	if not m or m.group(2) not in _MONTHS:
		raise LoungeStructureError(f"unrecognised schedule {raw!r}")

	day, month_name, year, hour, minute, sign, off_h, off_m = m.groups()
	offset = timedelta(hours=int(off_h), minutes=int(off_m))

	if sign == "-":
		offset = -offset

	local = datetime(int(year), _MONTHS[month_name], int(day), int(hour), int(minute), tzinfo=timezone(offset))
	return local.astimezone(timezone.utc).isoformat()


def _slugify(s: str) -> str:
	return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")


def replay_filename(match_id: int, game_no: int, map_name: str | None, opponent_name: str) -> str:
	return f"{match_id}_G{game_no}_{_slugify(map_name or 'map')}_vs-{_slugify(opponent_name)}.StormReplay"


def norm(name: str) -> str:
	return re.sub(r"[^a-z0-9]", "", name.lower().replace("ú", "u"))


# Registry

def best_of(score: list[int] | None) -> int | None:
	if not score or max(score) <= 0:
		return None

	return 2 * max(score) - 1


def _is_bye(opponent: dict) -> bool:
	return opponent["slug"].lower() == "bye" or opponent["name"].strip().upper() == "BYE!"


def _game_has_data(game: dict) -> bool:
	return bool(game["map"] or game["picks"] or game["replayUrl"] or game["winnerSlug"])


def _game_entry(game_no: int, map_name: str | None, won: bool | None, replay_url: str | None, replay_file: str | None) -> dict:
	return {
		"game": game_no,
		"map": map_name,
		"won": won,
		"status": None if replay_url else "no-replay",
		"reason": None,
		"matchId": None,
		"replayUrl": replay_url,
		"replayFile": replay_file,
	}


def build_match_entry(team_row: dict, page: dict, team_slug: str, cutoff_date: str) -> dict:
	match_id = page["id"]

	if team_row["id"] != match_id:
		raise ValueError(f"team row {team_row['id']} does not match page {match_id}")

	others = [t for t in page["teams"] if t[0] != team_slug]

	if len(others) != 1 or len(page["teams"]) != 2:
		raise LoungeStructureError(f"match {match_id}: cannot identify the opponent of {team_slug} in {page['teams']}")

	opponent = {"slug": others[0][0], "name": others[0][1]}
	parsed = parse_event(team_row["event"], page["title"])
	scheduled = parse_scheduled(page["scheduledRaw"])
	score = list(team_row["score"]) if team_row["score"] is not None else None
	data_games = [g for g in page["games"] if _game_has_data(g)]

	if scheduled is not None and scheduled[:10] < cutoff_date:
		status = "pre-cutoff"
	elif score is not None and not data_games:
		status = "forfeit"
	elif data_games:
		status = "played"
	else:
		raise ValueError(f"match {match_id} has no result yet")

	games = []

	if status == "played":
		for g in data_games:
			won = None if g["winnerSlug"] is None else g["winnerSlug"] == team_slug
			replay_file = replay_filename(match_id, g["game"], g["map"], opponent["name"]) if g["replayUrl"] else None
			games.append(_game_entry(g["game"], g["map"], won, g["replayUrl"], replay_file))

		games.extend(_score_proven_games(games, score))

	return {
		"id": match_id,
		"event": team_row["event"],
		"title": page["title"],
		"season": parsed["season"],
		"seasonNumber": parsed["seasonNumber"],
		"division": parsed["division"],
		"round": parsed["round"],
		"stage": parsed["stage"],
		"opponent": opponent,
		"scheduled": scheduled,
		"score": score,
		"bestOf": None if _is_bye(opponent) else best_of(score),
		"status": status,
		"games": games,
	}


def _score_proven_games(games: list[dict], score: list[int] | None) -> list[dict]:
	"""No-replay entries for games the series score proves but the page does not show."""
	if score is None:
		return []

	missing = sum(score) - len(games)

	if missing <= 0:
		return []

	used = {g["game"] for g in games}
	numbers = [n for n in range(1, sum(score) + 1) if n not in used][:missing]
	won = None

	if missing == 1 and all(g["won"] is not None for g in games):
		known_wins = sum(1 for g in games if g["won"])
		known_losses = len(games) - known_wins
		left_wins = score[0] - known_wins
		left_losses = score[1] - known_losses

		if (left_wins, left_losses) in ((1, 0), (0, 1)):
			won = left_wins == 1

	return [_game_entry(n, None, won, None, None) for n in numbers]


def load_registry(path: str, team_slug: str) -> dict:
	if not os.path.exists(path):
		return {"site": SITE, "team": team_slug, "matches": []}

	with open(path, encoding="utf-8") as f:
		registry = json.load(f)

	if registry.get("team") != team_slug:
		raise ValueError(f"{path} belongs to team {registry.get('team')!r}, not {team_slug!r}")

	return registry


def _serialized(registry: dict) -> dict:
	out = copy.deepcopy(registry)
	out["matches"] = sorted(out["matches"], key=lambda m: m["id"])

	for match in out["matches"]:
		for game in match.get("games", []):
			if game.get("status") != "rejected":
				game.pop("reason", None)

	return out


def save_registry(path: str, registry: dict) -> None:
	text = json.dumps(_serialized(registry), indent="\t", ensure_ascii=False) + "\n"
	directory = os.path.dirname(os.path.abspath(path))
	fd, tmp_path = tempfile.mkstemp(prefix=".lounge-", suffix=".tmp", dir=directory)

	try:
		with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
			f.write(text)

		os.replace(tmp_path, path)
	except BaseException:
		if os.path.exists(tmp_path):
			os.remove(tmp_path)

		raise


def merge_match(registry: dict, entry: dict) -> bool:
	existing = next((m for m in registry["matches"] if m["id"] == entry["id"]), None)

	if existing is None:
		registry["matches"].append(copy.deepcopy(entry))
		return True

	changed = False
	games = existing.setdefault("games", [])
	by_number = {g["game"]: i for i, g in enumerate(games)}

	for game in entry.get("games", []):
		index = by_number.get(game["game"])

		if index is None:
			games.append(copy.deepcopy(game))
			changed = True
		elif games[index].get("status") in _UNRESOLVED_GAME_STATUSES and game.get("status") in _RESOLVED_GAME_STATUSES:
			games[index] = copy.deepcopy(game)
			changed = True

	if changed:
		games.sort(key=lambda g: g["game"])

	return changed


def reconcile_removed(registry: dict, removed_ids: set[str]) -> list[str]:
	flipped = []

	for match in registry["matches"]:
		for game in match.get("games", []):
			if game.get("status") == "registered" and game.get("matchId") in removed_ids:
				game["status"] = "removed"
				flipped.append(game["matchId"])

	return flipped


def _as_utc(dt: datetime) -> datetime:
	return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def needs_fetch(entry: dict | None, now: datetime, recheck: bool) -> bool:
	if entry is None:
		return True

	if entry["status"] != "played":
		return False

	games = entry.get("games", [])
	unresolved = not games or any(g.get("status") in _UNRESOLVED_GAME_STATUSES for g in games)

	if not unresolved:
		return False

	if recheck:
		return True

	if entry.get("scheduled") is None:
		return False

	age = _as_utc(now) - datetime.fromisoformat(entry["scheduled"])
	return age < timedelta(days=RECHECK_DAYS)


def _result(won: bool | None) -> str | None:
	if won is None:
		return None

	return "win" if won else "loss"


def is_official_event(event: str) -> bool:
	"""Official season and season-cup events; the only Custom games the pipeline keeps."""
	return isinstance(event, str) and OFFICIAL_EVENT_RE.match(event) is not None


def _official_matches(registry: dict) -> list[dict]:
	return [m for m in registry.get("matches", []) if is_official_event(m.get("event"))]


def official_registered_ids(registry: dict) -> set[str]:
	return {
		g["matchId"] for m in _official_matches(registry) for g in m.get("games", [])
		if g.get("status") == "registered" and g.get("matchId")
	}


def load_official_registered_ids(out_dir: str) -> set[str]:
	"""Registered official Lounge matchIds from <out_dir>/lounge.json; empty when absent."""
	path = os.path.join(out_dir, "lounge.json")

	if not os.path.isfile(path):
		return set()

	with open(path, encoding="utf-8") as f:
		return official_registered_ids(json.load(f))


def build_stamps(registry: dict) -> dict[str, dict]:
	stamps = {}

	for match in _official_matches(registry):
		games = match.get("games", [])
		results = [_result(g.get("won")) for g in games]

		for game in games:
			if game.get("status") != "registered" or not game.get("matchId"):
				continue

			stamps[game["matchId"]] = {
				"id": match["id"],
				"game": game["game"],
				"season": match["season"],
				"seasonNumber": match["seasonNumber"],
				"stage": match["stage"],
				"round": match["round"],
				"opponent": match["opponent"],
				"scheduled": match["scheduled"],
				"bestOf": match["bestOf"],
				"score": match["score"],
				"results": results,
			}

	return stamps


# Page cross-checks

def page_mismatch(page_game: dict, replay: dict, team_slug: str) -> str | None:
	fields = []

	if not page_game.get("map") or norm(page_game["map"]) != norm(replay["map"]):
		fields.append("map")

	picks = page_game.get("picks") or []
	page_heroes = sorted(norm(p["hero"]) for p in picks)
	replay_heroes = sorted(norm(h) for h in replay["heroes"])

	if len(picks) < 10 or page_heroes != replay_heroes:
		fields.append("heroes")

	winner = page_game.get("winnerSlug")

	if winner is None or replay["rosterWon"] != (winner == team_slug):
		fields.append("winner")

	return ", ".join(fields) or None


def game_order_ok(timestamps: list[str]) -> bool:
	times = [_as_utc(datetime.fromisoformat(t)) for t in timestamps]
	return all(a < b for a, b in zip(times, times[1:]))


def schedule_drift_days(scheduled_iso: str | None, replay_timestamp: str) -> float | None:
	if scheduled_iso is None:
		return None

	delta = _as_utc(datetime.fromisoformat(replay_timestamp)) - _as_utc(datetime.fromisoformat(scheduled_iso))
	return delta.total_seconds() / 86400


# Intake run

_DOTTED_TIME_RE = re.compile(r"T(\d\d)\.(\d\d)\.(\d\d)")

# http.client.IncompleteRead and other protocol errors are not OSErrors.
_NETWORK_ERRORS = (OSError, ValueError, http.client.HTTPException)

_OUTCOME_ORDER = (
	"fetched", "registered new", "registered duplicate", "removed", "rejected", "no replay", "would download", "would process",
	"pre-cutoff", "forfeit", "skipped", "not official", "not played yet",
	"fetch failed", "structure error", "download failed", "match file missing", "conflict",
)


class _Lookup:
	"""Committed match files read once per run for the page cross-checks."""

	def __init__(self, matches_dir: str):
		self.matches_dir = matches_dir
		self.cache: dict[str, dict | None] = {}

	def get(self, match_id: str) -> dict | None:
		if match_id not in self.cache:
			path = os.path.join(self.matches_dir, f"{match_id}.json")

			if os.path.isfile(path):
				with open(path, encoding="utf-8") as f:
					self.cache[match_id] = json.load(f)
			else:
				self.cache[match_id] = None

		return self.cache[match_id]


def replay_summary(match: dict) -> dict:
	"""Map, heroes and the roster team's result of a committed match file."""
	players = match.get("players", [])
	roster_team = next((p.get("team") for p in players if p.get("isRoster")), None)
	roster_won = None

	if roster_team is not None:
		roster_won = any(p.get("team") == roster_team and p.get("result") == "win" for p in players)

	return {
		"map": match.get("map", ""),
		"heroes": [p.get("hero", "") for p in players],
		"rosterWon": roster_won,
		"timestamp": _DOTTED_TIME_RE.sub(r"T\1:\2:\3", match.get("timestamp", "")),
	}


def _lounge_config(config: dict) -> dict:
	lounge = config.get("lounge")

	if not isinstance(lounge, dict):
		raise ValueError("pipeline.json has no \"lounge\" object")

	slug = lounge.get("teamSlug")
	directory = lounge.get("replayDirectory")

	if not isinstance(slug, str) or not isinstance(directory, str) or not directory:
		raise ValueError("pipeline.json \"lounge\" needs string teamSlug and replayDirectory")

	validate_slug(slug)
	return lounge


def _match_label(entry: dict) -> str:
	stage = entry.get("round") or entry.get("event") or entry.get("stage") or "?"
	opponent = (entry.get("opponent") or {}).get("name", "?")
	return f"{entry['id']} {stage} vs {opponent}"


def _apply_outcome(game: dict, status: str, reason: str | None, match_id: str | None) -> tuple[str, bool]:
	"""Set a game's registry status from a process_replay result; returns (label, failed)."""
	if status in ("new", "cached", "duplicate"):
		if not match_id:
			return ("rejected no-matchId", True)

		game.update(status="registered", reason=None, matchId=match_id)
		return ("registered new" if status == "new" else "registered duplicate", False)

	game.update(matchId=match_id)

	if reason == "removed":
		game.update(status="removed", reason=None)
		return ("removed", False)

	game.update(status="rejected", reason=reason)
	return (f"rejected {reason}", False)


class _Intake:
	def __init__(self, config: dict, lounge: dict, out_dir: str, archive_dir: str | None, manifest_path: str,
			ci: bool, dry_run: bool, pretty: bool, opener, replay_processor, parser_check):
		from pipeline import batch

		self.batch = batch
		self.config = config
		self.slug = lounge["teamSlug"]
		self.lounge_dir = os.path.join(batch.PROJECT_ROOT, lounge["replayDirectory"])
		self.out_dir = out_dir
		self.archive_dir = archive_dir or batch.DEFAULT_ARCHIVE_DIR
		self.manifest_path = manifest_path
		self.ci = ci
		self.dry_run = dry_run
		self.pretty = pretty
		self.opener = opener
		self.replay_processor = replay_processor or batch.process_replay
		self.parser_check = parser_check or batch.ensure_parser_available
		self.lookup = _Lookup(os.path.join(out_dir, "matches"))
		self.registry: dict = {"matches": []}
		self.manifest = None
		self.ctx = None
		self.outcomes: dict[str, int] = {}
		self.rejected: dict[str, int] = {}
		self.new_ids: list[str] = []
		self.failed = False
		self.changed = False

	def count(self, label: str) -> None:
		key = label

		if label.startswith("rejected "):
			key = "rejected"
			reason = label[len("rejected "):].split(" (")[0]
			self.rejected[reason] = self.rejected.get(reason, 0) + 1
		elif label.startswith("download failed"):
			key = "download failed"

		self.outcomes[key] = self.outcomes.get(key, 0) + 1

	def _ensure_processing(self, removed_ids: set[str]) -> None:
		if self.ctx is not None:
			return

		# Abort before the first download rather than caching every replay as unparseable.
		self.parser_check(non_interactive=self.ci)
		self.manifest = self.batch.load_manifest(self.manifest_path)
		roster_toons, alt_toons = self.batch._load_sauna_toons(self.config)
		seen = self.batch._seed_seen_match_ids(os.path.join(self.out_dir, "matches")) | removed_ids
		self.ctx = self.batch.ReplayContext(
			config=self.config, files=self.manifest["files"], roster_toons=roster_toons, alt_toons=alt_toons,
			cutoff_date=self.config.get("cutoffDate"), seen_match_ids=seen, removed_ids=removed_ids,
			out_dir=self.out_dir, archive_dir=self.archive_dir, pretty=self.pretty, errors=[],
			lounge_ids=official_registered_ids(self.registry),
		)

	def process_game(self, game: dict, page_game: dict | None, removed_ids: set[str]) -> tuple[str, bool]:
		dest = os.path.join(self.lounge_dir, game["replayFile"])

		if self.dry_run:
			return ("would process" if os.path.exists(dest) else "would download", False)

		self._ensure_processing(removed_ids)

		if not os.path.exists(dest):
			try:
				os.makedirs(self.lounge_dir, exist_ok=True)
				download_replay(self.opener, game["replayUrl"], dest)
			except _NETWORK_ERRORS as e:
				return (f"download failed ({e})", True)

		mismatch: list[str] = []

		def precheck(match_data: dict) -> str | None:
			fields = page_mismatch(page_game or {}, replay_summary(match_data), self.slug)

			if fields:
				mismatch.append(fields)

			return fields

		# The intake only processes official series, so their Custom games are allowed.
		status, reason, match_id = self.replay_processor(dest, self.ctx, allow_custom=True, precheck=precheck)
		self.batch.save_manifest(self.manifest, self.manifest_path)

		if status == "new":
			self.new_ids.append(match_id)
			self.changed = True

		label, failed = _apply_outcome(game, status, reason, match_id)
		return (f"{label} ({mismatch[0]})" if mismatch else label, failed)

	def check_page(self, game: dict, page_game: dict | None) -> tuple[str | None, bool]:
		"""Cross-check a registered game's committed match against the page; returns (problem, failed)."""
		match = self.lookup.get(game["matchId"])

		if match is None:
			return ("match file missing", True)

		fields = page_mismatch(page_game or {}, replay_summary(match), self.slug)

		if fields:
			game.update(status="rejected", reason="page-mismatch")
			return (f"rejected page-mismatch ({fields})", False)

		return (None, False)


def run_intake(
	config: dict,
	url: str | None = None,
	output_dir: str | None = None,
	archive_dir: str | None = None,
	manifest_path: str | None = None,
	generate: bool = False,
	pretty: bool = False,
	ci: bool = False,
	recheck: bool = False,
	dry_run: bool = False,
	mode: str | None = None,
	opener=None,
	replay_processor=None,
	parser_check=None,
	now: datetime | None = None,
) -> int:
	"""Fetch the team or match page, register the series in lounge.json; returns the exit code."""
	from pipeline import batch

	try:
		lounge = _lounge_config(config)
	except ValueError as e:
		print(f"ERROR: {e}")
		return 2

	slug = lounge["teamSlug"]
	replay_root = os.path.abspath(os.path.join(batch.PROJECT_ROOT, config["replayDirectory"]))
	lounge_dir = os.path.abspath(os.path.join(batch.PROJECT_ROOT, lounge["replayDirectory"]))

	# The manifest key must match what `process` derives when it scans the same file.
	if os.path.commonpath([replay_root, lounge_dir]) != replay_root:
		print(f"ERROR: lounge.replayDirectory ({lounge_dir}) must sit inside replayDirectory ({replay_root})")
		return 2

	match_only = None

	if url:
		try:
			kind, value = validate_page_url(url)
		except LoungeUrlError as e:
			print(f"ERROR: {e}")
			return 2

		if kind == "team" and value != slug:
			print(f"ERROR: team {value!r} is not the configured lounge.teamSlug {slug!r}")
			return 2

		if kind == "match":
			match_only = value

	if mode == "series" and match_only is None:
		print(f"ERROR: --mode series needs a match URL: {SITE}/match/view/<id>")
		return 2

	if mode == "team" and match_only is not None:
		print(f"ERROR: --mode team needs a team URL ({SITE}/team/view/<slug>) or none for the configured team page")
		return 2

	out_dir = output_dir or os.path.join(batch.PROJECT_ROOT, config["outputDirectory"])
	registry_path = os.path.join(out_dir, "lounge.json")

	try:
		registry = load_registry(registry_path, slug)
	except ValueError as e:
		print(f"ERROR: {e}")
		return 2

	removed_ids = batch._load_removed_ids(out_dir)
	intake = _Intake(
		config, lounge, out_dir, archive_dir, manifest_path or batch.DEFAULT_MANIFEST_PATH,
		ci, dry_run, pretty, opener or build_opener(), replay_processor, parser_check,
	)
	intake.registry = registry
	flipped = reconcile_removed(registry, removed_ids)

	if flipped:
		print(f"  Tombstoned since registration: {', '.join(flipped)}")
		intake.changed = True

		if not dry_run:
			save_registry(registry_path, registry)

	print(f"  Fetching {team_url(slug)}")

	try:
		rows = parse_team_page(fetch_text(intake.opener, team_url(slug)), slug)
	except (LoungeStructureError, LoungeUrlError) as e:
		print(f"  ERROR: structure error: {e}")
		return _finish(intake, config, output_dir, generate, pretty, 1)
	except _NETWORK_ERRORS as e:
		print(f"  ERROR: team page fetch failed: {e}")
		return _finish(intake, config, output_dir, generate, pretty, 1)

	if match_only is not None:
		rows = [r for r in rows if r["id"] == match_only]

		if not rows:
			print(f"  ERROR: match {match_only} is not listed on {team_url(slug)}")
			return _finish(intake, config, output_dir, generate, pretty, 1)

		if not is_official_event(rows[0]["event"]):
			print(f"  ERROR: match {match_only} belongs to {rows[0]['event']!r}, not an official season or season cup; nothing was registered")
			return 2

	now = now or datetime.now(timezone.utc)
	existing = {m["id"]: m for m in registry["matches"]}

	for row in sorted(rows, key=lambda r: r["id"]):
		if not is_official_event(row["event"]):
			print(f"  {row['id']} {row['event']}: skipped (not an official season)")
			intake.count("not official")
			continue

		entry = existing.get(row["id"])

		if match_only is None and not needs_fetch(entry, now, recheck):
			label = _match_label(entry)
			print(f"  {label}: skipped ({entry['status']})")
			intake.count("skipped")
			continue

		_intake_match(intake, registry, registry_path, row, entry, removed_ids)

	return _finish(intake, config, output_dir, generate, pretty, 1 if intake.failed else 0)


def _intake_match(intake: _Intake, registry: dict, registry_path: str, row: dict, entry: dict | None,
		removed_ids: set[str]) -> None:
	page_url = match_url(row["id"])
	label = _match_label(entry or row)

	try:
		page = parse_match_page(fetch_text(intake.opener, page_url), row["id"], page_url)
	except (LoungeStructureError, LoungeUrlError) as e:
		print(f"  {label}: structure error ({e})")
		intake.count("structure error")
		intake.failed = True
		return
	except _NETWORK_ERRORS as e:
		print(f"  {label}: fetch failed ({e})")
		intake.count("fetch failed")
		intake.failed = True
		return

	intake.count("fetched")

	try:
		new_entry = build_match_entry(row, page, intake.slug, intake.config.get("cutoffDate", ""))
	except LoungeStructureError as e:
		print(f"  {label}: structure error ({e})")
		intake.count("structure error")
		intake.failed = True
		return
	except ValueError as e:
		print(f"  {label}: not played yet ({e})")
		intake.count("not played yet")
		return

	label = _match_label(entry or new_entry)

	if new_entry["status"] != "played":
		print(f"  {label}: {new_entry['status']}")
		intake.count(new_entry["status"])
		_merge(intake, registry, registry_path, new_entry)
		return

	page_games = {g["game"]: g for g in page["games"]}
	old_games = {g["game"]: g for g in (entry or {}).get("games", [])}
	parts = []
	match_failed = False

	for i, game in enumerate(new_entry["games"]):
		old = old_games.get(game["game"])

		if old is not None and old.get("status") in _RESOLVED_GAME_STATUSES:
			new_entry["games"][i] = copy.deepcopy(old)
			continue

		if not game.get("replayUrl"):
			parts.append(f"G{game['game']} no replay")
			intake.count("no replay")
			continue

		outcome, failed = intake.process_game(game, page_games.get(game["game"]), removed_ids)

		# An unparseable replay is a resolved rejection: it fails the run but still registers.
		if game.get("status") == "rejected" and game.get("reason") == "unparseable":
			intake.failed = True

		if game.get("status") == "registered":
			problem, check_failed = intake.check_page(game, page_games.get(game["game"]))

			if problem:
				outcome = problem
				failed = failed or check_failed

		intake.count(outcome)
		match_failed = match_failed or failed
		detail = game["matchId"] if game.get("status") == "registered" else game["replayFile"] if intake.dry_run else None
		parts.append(f"G{game['game']} {outcome}" + (f" {detail}" if detail else ""))

	if not intake.dry_run and not match_failed:
		timestamps = []

		for game in new_entry["games"]:
			if game.get("status") != "registered":
				continue

			match = intake.lookup.get(game["matchId"])

			if match is None:
				continue

			ts = replay_summary(match)["timestamp"]
			timestamps.append(ts)
			drift = schedule_drift_days(new_entry["scheduled"], ts)

			if drift is not None and abs(drift) > SCHEDULE_WARN_DAYS:
				parts.append(f"WARNING G{game['game']} is {drift:+.1f} days from the scheduled time")

		if not game_order_ok(timestamps):
			parts.append("conflict (replay times do not follow game order)")
			intake.count("conflict")
			match_failed = True

	print(f"  {label}: " + ("; ".join(parts) if parts else "nothing new"))

	if match_failed:
		intake.failed = True
		print(f"    {new_entry['id']} not registered; a re-run retries it")
		return

	_merge(intake, registry, registry_path, new_entry)


def _merge(intake: _Intake, registry: dict, registry_path: str, entry: dict) -> None:
	if intake.dry_run:
		return

	if merge_match(registry, entry):
		intake.changed = True
		save_registry(registry_path, registry)


def _finish(intake: _Intake, config: dict, output_dir: str | None, generate: bool, pretty: bool, code: int) -> int:
	verb = "Would be" if intake.dry_run else "Result"
	counts = ", ".join(f"{intake.outcomes[k]} {k}" for k in _OUTCOME_ORDER if intake.outcomes.get(k))
	print(f"  {verb}: {counts or 'nothing fetched'}")

	for reason, count in sorted(intake.rejected.items()):
		print(f"    rejected {reason}: {count}")

	if intake.new_ids:
		print(f"  New committed matches ({len(intake.new_ids)}): {', '.join(intake.new_ids)}")

	errors = intake.ctx.errors if intake.ctx is not None else []

	if errors:
		print(f"  Parse failures ({len(errors)}):")

		for path, err in errors:
			print(f"    {path}: {err}")

	if generate and intake.changed and not intake.dry_run:
		print("\nGenerating dashboard")
		intake.batch.generate_output(config, output_dir, pretty)

	return code
