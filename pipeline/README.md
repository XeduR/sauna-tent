# Pipeline

Replay processing pipeline for the Sauna Tent dashboard. Decodes `.StormReplay` files via the C# `heroes-replay-parser-cs` sidecar, applies Sauna Tent analysis on top, aggregates stats, and outputs pre-computed JSON for the static frontend.

## Modules

- **parser.py**: Spawns the `heroes-replay-parser-cs` sidecar (a dotnet global tool), then layers Sauna Tent analysis on the intermediate JSON: hero/map name resolution, ARAM detection from map IDs, talent trimming, chat toxicity / glhf / offensive-gg classification, and KDA. Exposes `parse_replay` for the main pipeline and `parse_replay_raw` for filter passes that need the unprocessed sidecar output.
- **run.py**: Single-replay processor. Loads config, calls the parser, tags roster players by toon ID, detects party composition, generates a stable match ID, and writes the match JSON file.
- **batch.py**: Batch processor. Scans the replay directory, processes new/changed files incrementally using a manifest, and orchestrates the full pipeline (deduplicate, filter, parse, aggregate, output). Verifies the sidecar is installed at startup.
- **aggregate.py**: Reads all match JSON files and computes aggregate statistics across every combination of player, hero, map, game mode, and party size. Also tracks hall of fame records and talent builds.
- **output.py**: Writes the final dashboard JSON files (summary, roster, per-player, per-hero, per-map, match index, hall of fame).
- **herodata.py**: Static lookup tables mapping the library's internal hero/map IDs to display names. Also lists ARAM map IDs.
- **toxicity.py**: Loads `toxic_keywords.txt` and exposes `is_toxic(message)` for case-insensitive substring matching against chat messages. Keywords are loaded once and cached.
- **toxic_keywords.txt**: One toxic keyword or phrase per line. Comments start with `#`. Edit this file to adjust toxicity detection without touching code.

## Dependencies

- **heroes-replay-parser-cs**: vendored .NET 8 console app under `tools/replay-parser-cs/` that wraps [Heroes.StormReplayParser](https://github.com/HeroesToolChest/Heroes.StormReplayParser). Installed as a user-scoped dotnet global tool. The Python pipeline owns the analysis layer; the sidecar only decodes the MPQ archive and exposes the library's parsed object model as JSON.

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

Only replays meeting all of the following are processed:

- **Game mode**: StormLeague, CustomDraft, CustomStandard, or ARAM.
- **All human**: Every player has `m_control == 2` (no AI).
- **Complete**: All players have a win or loss result (no disconnects before end).
- **Roster presence**: At least one roster player is in the match.
- **Custom games**: Require at least 3 roster players in the match. No alt players allowed.

CustomStandard matches are parsed but excluded from aggregation. CustomDraft is remapped to "Custom" in output.

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

Talent builds are tracked as full 7-tier keys with per-tier pick rates and win rates. Hall of fame records track top 20 single-game performances per stat per game mode (Overall, StormLeague, ARAM, Custom).

## Output files

All written to the configured output directory (default: `data/`).

| File | Content |
|---|---|
| `summary.json` | Global stats, most played heroes, game mode/party size breakdowns, meta stats |
| `roster.json` | Team name and player list with URL slugs |
| `hall-of-fame.json` | Single-game records, game duration records (cumulative records still written by pipeline but not consumed at runtime; frontend recomputes from match index) |
| `players/{slug}.json` | Per-player aggregate with hero, map, party size breakdowns and builds |
| `heroes/{slug}.json` | Per-hero aggregate with player breakdown, builds, and tier pick rates |
| `maps/{slug}.json` | Per-map aggregate with hero and player breakdowns |
| `matches/{id}.json` | Full match data (one file per match, written during parsing) |
| `matches/index.json` | Match index with per-match meta stats and per-player data (talent choices, HoF stat values) for client-side filtered aggregation |

## Data filterability rule

All data shown in the frontend must be filterable by the user's active filters (date, season, mode, party size, map). No exceptions. This is a correctness requirement for a statistics dashboard. Showing unfiltered data alongside filtered data produces misleading statistical conclusions.

### How it works

The match index (`data/matches/index.json`) is the single source of truth for filterable data. Each match entry contains per-player stats in `rosterPlayers` so the frontend can re-aggregate any stat from a filtered subset of matches.

Pre-computed aggregates (per-player, per-hero, per-map JSONs and `hall-of-fame.json`) exist as an optimization for the default unfiltered view. They must never be the sole source for any stat that appears in a view with active filters.

### When adding new stats or cards

1. Ensure the raw per-game value exists in the match index `rosterPlayers` entries (either as a top-level field or inside the `hof` dict).
2. If the stat is a new HoF cumulative category, add it to `_HOF_CUMULATIVE_CATEGORIES` in `aggregate.py` (this automatically adds it to `HOF_INDEX_STAT_KEYS` which `output.py` writes to the match index).
3. Frontend rendering code must compute the stat from the filtered match index when filters are active, falling back to pre-computed data only when no filters are set.
4. Never add a "Lifetime total" disclaimer or hide a section as a substitute for making the data filterable.
