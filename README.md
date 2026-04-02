# Sauna Tent

A static analytics dashboard for the Heroes of the Storm team "Sauna Tent". Parses `.StormReplay` files through a Python pipeline, produces pre-computed JSON, and serves it via a vanilla JS single-page app.

## Requirements

- Python 3.12+
- `mpyq` and `six` (installed automatically on first run if missing)
- heroprotocol (vendored in `tools/`)

## Exporting replays

1. Open your Heroes of the Storm documents folder: `%USERPROFILE%\Documents\Heroes of the Storm\Accounts`
2. Search for `*.StormReplay` using the Windows search bar.
3. Wait for the search to finish, then select all results and copy them to a temporary folder. Make sure to copy, not cut, so the originals remain in place.
4. Zip the folder and send it over.

## Setup

1. Place `.StormReplay` files in `replays/`.
2. Edit `pipeline.json` to set your roster (player names and toon IDs).

Toon IDs are in `region-realmId-profileId` format (e.g. `2-1-8623376` for EU). Find them by parsing any replay containing the player.

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

Any static file server works. The `.htaccess` handles SPA routing for Apache. The frontend fetches JSON from `data/` via relative paths.

## Chat Toxicity Detection

The pipeline detects toxic messages in team chat using keyword-based substring matching. The keyword list is in `pipeline/toxic_keywords.txt` (one keyword per line, case-insensitive). Edit this file to adjust what counts as toxic. No code changes needed.

Toxicity data feeds into:

- **Win rate correlation**: chat statistics tables on Overview and player pages (Storm League and ARAM only).
- **Hall of Fame / Shame**: "Conversationalist" (clean chat rate) and "Most Toxic Conversationalist" (toxic chat rate) entries.

## Game Assets

Hero portraits, talent icons, and role icons are in `img/`. These are sourced from Blizzard game assets via the [Heroes Profile](https://github.com/Heroes-Profile/heroesprofile) repository and the [Heroes of the Storm Wiki](https://heroesofthestorm.fandom.com/). Talent display names are mapped in `data/talent-names.json`. Hero chart colors are defined in `data/hero-colors.json`.

Game imagery is copyright Blizzard Entertainment.

## How It Works

There is no backend. The entire dashboard is a static site served from GitHub Pages. All data processing happens in the Python pipeline before deployment, and all runtime filtering and aggregation happens in the browser. No server, no database, no API.

### Why the pipeline runs locally

The replay files (`.StormReplay`) are too large for GitHub. A typical dataset is several thousand files totalling multiple gigabytes. GitHub enforces a 2 GB push limit and recommends keeping repositories under 1 GB. Even with Git LFS, GitHub Actions runners only have ~14 GB of disk, leaving insufficient room for replay processing alongside the OS and toolchain.

The pipeline is designed to run locally. Replay files are gitignored and never leave the local machine. Only the pre-computed JSON output (`data/`, typically under 100 MB) is committed and deployed to GitHub Pages.

For a private team dashboard with a bounded dataset (a few thousand matches), a traditional database backend is unnecessary infrastructure and cost. The static approach trades a one-time upfront download for zero hosting cost and instant filter responsiveness after load.

The dashboard uses two data paths:

- **Pre-computed aggregates** (`data/players/`, `data/heroes/`, `data/maps/`): detailed per-player stats, averages, KDA, damage breakdowns, and talent builds. Used by individual profile pages.
- **Match index** (`data/matches/index.json`): lightweight per-match entries loaded once and cached in memory. Used by all filterable pages to compute stats entirely in JavaScript.

## Configuration

`pipeline.json`:

```json
{
  "team": "Sauna Tent",
  "roster": [
    {"name": "PlayerName", "toons": ["2-1-12345"]}
  ],
  "replayDirectory": "replays",
  "outputDirectory": "data"
}
```

Each roster entry can have multiple toon IDs (for players with accounts across regions). The `name` field is the display name used throughout the dashboard.

## Data Sources

- **Replay parsing**: [heroprotocol](https://github.com/Blizzard/heroprotocol) by Blizzard Entertainment.
- **Hero and talent images**: [Heroes Profile](https://github.com/Heroes-Profile/heroesprofile) repository (Blizzard game assets).
- **Role icons**: [Heroes of the Storm Wiki](https://heroesofthestorm.fandom.com/) (Blizzard game assets).
- **Ranked season dates**: [The Nexus Compendium](https://nexuscompendium.com/ranked).

## License

Copyright 2026 Eetu Rantanen. MIT License. See [LICENSE](LICENSE) for details.
