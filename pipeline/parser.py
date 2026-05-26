# Replay parser. Spawns the heroes-replay-parser-cs sidecar (a dotnet global
# tool) to do all MPQ + protocol decoding, then applies Sauna Tent analysis
# on top: hero/map name resolution, ARAM detection, KDA, chat toxicity,
# glhf/gg behaviour flags, integrity checks.

import json
import os
import re
import shutil
import subprocess

from pipeline.herodata import HERO_NAMES, MAP_NAMES, ARAM_MAP_IDS
from pipeline.toxicity import is_toxic

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TOOL_COMMAND = "heroes-replay-parser-cs"
_PARSER_SOURCE_DIR = os.path.join(_PROJECT_ROOT, "tools", "replay-parser-cs")
_NUPKG_DIR = os.path.join(_PARSER_SOURCE_DIR, "nupkg")

# Game runs at 16 loops per second
_LOOPS_PER_SECOND = 16

# Chat behaviour analysis
_CHAT_NORMALIZE_RE = re.compile(r"[^a-z0-9 &]")
_GLHF_PATTERNS = frozenset({"gl", "hf", "gl hf", "gl & hf", "glhf"})
_GG_PATTERNS = frozenset({"gg", "ggs"})
_GLHF_THRESHOLD_LOOPS = 60 * _LOOPS_PER_SECOND
_GG_EARLY_BUFFER_LOOPS = 15 * _LOOPS_PER_SECOND
# Messages within this window before match end are treated as post-result
# pleasantries and excluded from Overview win-rate chat classification.
_CHAT_LATE_GAME_LOOPS = 60 * _LOOPS_PER_SECOND

# Library emits StormGameMode.ToString() which is a [Flags] enum. When more
# than one bit is set, ToString produces a comma-separated string; this
# tuple is the resolution priority (most specific first).
_GAME_MODE_PRIORITY = (
	"ARAM", "StormLeague", "HeroLeague", "TeamLeague", "UnrankedDraft",
	"Brawl", "Cooperative", "QuickMatch", "Custom", "Event",
	"TryMe", "Practice",
)

_SDK_GUIDANCE = (
	"The .NET 8.0 SDK must be installed before heroes-replay-parser-cs can be\n"
	"installed or run. Download (pick 'SDK', x64 Windows installer):\n"
	"  https://dotnet.microsoft.com/download/dotnet/8.0\n"
	"\n"
	"After install, open a NEW terminal and re-run."
)


def _normalize_chat(text: str) -> str:
	"""Lowercase + strip non-alnum for pattern matching."""
	return " ".join(_CHAT_NORMALIZE_RE.sub("", text.strip().lower()).split())


def _resolve_game_mode(game_mode: str, lobby_mode: str, map_internal_id: str | None) -> str:
	"""Resolve the C#-emitted game mode into the dashboard's expected string."""
	if not game_mode:
		return "Unknown"

	# Flags enum may emit "ARAM, QuickMatch" if multiple bits are set.
	if "," in game_mode:
		parts = {p.strip() for p in game_mode.split(",")}
		for candidate in _GAME_MODE_PRIORITY:
			if candidate in parts:
				game_mode = candidate
				break
		else:
			game_mode = "Unknown"

	# Preserve historical "CustomStandard" / "CustomDraft" labels. Downstream
	# aggregate.py and output.py filter on both as distinct game modes.
	if game_mode == "Custom":
		if lobby_mode == "Standard":
			return "CustomStandard"
		if lobby_mode in ("Draft", "TournamentDraft"):
			return "CustomDraft"

	# Belt-and-suspenders ARAM fallback in case the library tags an ARAM
	# replay as QuickMatch.
	if game_mode == "QuickMatch" and map_internal_id and map_internal_id in ARAM_MAP_IDS:
		return "ARAM"

	return game_mode


def is_parser_installed() -> bool:
	"""Check whether heroes-replay-parser-cs is registered as a global dotnet tool."""
	try:
		result = subprocess.run(
			["dotnet", "tool", "list", "--global"],
			capture_output=True, text=True, check=True,
		)
	except (subprocess.CalledProcessError, FileNotFoundError):
		return False
	return any(_TOOL_COMMAND in line.lower() for line in result.stdout.splitlines())


