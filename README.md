# Sauna Tent

A static analytics dashboard for the Heroes of the Storm team "Sauna Tent". Parses `.StormReplay` files through a Python pipeline, produces pre-computed JSON, and serves it via a vanilla JS single-page app.

## Requirements

- Python 3.12+
- `mpyq` and `six` (installed automatically on first run if missing)
- heroprotocol (vendored in `tools/`)

## Exporting replays

### Automated (project owner)

Double-click `refresh-replays.bat` (or run `python collect_replays.py`). It walks `%USERPROFILE%\Documents\Heroes of the Storm\Accounts`, copies every new `.StormReplay` into the project `replays/` folder, and deduplicates by filename. Originals are preserved.

### Manual (sharing replays with a teammate)

1. Open your Heroes of the Storm documents folder: `%USERPROFILE%\Documents\Heroes of the Storm\Accounts`
2. Search for `*.StormReplay` using the Windows search bar.
3. Wait for the search to finish, then select all results and copy them to a temporary folder. Make sure to copy, not cut, so the originals remain in place.
4. Zip the folder and send it over.

## Setup

1. Place `.StormReplay` files in `replays/`.
2. Edit `pipeline.json` to set your roster (player names and toon IDs).

Toon IDs are in `region-realmId-profileId` format (e.g. `2-1-8623376` for EU). Find them by parsing any replay containing the player.

### Data cutoff

Replays from before 7 December 2021 are excluded. This is the start date of Storm League 2022 Season 1.

### Custom game inclusion

Custom games require at least 3 roster players in the match, with no alt players. Games with fewer roster players are excluded during replay processing. See `pipeline/README.md` for all acceptance criteria.

## Usage

### Adding new replays (typical use)

```bash
python -m pipeline.batch --generate
```

Fetches latest heroprotocol, removes unwanted replays, parses new ones (skips unchanged files via manifest), aggregates stats, and writes minified dashboard JSON to `data/`. This is the normal workflow after dropping new `.StormReplay` files into `replays/`.

### Full reprocess

```bash
python -m pipeline.batch --generate --reprocess
```

Same as above but clears the manifest and re-parses every replay from scratch. Needed after pipeline code changes, config changes, or data structure updates.

### Debug/inspection run

```bash
python -m pipeline.batch --generate --pretty
```

Same as above but writes human-readable (indented) JSON. Useful for inspecting output files by hand. The `--pretty` flag increases file size, so use minified output (no flag) for production/deployment.

### Individual steps

```bash
# Remove unwanted replays only (duplicates, wrong mode, AI, etc.)
python remove_replays.py

# Process a single replay
python -m pipeline.run replays/FILENAME.StormReplay --pretty

# Re-run aggregation and output without re-parsing
python -m pipeline.batch --generate
```

### Pipeline steps

The batch command runs these steps in order:

1. **Update protocols** - fetches the latest heroprotocol version files from GitHub. Continues with existing protocols if the network is unavailable.
2. **Remove replays** - scans all replays for duplicates, unwanted game modes, AI games, incomplete matches, etc. Prompts per category before deleting.
3. **Process replays** - parses remaining replays into per-match JSON in `data/matches/`. Incremental by default (tracks file hashes in `manifest.json`).
4. **Generate output** (with `--generate`) - aggregates match data and writes dashboard JSON: summary, hall of fame, per-player/hero/map stats, and the match index.

### Batch flags

| Flag | Description |
|---|---|
| `--generate` | Run aggregation and write dashboard JSON after processing |
| `--pretty` | Pretty-print (indent) JSON output instead of minified |
| `--reprocess` | Clear manifest and re-parse all replays from scratch |
| `--config PATH` | Override pipeline config path (default: `pipeline.json`) |
| `--output-dir DIR` | Override output directory (default: from config) |
| `--manifest PATH` | Override manifest file path (default: `manifest.json`) |

### Serving the dashboard

