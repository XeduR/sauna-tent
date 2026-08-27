# Replays

Place `.StormReplay` files here for the pipeline to parse. The pipeline scans this directory recursively (case-insensitive extension match).

Replay files are gitignored due to size, and they are disposable inputs. The committed `data/matches/*.json` files are the source of truth, so the pipeline runs fine with this directory absent or empty: it finds nothing new to parse and works from the committed data alone. The pipeline never deletes replays; unwanted and duplicate replays are classified and skipped (recorded in the local `manifest.json` cache), not removed.

Use `collect_replays.py` (or `refresh-replays.bat`) to copy new replays from the local HotS documents folder automatically.