def _list_dotnet_sdks() -> list[str]:
	"""Return installed .NET SDK version lines (empty if dotnet missing or runtime-only)."""
	try:
		result = subprocess.run(
			["dotnet", "--list-sdks"], capture_output=True, text=True, check=True,
		)
	except (subprocess.CalledProcessError, FileNotFoundError):
		return []
	return [line for line in result.stdout.splitlines() if line.strip()]


def _prompt_yes_no(message: str) -> bool:
	try:
		answer = input(f"{message} [y/N]: ").strip().lower()
	except EOFError:
		return False
	return answer == "y"


def _nupkg_exists() -> bool:
	"""True if at least one .nupkg file is present in the nupkg directory."""
	if not os.path.isdir(_NUPKG_DIR):
		return False
	return any(name.endswith(".nupkg") for name in os.listdir(_NUPKG_DIR))


def _pack_parser() -> None:
	"""Run `dotnet pack` in the sidecar source directory to produce the nupkg."""
	if not os.path.isdir(_PARSER_SOURCE_DIR):
		raise SystemExit(
			f"Cannot build: parser source directory missing: {_PARSER_SOURCE_DIR}"
		)
	print(f"Building {_TOOL_COMMAND} (dotnet pack)...")
	subprocess.run(
		["dotnet", "pack", "-c", "Release", "-o", _NUPKG_DIR],
		cwd=_PARSER_SOURCE_DIR, check=True,
	)


def _install_parser() -> None:
	"""Install heroes-replay-parser-cs as a global dotnet tool, building the nupkg if needed."""
	if not _nupkg_exists():
		_pack_parser()
	print(f"Installing {_TOOL_COMMAND} ...")
	subprocess.run(
		["dotnet", "tool", "install", "--global", "--add-source", _NUPKG_DIR, _TOOL_COMMAND],
		check=True,
	)
	print(f"{_TOOL_COMMAND} installed.")


def ensure_parser_available() -> None:
	"""Verify dotnet + the parser tool are available; prompt to install the tool if missing.

	Aborts via SystemExit if dotnet itself is missing or the user declines.
	Intended for one-shot startup checks (batch.py); parse_replay does not
	call this itself to avoid per-replay overhead.
	"""
	if shutil.which("dotnet") is None:
		raise SystemExit("ERROR: 'dotnet' was not found on PATH.\n\n" + _SDK_GUIDANCE)
	if not _list_dotnet_sdks():
		raise SystemExit(
			"ERROR: no .NET SDK is installed (the runtime alone cannot install global tools).\n\n"
			+ _SDK_GUIDANCE
		)
	if is_parser_installed():
		return
	print(f"{_TOOL_COMMAND} is not installed as a global dotnet tool.")
	print(r"It will be installed into %USERPROFILE%\.dotnet\tools (user-scoped, no admin).")
	if not _prompt_yes_no(f"Install {_TOOL_COMMAND} now? (builds the nupkg via dotnet pack if missing)"):
		raise SystemExit(
			"Aborted. To install manually:\n"
			f"  cd tools/replay-parser-cs && dotnet pack -c Release -o ./nupkg\n"
			f"  dotnet tool install --global --add-source ./nupkg {_TOOL_COMMAND}"
		)
	_install_parser()


def _run_sidecar(replay_path: str) -> dict:
	"""Invoke the C# sidecar and return its JSON output as a dict."""
	try:
		proc = subprocess.run(
			[_TOOL_COMMAND, replay_path],
			capture_output=True, text=True, encoding="utf-8",
		)
	except FileNotFoundError as e:
		raise ValueError(
			f"Replay parser binary not found on PATH: {_TOOL_COMMAND}. "
			"Run `dotnet tool install --global --add-source tools/replay-parser-cs/nupkg heroes-replay-parser-cs`."
		) from e

	if proc.returncode != 0:
		raise ValueError(
			f"Replay parser failed (exit {proc.returncode}): {proc.stderr.strip()}"
		)

	try:
		return json.loads(proc.stdout)
	except json.JSONDecodeError as e:
		raise ValueError(f"Replay parser emitted invalid JSON: {e}") from e


