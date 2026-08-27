# Pipeline

Replay processing pipeline for the Sauna Tent dashboard. Decodes `.StormReplay` files via the C# `heroes-replay-parser-cs` sidecar, applies Sauna Tent analysis on top, aggregates stats, and outputs pre-computed JSON for the static frontend.

## Modules

- **parser.py**: Spawns the `heroes-replay-parser-cs` sidecar (a dotnet global tool), then layers Sauna Tent analysis on the intermediate JSON: hero/map name resolution, ARAM detection from map IDs, talent trimming, chat toxicity / glhf / offensive-gg classification, and KDA. Exposes `parse_replay` (file -> analysed match), `parse_replay_raw` (file -> raw sidecar dict), and `analyze_raw` (raw dict -> analysed match) so the batch classifier can parse once and analyse the same dict. Its `ensure_parser_available` check is version-aware: it rebuilds and reinstalls the sidecar when the installed global tool does not match the csproj `<Version>`, and it aborts when the tool is installed but unreachable on PATH (`dotnet tool list` reports it either way, and every parse would otherwise fail and be cached as an `unparseable` verdict).
- **run.py**: Single-replay processor and shared match helpers. `tag_players` re-derives roster/alt/party tags from toon IDs (idempotent, reused by retag), `write_match` writes the tier-1 match JSON (filtered to the committed schema via an explicit whitelist), `write_match_archive` writes the tier-2 archive, and `process_single` ties parse + tag + write together for the standalone CLI.
- **batch.py**: Batch processor and management CLI. Classifies and parses new/changed replays in a single pass, writing per-match tier-1 JSON plus the tier-2 archive. Subcommands: `process` (default), `retag`, `remove-match`. See "Processing model" below.
- **aggregate.py**: Reads all match JSON files and computes aggregate statistics across every combination of player, hero, map, game mode, and party size, plus talent builds. It also declares the Hall of Fame cumulative stat keys (`_HOF_CUMULATIVE_CATEGORIES` / `HOF_INDEX_STAT_KEYS`) that `output.py` writes into each player's `hof` dict in the match index; the Hall of Fame page itself is computed client-side from that index (no standalone HoF artifact is produced).
- **output.py**: Writes the final dashboard JSON files (summary, roster, per-player, per-hero, per-map, match index).
- **herodata.py**: Static lookup tables mapping the library's internal hero/map IDs to display names. Also exports `ARAM_MAP_IDS` / `ARAM_MAP_NAMES`, the `HERO_ROLES` map used by `output.py`, and the `FEMALE_HEROES` set used by `output.py` to flag female-hero games in the match index.
- **toxicity.py**: Loads `toxic_keywords.txt` and exposes `is_toxic(message)` for case-insensitive substring matching against chat messages. Keywords are loaded once and cached.
- **toxic_keywords.txt**: One toxic keyword or phrase per line. Comments start with `#`. Edit this file to adjust toxicity detection without touching code.

## Dependencies

