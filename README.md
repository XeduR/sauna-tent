# Sauna Tent

A static analytics dashboard for the Heroes of the Storm team "Sauna Tent". Parses `.StormReplay` files through a Python pipeline, produces pre-computed JSON, and serves it via a vanilla JS single-page app.

## Requirements

- Python 3.12+
- .NET 8.0 SDK (required to install the replay parser). See [Refreshing hero data](#refreshing-hero-data) for the download link; the same SDK serves both tools.
- `heroes-replay-parser-cs` (auto-installed on first batch run; the vendored source lives in `tools/replay-parser-cs/`).

## Exporting replays

### Automated (project owner)

Double-click `refresh-replays.bat` (or run `python collect_replays.py`). It walks `%USERPROFILE%\Documents\Heroes of the Storm\Accounts`, copies every new `.StormReplay` into the project `replays/` folder, and deduplicates by filename. Originals are preserved.

### Manual (sharing replays with a teammate)

1. Open your Heroes of the Storm documents folder: `%USERPROFILE%\Documents\Heroes of the Storm\Accounts`
2. Search for `*.StormReplay` using the Windows search bar.
3. Wait for the search to finish, then select all results and copy them to a temporary folder. Make sure to copy, not cut, so the originals remain in place.
4. Zip the folder and send it over.

You can also contribute replays through a pull request instead of sending them; see [Contributing replays](#contributing-replays).

## Setup

1. Place `.StormReplay` files in `replays/`.
2. Edit `pipeline.json` to set your roster (player names and toon IDs).

Toon IDs are in `region-realmId-profileId` format (e.g. `2-1-8623376` for EU). Find them by parsing any replay containing the player.

### Data cutoff

Replays from before 7 December 2021 are excluded. This is the start date of Storm League 2022 Season 1.

### Custom game inclusion

Custom games require at least 3 roster players in the match, with no alt players. Games with fewer roster players are excluded during replay processing. See `pipeline/README.md` for all acceptance criteria.

## Usage

### Interactive workflow (typical use)

Double-click `run-pipeline.bat`. It prompts for:

1. Incremental update or full reprocess.
2. Whether to collect new replays from `%USERPROFILE%` first (runs `collect_replays.py`).
3. Whether to refresh static hero data after the pipeline (runs `refresh-hero-data.bat`).

Forwards the optional first argument (game install path) to `refresh-hero-data.bat`. The pipeline itself runs `process --generate` (and `--reprocess` for option 2). It never deletes replays.

### Adding new replays (CLI)

```bash
python -m pipeline.batch process --generate
```

Classifies and parses new replays (skips unchanged files via the manifest cache), aggregates stats, and writes minified dashboard JSON to `data/`. This is the normal workflow after dropping new `.StormReplay` files into `replays/`. Unwanted and duplicate replays are classified and skipped, never deleted. Running with no subcommand defaults to `process`, so `python -m pipeline.batch --generate` still works.

### Full reprocess

```bash
python -m pipeline.batch process --generate --reprocess
```

Clears the manifest cache and re-derives every match from the replays currently on disk. Committed match files whose replay is no longer present are left untouched. Needed after pipeline code changes or to re-examine previously rejected replays. (Roster/alt/cutoff changes use `retag`, not reprocess - see below.)

### Debug/inspection run

```bash
python -m pipeline.batch process --generate --pretty
```

Same as above but writes human-readable (indented) JSON. Useful for inspecting output files by hand. The `--pretty` flag increases file size, so use minified output (no flag) for production/deployment.

### Managing the dataset

```bash
# Re-derive roster/alt tags on every committed match (after a roster/alt rename)
python -m pipeline.batch retag

# Remove one match permanently (tombstones it so it never returns)
python -m pipeline.batch remove-match <matchId>

# Process a single replay by hand
python -m pipeline.run replays/FILENAME.StormReplay --pretty

# Re-run aggregation and output without re-parsing
python -m pipeline.batch process --generate
```

`retag` rewrites `isRoster` / `rosterName` / `isAlt` / `altName` / `partySize` / `partyMembers` in place from the toon IDs stored in each match file plus the current `pipeline.json`; it needs no replays. Run it after renaming a player in `pipeline.json`, then regenerate output.

`remove-match` deletes `data/matches/<matchId>.json` and appends the id to `data/removed-matches.json`, a committed tombstone registry. Tombstoned matches are never re-created by `process` or `--reprocess`, nor by a re-uploaded overlapping replay. To un-remove a match, delete its id from `data/removed-matches.json` and run `process --reprocess`. Regenerate aggregates afterwards.

### Processing model

The committed `data/matches/*.json` files plus `data/matches/index.json` are the canonical registry of processed matches. `manifest.json` (gitignored) is a local performance cache keyed by each replay's content hash, so unchanged replays are never re-parsed. The pipeline never deletes replay files, and it never deletes a committed match file because a replay went missing. Replays are disposable inputs: the pipeline runs fine with `replays/` absent or empty, working from the committed data alone.

`process` runs, in order:

1. **Classify + parse** each new or changed replay once, writing accepted matches to `data/matches/` and recording rejected / duplicate / tombstoned verdicts in the cache. The sidecar is only required when there are replays to parse.
2. **Generate output** (with `--generate`) - aggregates match data and writes dashboard JSON: summary, hall of fame, per-player/hero/map stats, and the match index.

A change to `roster`, `alts`, or `cutoffDate` in `pipeline.json` prints guidance to run `retag` (which re-derives tags on the committed matches) instead of reprocessing replays. Before parsing, the batch verifies `dotnet` and the `heroes-replay-parser-cs` global tool are installed at the version pinned in the sidecar csproj, rebuilding/reinstalling if stale, and that the tool actually resolves on PATH (the dotnet global-tool directory is not on PATH by default outside Windows; an installed-but-unreachable tool aborts the run instead of marking every replay unparseable). On a fresh machine it prompts to install; `--ci` installs without prompting. See `pipeline/README.md` for the full acceptance criteria.

### Commands and flags

| Command | Description |
|---|---|
| `process` (default) | Classify + parse new replays, write match JSON |
| `retag` | Re-derive roster/alt tags on every committed match in place |
| `remove-match <id>` | Delete one match and tombstone it |

`process` flags:

| Flag | Description |
|---|---|
| `--generate` | Run aggregation and write dashboard JSON after processing |
| `--reprocess` | Clear the cache and re-derive from the replays on disk |
| `--pretty` | Pretty-print (indent) JSON output instead of minified |
| `--ci` | Non-interactive: never prompt (auto-install the sidecar) |
| `--summary-out PATH` | Write a machine-readable JSON run summary |
| `--config PATH` | Override pipeline config path (default: `pipeline.json`) |
| `--output-dir DIR` | Override output directory (default: from config) |
| `--manifest PATH` | Override manifest cache path (default: `manifest.json`) |

### Serving the dashboard

Any static file server works. The frontend fetches JSON from `data/` via relative paths.

**Local development (XAMPP)**: Point the project directory into XAMPP's `htdocs`. The `.htaccess` rewrites all non-file paths to `index.html` for SPA routing. No additional setup needed.

**GitHub Pages**: The `404.html` redirect handles SPA routing by saving the requested path to `sessionStorage` and redirecting to the deployment root, where `index.html` restores the path via `history.replaceState`.

## Contributing replays

Replays are processed locally, and the maintainer makes every commit to this repository.

To contribute your games, either send the maintainer a zip of your `.StormReplay` files (the [Manual](#manual-sharing-replays-with-a-teammate) steps above) for them to process, or, if you have the toolchain (Python 3.12+ and the .NET 8 SDK), fork the repository, run the pipeline locally to regenerate `data/`, and open a pull request. The maintainer reviews and merges it, and GitHub Pages redeploys from `main`.

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

The pipeline is designed to run locally. Replay files are gitignored, so the local pipeline never bulk-commits them; a typical dataset stays entirely on the owner's machine. Only the pre-computed JSON output (`data/`, typically under 100 MB) is committed and deployed to GitHub Pages.

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
    {"name": "PlayerName", "toons": ["2-1-12345"], "heroesProfile": "https://www.heroesprofile.com/Player/PlayerName/12345/2"}
  ],
  "alts": [
    {"name": "AltName", "toons": ["2-1-67890"], "heroesProfile": "https://www.heroesprofile.com/Player/AltName/67890/2"}
  ],
  "cutoffDate": "2021-12-07",
  "replayDirectory": "replays",
  "outputDirectory": "data"
}
```

Each roster entry can have multiple toon IDs (for players with accounts across regions). The `name` field is the display name used throughout the dashboard. The optional `heroesProfile` field is an external profile URL surfaced on the player page; omit it if not applicable. The `alts` array lists loose team members whose matches are tracked separately and excluded from baseline stats by default. The `cutoffDate` excludes replays before the given date.

## Local scratch directory

`.scratch/` at the project root is a gitignored workspace for files generated by local tooling. Nothing inside is required to build or serve the dashboard, and nothing in it should be committed.

- `.scratch/hots-data-output/` — raw 128x128 JSON and images produced by `generate_hero_data.py` via HeroesDataParser. The same script downscales the icons to 64x64, re-encodes with `optimize=True`, and writes them alongside the translated `data/hero-info.json`, `data/talent-names.json`, `data/talent-descriptions.json`, and per-hero images under `img/hero/{slug}/`.

Other contents that may accumulate here (HotS install snapshots, vendored HeroesDataParser source, debug reports, code reviews) are similarly transient.

## Data Sources

- **Replay parsing**: [Heroes.StormReplayParser](https://github.com/HeroesToolChest/Heroes.StormReplayParser) by HeroesToolChest, wrapped by the `tools/replay-parser-cs/` sidecar.
- **Hero data and images**: [HeroesDataParser](https://github.com/HeroesToolChest/HeroesDataParser) reading the local HotS install directly (Blizzard game assets).
- **Role icons**: [Heroes of the Storm Wiki](https://heroesofthestorm.fandom.com/) (Blizzard game assets).
- **Ranked season dates**: [The Nexus Compendium](https://nexuscompendium.com/ranked).

## Trademarks

All Heroes of the Storm content surfaced by this dashboard, including hero, ability, talent, and map names; ability and talent text and descriptions; hero portraits, ability icons, talent icons, and role imagery; and other in-game text and assets, is the property of Blizzard Entertainment, Inc. Heroes of the Storm is a trademark of Blizzard Entertainment, Inc. This is my personal project and it is not affiliated with or endorsed by Blizzard Entertainment in any way.

## License

Copyright 2026 Eetu Rantanen. MIT License. See [LICENSE](LICENSE) for details.
