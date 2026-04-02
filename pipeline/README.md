# Pipeline

Replay processing pipeline for the Sauna Tent dashboard. Parses `.StormReplay` files via Blizzard's heroprotocol, aggregates stats, and outputs pre-computed JSON for the static frontend.

## Modules

- **parser.py**: Wraps heroprotocol to extract structured data from a single replay. Handles hero/map name resolution, game mode detection, talent extraction, score stats, death source classification, chat/ping/disconnect tracking, chat toxicity detection, first blood, first boss/mercenary capture, and level lead tracking.
- **run.py**: Single-replay processor. Loads config, calls the parser, tags roster players by toon ID, detects party composition, generates a stable match ID, and writes the match JSON file.
- **batch.py**: Batch processor. Scans the replay directory, processes new/changed files incrementally using a manifest, and orchestrates the full pipeline (deduplicate, filter, parse, aggregate, output).
- **aggregate.py**: Reads all match JSON files and computes aggregate statistics across every combination of player, hero, map, game mode, and party size. Also tracks hall of fame records and talent builds.
- **output.py**: Writes the final dashboard JSON files (summary, roster, per-player, per-hero, per-map, match index, hall of fame).
- **herodata.py**: Static lookup tables mapping heroprotocol internal IDs to display names for heroes, maps, roles, and ARAM map identification.
- **toxicity.py**: Loads `toxic_keywords.txt` and exposes `is_toxic(message)` for case-insensitive substring matching against chat messages. Keywords are loaded once and cached.
- **toxic_keywords.txt**: One toxic keyword or phrase per line. Comments start with `#`. Edit this file to adjust toxicity detection without touching code.

## Dependencies

- **heroprotocol**: Blizzard's replay decoder, vendored in `tools/heroprotocol/`. Updated with each HotS patch to support new protocol builds.
- **mpyq**: MPQ archive reader for `.StormReplay` files. Installed via pip (prompted automatically on first run).
- **six**: Python 2/3 compatibility layer required by heroprotocol. Also auto-installed on first run.

## Replay parsing

Each `.StormReplay` is an MPQ archive containing multiple data streams. The parser extracts:

| Stream | Data |
|---|---|
| `replay.header` | Game version (base build), duration in game loops |
| `replay.details` | Timestamp, player list (names, toons, teams, results), map display name |
| `replay.initdata` | `randomSeed` for match fingerprinting |
| `replay.attributes.events` | Game mode, hero levels, talent internal codes |
| `replay.tracker.events` | Hero/map internal IDs, end-of-game score stats, talent tier choices, death sources |
| `replay.message.events` | Chat messages (with toxicity detection), pings, disconnects/reconnects |

Hero and map names are resolved from tracker event internal IDs (always English regardless of client language) via lookup tables in `herodata.py`.

Duration is computed as `elapsed_game_loops / 16` (the game runs at 16 loops per second).

## Match identity

Matches are fingerprinted as `MD5(sorted_player_profile_ids + randomSeed)`. The `randomSeed` from `replay.initdata` is set by the game server and is identical across all players' copies of the same replay. This method matches Heroes Profile and HotsLogs.

## Game mode detection

Detected from attribute events in the global scope (player slot 16):

| Attribute 3009 (Matchmaking) | Attribute 4010 (Lobby) | Mode |
|---|---|---|
| Amm | drft | StormLeague |
| Priv | drft or tour | Custom |
| Priv | stan | CustomStandard |
| Amm | stan + ARAM map | ARAM |
| Amm | stan + non-ARAM map | QuickMatch (rejected) |

ARAM detection falls back to tracker event map IDs for non-English clients where the display name won't match the lookup table.

## Acceptance criteria

Only replays meeting all of the following are processed:

- **Game mode**: StormLeague, CustomDraft, CustomStandard, or ARAM.
- **All human**: Every player has `m_control == 2` (no AI).
- **Complete**: All players have a win or loss result (no disconnects before end).
- **Roster presence**: At least one roster player is in the match.
- **Custom games**: Require a full 5-stack of roster players on one team.

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
| `hall-of-fame.json` | Single-game records, cumulative records, game duration records |
| `players/{slug}.json` | Per-player aggregate with hero, map, party size breakdowns and builds |
| `heroes/{slug}.json` | Per-hero aggregate with player breakdown, builds, and tier pick rates |
| `maps/{slug}.json` | Per-map aggregate with hero and player breakdowns |
| `matches/{id}.json` | Full match data (one file per match, written during parsing) |
| `matches/index.json` | Lightweight match index with per-match meta stats (side, first blood, first boss/merc, level lead, chat toxicity classification) for frontend filtering |