- **heroes-replay-parser-cs**: vendored .NET 8 console app under `tools/replay-parser-cs/` that wraps [Heroes.StormReplayParser](https://github.com/HeroesToolChest/Heroes.StormReplayParser). Installed as a user-scoped dotnet global tool. The Python pipeline owns the analysis layer; the sidecar only decodes the MPQ archive and exposes the library's parsed object model as JSON. The sidecar emits a superset extract (see "Match data tiers"); the pipeline decides what is served versus archived.

## Match data tiers

The sidecar emits a single superset `MatchJson`. The pipeline splits it into two tiers so replays can be discarded once processed while the served dashboard schema stays stable.

- **Tier-1** (`data/matches/<matchId>.json`, committed, served): exactly the current dashboard schema. `write_match` filters the analysed dict through an explicit top-level and per-player key whitelist (`_TIER1_TOPLEVEL_KEYS` / `_TIER1_PLAYER_KEYS` in `run.py`); the `stats` and `toon` objects pass through whole. The per-player `matchAwardsList` (named end-of-match awards) is whitelisted into tier-1 so the frontend can build award leaderboards; it comes from the score-result event, so it is populated for every match parsed by the current sidecar (a match file written before the backfill has no such key at all). Values inside existing fields may legitimately change from the committed data: timestamps now use ISO colon separators (a culture-sensitive format bug previously emitted dotted times on `fi-FI`), and `stats.disconnects` / `stats.disconnectedAtEnd` populate for leaver games (they were structurally absent while game-event parsing was off).
- **Tier-2** (`archive/<matchId>.json.gz` at the repo root, gitignored, not served): the sidecar superset plus `matchId` / `replayFile` bookkeeping. This is the disposable-replay archive. It is not a literal copy of the replay: it holds the approved extraction categories (the preserved list below) and deliberately discards the rest, so the `.StormReplay` can be discarded once the archived categories are enough. The gzip stream is deterministic (`mtime=0`, no embedded filename) so reruns are byte-identical. The location is fixed by `archive_path()` in `run.py` (the single source of truth), independent of `--output-dir`; override with `--archive-dir` for sandboxing. Written on accept alongside the tier-1 file; removed by `remove-match`; never touched by `retag`.

### Extraction inventory (tier-2 superset)

Preserved, per player, beyond the tier-1 fields: the cosmetic `loadout` (skin/mount/banner/spray/announcer/voiceLine plus AttributeId variants), `scoreExtended` (TownKills, WatchTowerCaptures, MinionDamage, ClutchHealsPerformed, EscapesPerformed, VengeancesPerformed, OutnumberedDeaths, TeamfightEscapesPerformed), and `miscScore` (named TimeOnPoint/TimeInTemple/TimeOnPayload/KilledTreasureGoblin plus the entire `MiscellaneousScoreResultEvents` dict, values raw). Per match: complete `levelTimeline` and `xpBreakdown` per team; the `killFeed` (PlayerDeath victim + all killers/assists + position); `heroUnitDeaths` positions (hero deaths only); the full `jungleCamps` and `draftTimeline` (with gameloops); `unitPositions` snapshots (raw decoded arrays); generic `statEvents` (every tracker StatGameEvent not consumed by a dedicated path, so per-map objective events are preserved without per-map code); and, from game events, `abilityCommands` (SCmdEvent casts carrying m_abil), `talentSelections`, `triggerPings`, `pings`, and `playerLeaveJoin`.

Deliberately discarded (not stored anywhere): the high-volume game-event noise types `SCameraUpdateEvent`, `SCmdUpdateTargetPointEvent`, `SCommandManagerStateEvent`, `STriggerKeyPressedEvent`, and `SSelectionDeltaEvent`; non-ability SCmdEvents (move / attack-move commands with no m_abil substructure); every game-event type not in the preserved list above (unit clicks, dialog control, sound offsets, transmissions, and other middle-tier events); and non-hero unit deaths (minions, mercs, structures, summons). This exclusion list is deliberate and subject to explicit sign-off. Ability and unit-position decoding is preservation-first: values are stored as the library decodes them, with interpretation caveats noted in code comments (abilLink is a build-dependent id; the `unitPositions` triplet scale is unconfirmed).

### Timestamp format migration

The committed dataset was recorded on a `fi-FI` machine and carries dotted time separators (`2024-05-24T19.12.17`); the sidecar now emits ISO colons (`2024-05-24T19:12:17`). The two must not be mixed: aggregation, output, and the frontend compare timestamps as full strings, so a colon-format match landing on a date that already has dotted committed matches breaks those comparisons. The migration is one atomic backfill that rewrites every match file to ISO in a single pass:

```bash
python -m pipeline.batch process --reprocess --generate
```

This requires all replays to be present on disk. Incremental appends before the backfill are unsupported; `process` prints a prominent warning when it writes new (ISO) matches into a still-dotted dataset (detected by sampling the committed match files).

## Processing model

The committed `data/matches/*.json` files plus `data/matches/index.json` are the canonical registry of processed matches, and `data/removed-matches.json` is the committed tombstone registry of matches an operator has explicitly removed. `manifest.json` (project root, gitignored) is a purely local performance cache mapping each replay's project-relative path (forward-slash keys) to its content hash and classification verdict, so unchanged replays are never re-parsed. The cache never drives deletion: a match JSON is only removed by an explicit `remove-match` (which also tombstones it), never because a replay file went missing.

Replays are disposable inputs. `process` is fully functional with `replays/` absent or empty: it finds nothing new to parse and downstream steps operate on the committed data alone (the sidecar is only required when there are replays to parse). The dedup set is seeded from the committed match filenames, not from the manifest.

Each new or changed replay is parsed once via the sidecar and classified against every acceptance rule. Accepted replays are analysed from that same parsed dict and written as a tier-1 match JSON plus a tier-2 archive (see "Match data tiers"); rejected and duplicate replays are recorded in the cache with a reason and skipped on later runs. Rejected and duplicate replay files are never deleted; the run prints counts per reason.

### Commands

- `python -m pipeline.batch process [--reprocess] [--generate] [--pretty] [--ci] [--summary-out PATH]`: classify + parse new replays and write tier-1 match JSON + tier-2 archives, optionally aggregating and writing dashboard output. `--reprocess` clears the cache and re-derives from the replays present on disk. `--ci` never prompts (auto-(re)installs the sidecar). `--summary-out` writes a machine-readable JSON run summary (processed, duplicates, rejected-by-reason, new matchIds, and the tier-2 archive dir + per-match archive paths). Running with no subcommand defaults to `process`, so the old flag-only form still works.
- `python -m pipeline.batch retag [--pretty]`: re-derive `isRoster` / `rosterName` / `isAlt` / `altName` / `partySize` / `partyMembers` for every committed match from the toon IDs stored inside it plus the current `pipeline.json`, rewriting each file in place (and normalising `replayFile` to forward slashes). Needs no replays. Run this after a roster/alt rename, then regenerate output.
- `python -m pipeline.batch remove-match <matchId>`: delete one match's tier-1 JSON from `data/matches/` and its tier-2 archive from `archive/`, and append its id to `data/removed-matches.json`, a committed tombstone registry (a plain JSON array). Tombstoned matches are never re-created by `process` or `--reprocess`, nor by a re-uploaded overlapping replay; such a replay is classified as rejected with reason `removed`. To un-remove a match, delete its id from `data/removed-matches.json` and run `process --reprocess`. Aggregates must be regenerated afterwards.

### Config changes

A change to `roster`, `alts`, or `cutoffDate` no longer clears the cache or reprocesses replays. `process` prints guidance to run `retag` (which re-derives tags on the committed matches) and then regenerate output. New replays are still classified with the current config; use `--reprocess` to also re-examine previously rejected replays.

## Replay parsing

A `.StormReplay` is an MPQ archive containing multiple data streams (header, details, initdata, attributes events, tracker events, message events). All MPQ + protocol decoding happens inside the C# sidecar via Heroes.StormReplayParser; the library exposes a typed object model that the sidecar serialises into the intermediate JSON shape consumed by `parser.py`. The library is build-resilient by design, so the pipeline does not require per-patch updates.

Hero and map names are resolved on the Python side from the library's internal IDs (always English regardless of client language) via lookup tables in `herodata.py`.

Duration is computed as `elapsed_game_loops / 16` (the game runs at 16 loops per second).

## Match identity

Matches are fingerprinted as `MD5(sorted_player_profile_ids + randomSeed)`. The `randomSeed` from `replay.initdata` is set by the game server and is identical across all players' copies of the same replay. This method matches Heroes Profile and HotsLogs.

## Game mode detection

The C# sidecar emits the library's `StormGameMode` enum as a string (`gameMode`) plus the `StormLobbyMode` enum (`lobbyMode`) and the map's internal ID. `_resolve_game_mode` in `parser.py` reduces those into the dashboard's expected labels:

- `StormGameMode.ToString()` is the library's `[Flags]` enum representation. When more than one bit is set it emits a comma-separated string; the resolver picks the most specific bit via `_GAME_MODE_PRIORITY`.
- `Custom` is split by lobby mode: `Standard` becomes `CustomStandard`, `Draft` or `TournamentDraft` becomes `CustomDraft`.
- `QuickMatch` on an ARAM map ID is remapped to `ARAM` as a safety net for any client mislabelling.

ARAM map IDs live in `herodata.ARAM_MAP_IDS`.

## Acceptance criteria

A replay is accepted (its match JSON written) only if it passes every rule below. Rules are checked in this order; the first failure is the recorded rejection reason.

- **Not tombstoned**: its match ID is not in `data/removed-matches.json` (reason `removed`).
- **Not a duplicate**: its match ID is not already on record.
- **On or after the cutoff date** (`cutoffDate` in `pipeline.json`).
- **All human**: no AI (computer) players.
- **Complete**: every player has a win or loss result (no unresolved score data).
- **Not sandbox or brawl**: sandbox maps and brawl-only maps are rejected.
- **Accepted game mode**: StormLeague, CustomDraft, or ARAM.
- **Sauna Tent presence**: at least one roster or alt player is in the match.
- **Custom games**: require at least 3 roster players and no alt players.

CustomStandard is not an accepted mode; it is rejected as an unwanted mode (no CustomStandard matches exist in the committed data). CustomDraft is remapped to "Custom" in the dashboard output, and aggregation additionally skips any CustomStandard match as a safety net.

## Aggregation dimensions

Stats are aggregated in a single pass across all match files:

- Per player (overall)
- Per player per hero
- Per player per map
- Per player per hero per party size
- Per player per party size
- Per hero (across all roster players)
- Per hero per player
- Per map (across all roster players)
- Per map per hero
- Per map per player
- Per game mode
- Per party size

Talent builds are tracked as full 7-tier keys with per-tier pick rates and win rates. Hall of Fame single-game and stack records are computed client-side from the match index; aggregation only writes the cumulative HoF stat keys (`HOF_INDEX_STAT_KEYS`) into each match-index `hof` dict, plus the per-`rosterPlayer` `awards` list when the replay supplies `matchAwardsList`. Named-award leaderboards are built entirely on the frontend from that index field.

## Output files

All written to the configured output directory (default: `data/`), except the tier-2 archive, which lives at the repo root (`archive/`, overridable with `--archive-dir`).

| File | Content |
|---|---|
| `summary.json` | Global stats, most played heroes, game mode/party size breakdowns, meta stats |
| `roster.json` | Team name and player list with URL slugs |
| `players/{slug}.json` | Per-player aggregate with hero, map, party size breakdowns and builds |
| `heroes/{slug}.json` | Per-hero aggregate with player breakdown, builds, and tier pick rates |
| `maps/{slug}.json` | Per-map aggregate with hero and player breakdowns |
| `matches/{id}.json` | Tier-1 match data (one file per match, written during parsing) |
| `matches/index.json` | Match index with per-match meta stats and per-player data (talent choices, HoF stat values, named-award lists) for client-side filtered aggregation |
| `<repo>/archive/{id}.json.gz` | Tier-2 archive: the approved extraction categories per match (gitignored, not served, repo root not `data/`). See "Match data tiers" |

## Data filterability rule

All data shown in the frontend must be filterable by the user's active filters (date, season, mode, party size, map). No exceptions. This is a correctness requirement for a statistics dashboard. Showing unfiltered data alongside filtered data produces misleading statistical conclusions.

### How it works

The match index (`data/matches/index.json`) is the single source of truth for filterable data. Each match entry contains per-player stats in `rosterPlayers` so the frontend can re-aggregate any stat from a filtered subset of matches.

Pre-computed aggregates (per-player, per-hero, per-map JSONs) exist as an optimization for the default unfiltered view. They must never be the sole source for any stat that appears in a view with active filters.

### When adding new stats or cards

1. Ensure the raw per-game value exists in the match index `rosterPlayers` entries (either as a top-level field or inside the `hof` dict).
2. If the stat is a new HoF cumulative category, add it to `_HOF_CUMULATIVE_CATEGORIES` in `aggregate.py` (this automatically adds it to `HOF_INDEX_STAT_KEYS` which `output.py` writes to the match index).
3. Frontend rendering code must compute the stat from the filtered match index when filters are active, falling back to pre-computed data only when no filters are set.
4. Never add a "Lifetime total" disclaimer or hide a section as a substitute for making the data filterable.
