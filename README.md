# Sauna Tent

A static analytics dashboard for the Heroes of the Storm team "Sauna Tent". Parses `.StormReplay` files through a Python pipeline, produces pre-computed JSON, and serves it via a vanilla JS single-page app.

## TODO

- The heroprotocol tool has been modified to support Python 3.12. Verify how the patching of the tool works now and in the future. It needs to work simply since heroprotocol gets updated on every patch.
  - Source: https://github.com/Blizzard/heroprotocol

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

### Full batch processing

```bash
python -m pipeline.batch --generate --pretty
```

This runs the complete pipeline:

1. Removes duplicate replay files (same match from different players).
2. Removes unwanted replays (QuickMatch, brawls, AI games, incomplete games).
3. Parses all remaining replays (incremental, skips unchanged files via manifest).
4. Aggregates stats and writes dashboard JSON to `data/`.

Use `--reprocess` to force re-parse all replays (needed after config changes).

### Individual steps

```bash
# Remove duplicates only
python remove_duplicates.py

# Remove unwanted replays only
python remove_unwanted.py

# Process a single replay
python -m pipeline.run replays/FILENAME.StormReplay --pretty

# Re-run aggregation and output without re-parsing
python -m pipeline.batch --generate
```

### Serving the dashboard

Any static file server works. The `.htaccess` handles SPA routing for Apache. The frontend fetches JSON from `data/` via relative paths.

## How It Works

There is no backend. The entire dashboard is a static site served from GitHub Pages. All data processing happens in the Python pipeline before deployment, and all runtime filtering and aggregation happens in the browser. No server, no database, no API.

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
  "outputDirectory": "data",
  "extraction": {
    "details": true,
    "trackerevents": true,
    "attributeevents": true,
    "header": true
  }
}
```

Each roster entry can have multiple toon IDs (for players with accounts across regions). The `name` field is the display name used throughout the dashboard.

## License

Copyright 2026 Eetu Rantanen. All rights reserved.