def _trim_talents(choices: list) -> list:
	"""Drop trailing None entries to match the variable-length output of the
	old Python parser (which only populated up to the highest tier reached)."""
	end = len(choices)
	while end > 0 and choices[end - 1] is None:
		end -= 1
	return choices[:end]


def _apply_chat_analysis(players: list, chat_records: list, elapsed_loops: int, game_mode: str) -> None:
	"""Run toxicity + glhf + offensive-gg analysis from raw chat records."""
	num_players = len(players)
	chat_late_threshold = elapsed_loops - _CHAT_LATE_GAME_LOOPS

	for record in chat_records:
		player_idx = record["playerIndex"]
		if player_idx < 0 or player_idx >= num_players:
			continue
		gameloop = record.get("gameloop", 0)
		recipient = record["recipient"]
		text = record.get("text") or ""
		is_late = gameloop >= chat_late_threshold
		stats = players[player_idx]["stats"]

		stats["chatMessages"] = stats.get("chatMessages", 0) + 1
		if recipient == 0:
			stats["chatMessagesAll"] = stats.get("chatMessagesAll", 0) + 1
		elif recipient == 1:
			stats["chatMessagesTeam"] = stats.get("chatMessagesTeam", 0) + 1
			if is_late:
				stats["chatMessagesTeamLate"] = stats.get("chatMessagesTeamLate", 0) + 1

		if text and is_toxic(text):
			stats["chatToxicMessages"] = stats.get("chatToxicMessages", 0) + 1
			if is_late:
				stats["chatToxicMessagesLate"] = stats.get("chatToxicMessagesLate", 0) + 1

	# Per-player clean/toxic game flags for HoF/HoS
	for p in players:
		s = p["stats"]
		total_chat = s.get("chatMessages", 0)
		toxic_chat = s.get("chatToxicMessages", 0)
		if total_chat > 0 and toxic_chat == 0:
			s["chatGamesClean"] = 1
		if toxic_chat > 0:
			s["chatGamesToxic"] = 1

	# Sportsmanlike greeting in first 60 seconds
	for record in chat_records:
		if record.get("gameloop", 0) > _GLHF_THRESHOLD_LOOPS:
			continue
		text = record.get("text") or ""
		if _normalize_chat(text) in _GLHF_PATTERNS:
			pi = record["playerIndex"]
			if 0 <= pi < num_players:
				players[pi]["stats"]["chatGlhf"] = 1

	# Offensive gg only meaningful in custom games (all-chat available)
	if game_mode != "Custom":
		return

	winning_team = None
	losing_team = None
	for p in players:
		if p["result"] == "win":
			winning_team = p["team"]
		elif p["result"] == "loss":
			losing_team = p["team"]
		if winning_team is not None and losing_team is not None:
			break

	gg_early_threshold = elapsed_loops - _GG_EARLY_BUFFER_LOOPS

	loser_first_gg_loop = None
	if losing_team is not None:
		for record in sorted(chat_records, key=lambda r: r.get("gameloop", 0)):
			text = record.get("text") or ""
			if _normalize_chat(text) not in _GG_PATTERNS:
				continue
			pi = record["playerIndex"]
			if 0 <= pi < num_players and players[pi]["team"] == losing_team:
				loser_first_gg_loop = record.get("gameloop", 0)
				break

	for record in chat_records:
		text = record.get("text") or ""
		if _normalize_chat(text) not in _GG_PATTERNS:
			continue
		pi = record["playerIndex"]
		if pi < 0 or pi >= num_players:
			continue
		gameloop = record.get("gameloop", 0)
		is_offensive = False
		if gameloop < gg_early_threshold:
			is_offensive = True
		if (winning_team is not None and players[pi]["team"] == winning_team
				and loser_first_gg_loop is not None and gameloop < loser_first_gg_loop):
			is_offensive = True
		if is_offensive:
			players[pi]["stats"]["chatOffensiveGg"] = 1