Any static file server works. The frontend fetches JSON from `data/` via relative paths.

**Local development (XAMPP)**: Point the project directory into XAMPP's `htdocs`. The `.htaccess` rewrites all non-file paths to `index.html` for SPA routing. No additional setup needed.

**GitHub Pages**: The `404.html` redirect handles SPA routing by saving the requested path to `sessionStorage` and redirecting to the deployment root, where `index.html` restores the path via `history.replaceState`.

## Refreshing hero data

Hero stats, ability data, talent names/descriptions, and all hero/talent/ability icons are regenerated from a local HotS install via [HeroesDataParser](https://github.com/HeroesToolChest/HeroesDataParser) (HDP), a .NET CLI that reads Blizzard's game files directly. Run this after every HotS patch to keep talent data in sync with the live game.

### Quick start

Double-click `refresh-hero-data.bat` (or run `python generate_hero_data.py`). The default game path is `C:\Games\Heroes of the Storm`; pass a different path as the first argument to the `.bat` (or use `--game-path` on the script) if your install lives elsewhere.

### Prerequisites

1. **.NET 8.0 SDK** (required, install once manually): <https://dotnet.microsoft.com/download/dotnet/8.0> — pick "SDK", x64 Windows installer. The Runtime alone is not enough; the SDK is required to install global tools. The script does not auto-install the SDK because it is system-wide and needs admin elevation.
2. **HeroesDataParser** (auto-installed on first run): a user-scoped global dotnet tool, installed into `%USERPROFILE%\.dotnet\tools`. The script prompts y/N before installing.
3. **Pillow** (auto-installed on first run): a Python imaging library used to downscale and re-encode icons. The script prompts y/N before installing.

### What it does

1. Invokes HDP to extract hero data + images from `<game-path>\HeroesData` into `.scratch/hots-data-output/` (gitignored).
2. Translates HDP's per-hero JSON into the dashboard's flat structures and writes `data/hero-info.json`, `data/talent-names.json`, and `data/talent-descriptions.json`.
3. Downscales every icon from 128x128 to 64x64 with Lanczos resampling, re-encodes with PNG `optimize=True`, and writes them to `img/hero/{slug}/avatar.png`, `img/hero/{slug}/talent{tier}_{choice}.png`, and `img/hero/{slug}/abilities/{ability-id}.png`. Existing files are MD5-compared against the new output and skipped if identical.

### Skipping HDP

Use `python generate_hero_data.py --skip-parser` to re-translate already-extracted HDP output without rerunning the parser. Useful for iterating on the translator or testing against the bundled HDP sample JSONs under `.scratch/HeroesDataParser-main/Tests/`.

## Chat Toxicity Detection

The pipeline detects toxic messages in team chat using keyword-based substring matching. The keyword list is in `pipeline/toxic_keywords.txt` (one keyword per line, case-insensitive). Edit this file to adjust what counts as toxic. No code changes needed.

Toxicity data feeds into:

- **Win rate correlation**: chat statistics tables on Overview and player pages (Storm League and ARAM only).
- **Hall of Fame / Shame**: "Conversationalist" (clean chat rate) and "Most Toxic Conversationalist" (toxic chat rate) entries.

## Game Assets

Hero portraits, talent icons, and ability icons under `img/hero/` are extracted from a local HotS install via HeroesDataParser (see [Refreshing hero data](#refreshing-hero-data)). Role icons under `img/role/` are sourced from the [Heroes of the Storm Wiki](https://heroesofthestorm.fandom.com/). Hero chart colors are defined in `data/hero-colors.json`.

### Talent data freshness

Talent names, descriptions, and icons always reflect the live game patch at the time `generate_hero_data.py` was last run. When a hero receives a talent rework in a new patch, old match results will display the updated talent information rather than what was available when those games were played. This is an accepted limitation. Maintaining version-specific talent mappings for every patch is not practical, and community tools (e.g. Heroes Profile) follow the same approach.

## How It Works

There is no backend. The entire dashboard is a static site served from GitHub Pages. All data processing happens in the Python pipeline before deployment, and all runtime filtering and aggregation happens in the browser. No server, no database, no API.

### Why the pipeline runs locally

The replay files (`.StormReplay`) are too large for GitHub. A typical dataset is several thousand files totalling multiple gigabytes. GitHub enforces a 2 GB push limit and recommends keeping repositories under 1 GB. Even with Git LFS, GitHub Actions runners only have ~14 GB of disk, leaving insufficient room for replay processing alongside the OS and toolchain.

The pipeline is designed to run locally. Replay files are gitignored and never leave the local machine. Only the pre-computed JSON output (`data/`, typically under 100 MB) is committed and deployed to GitHub Pages.

For a private team dashboard with a bounded dataset (a few thousand matches), a traditional database backend is unnecessary infrastructure and cost. The static approach trades a one-time upfront download for zero hosting cost and instant filter responsiveness after load.

The dashboard uses two data paths:

- **Pre-computed aggregates** (`data/players/`, `data/heroes/`, `data/maps/`): detailed per-player stats, averages, KDA, damage breakdowns, and talent builds. Used by individual profile pages.
- **Match index** (`data/matches/index.json`): lightweight per-match entries loaded once and cached in memory. Used by all filterable pages to compute stats entirely in JavaScript.

All displayed data must be filterable by the user's active filters. The match index is the single source of truth for filtered views. See `pipeline/README.md` "Data filterability rule" for implementation details.

## Configuration

`pipeline.json`:

```json
{
  "team": "Sauna Tent",
  "roster": [
    {"name": "PlayerName", "toons": ["2-1-12345"]}
  ],
  "alts": [
    {"name": "AltName", "toons": ["2-1-67890"]}
  ],
  "cutoffDate": "2021-12-07",
  "replayDirectory": "replays",
  "outputDirectory": "data"
}
```

Each roster entry can have multiple toon IDs (for players with accounts across regions). The `name` field is the display name used throughout the dashboard. The `alts` array lists loose team members whose matches are tracked separately and excluded from baseline stats by default. The `cutoffDate` excludes replays before the given date.

## Local scratch directory

`.scratch/` at the project root is a gitignored workspace for files generated by local tooling. Nothing inside is required to build or serve the dashboard, and nothing in it should be committed.

- `.scratch/hots-data-output/` — raw 128x128 JSON and images produced by `generate_hero_data.py` via HeroesDataParser. The same script downscales the icons to 64x64, re-encodes with `optimize=True`, and writes them alongside the translated `data/hero-info.json`, `data/talent-names.json`, `data/talent-descriptions.json`, and per-hero images under `img/hero/{slug}/`.

Other contents that may accumulate here (HotS install snapshots, vendored HeroesDataParser source, debug reports, code reviews) are similarly transient.

## Data Sources

- **Replay parsing**: [heroprotocol](https://github.com/Blizzard/heroprotocol) by Blizzard Entertainment.
- **Hero data and images**: [HeroesDataParser](https://github.com/HeroesToolChest/HeroesDataParser) reading the local HotS install directly (Blizzard game assets).
- **Role icons**: [Heroes of the Storm Wiki](https://heroesofthestorm.fandom.com/) (Blizzard game assets).
- **Ranked season dates**: [The Nexus Compendium](https://nexuscompendium.com/ranked).

## Trademarks

All Heroes of the Storm content surfaced by this dashboard, including hero, ability, talent, and map names; ability and talent text and descriptions; hero portraits, ability icons, talent icons, and role imagery; and other in-game text and assets, is the property of Blizzard Entertainment, Inc. Heroes of the Storm is a trademark of Blizzard Entertainment, Inc. This is my personal project and it is not affiliated with or endorsed by Blizzard Entertainment in any way.

## License

Copyright 2026 Eetu Rantanen. MIT License. See [LICENSE](LICENSE) for details.