def parse_replay_raw(replay_path: str) -> dict:
	"""Run the C# sidecar and return its raw JSON output verbatim.

	Used by remove_replays.py for filtering decisions on every replay,
	including incomplete games that parse_replay() rejects. No analysis
	or transformation is applied; the dict shape matches MatchJson.cs.

	Raises:
		FileNotFoundError: If the replay file doesn't exist.
		ValueError: If the sidecar exits non-zero or returns invalid JSON.
	"""
	if not os.path.isfile(replay_path):
		raise FileNotFoundError(f"Replay not found: {replay_path}")
	return _run_sidecar(replay_path)


def resolve_game_mode(raw: dict) -> str:
	"""Resolve a raw sidecar dict into the dashboard's expected mode string.

	Exposed so remove_replays.py classifies modes the same way as parse_replay.
	"""
	return _resolve_game_mode(
		raw.get("gameMode") or "",
		raw.get("lobbyMode") or "",
		raw.get("mapInternalId"),
	)


def parse_replay(replay_path: str) -> dict:
	"""Parse a single .StormReplay file and return structured data.

	Args:
		replay_path: Path to the .StormReplay file.

	Returns:
		Dict with match metadata, player stats, and talent data.

	Raises:
		FileNotFoundError: If the replay file doesn't exist.
		ValueError: If the sidecar fails to parse the file, returns invalid
			data, or the match is incomplete (score data missing).
	"""
	raw = parse_replay_raw(replay_path)

	if raw.get("isIncomplete"):
		raise ValueError("Score data missing - incomplete game")

	map_internal_id = raw.get("mapInternalId")
	map_localized_name = raw.get("mapLocalizedName") or ""
	if map_internal_id:
		map_name = MAP_NAMES.get(map_internal_id, map_internal_id)
	else:
		map_name = map_localized_name

	game_mode = _resolve_game_mode(
		raw.get("gameMode") or "",
		raw.get("lobbyMode") or "",
		map_internal_id,
	)

	players = []
	for raw_player in raw.get("players", []):
		hero_internal = raw_player.get("heroInternal")
		hero_name = (
			HERO_NAMES.get(hero_internal, hero_internal)
			if hero_internal else raw_player.get("heroLocalizedFallback", "")
		)
		players.append({
			"name": raw_player.get("name", ""),
			"hero": hero_name,
			"team": raw_player.get("team", -1),
			"result": raw_player.get("result", ""),
			"toon": {
				"region": raw_player.get("toon", {}).get("region"),
				"realmId": raw_player.get("toon", {}).get("realmId"),
				"profileId": raw_player.get("toon", {}).get("profileId"),
			},
			"heroLevel": raw_player.get("heroLevel"),
			"talentChoices": _trim_talents(raw_player.get("talentChoices", [])),
			"stats": dict(raw_player.get("stats", {})),
		})

	# Chat / toxicity / behaviour analysis (consumes the intermediate
	# chatRecords array emitted by the C# sidecar).
	chat_records = raw.get("chatRecords", [])
	elapsed_loops = raw.get("elapsedGameLoops", 0)
	_apply_chat_analysis(players, chat_records, elapsed_loops, game_mode)

	# Resolve draft hero names (same internal-ID mapping as played heroes)
	draft = []
	for entry in raw.get("draft", []):
		draft.append({
			"type": entry.get("type", ""),
			"hero": HERO_NAMES.get(entry.get("hero", ""), entry.get("hero", "")),
			"team": entry.get("team", -1),
		})

	# Derived: KDA per player
	for p in players:
		s = p["stats"]
		kills = s.get("kills", 0)
		deaths = s.get("deaths", 0)
		assists = s.get("assists", 0)
		s["kda"] = round((kills + assists) / max(deaths, 1), 2)

	return {
		"map": map_name,
		"timestamp": raw.get("timestamp", ""),
		"durationSeconds": round(raw.get("durationSeconds", 0), 1),
		"build": raw.get("build", 0),
		"gameMode": game_mode,
		"randomSeed": raw.get("randomSeed", 0),
		"players": players,
		"firstBloodTeam": raw.get("firstBloodTeam"),
		"firstToLevel": raw.get("firstToLevel", {}),
		"teamLevels": raw.get("teamLevels"),
		"firstBossTeam": raw.get("firstBossTeam"),
		"firstMercTeam": raw.get("firstMercTeam"),
		"draft": draft,
	}
