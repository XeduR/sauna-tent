# heroes-replay-parser-cs

C# sidecar that parses a single `.StormReplay` file via
[Heroes.StormReplayParser](https://github.com/HeroesToolChest/Heroes.StormReplayParser)
2.2.1 and emits intermediate JSON for the Sauna Tent Python pipeline.

The Python `heroprotocol` parser fails on every replay from any HotS build
Blizzard has not yet published a `protocolNNNNN.py` file for. The C# library
is build-resilient by design, so this tool covers historical and future
builds without per-patch updates.

## Output contract

```text
heroes-replay-parser-cs <replay-path> [--pretty]
```

- Exit `0`: success, JSON written to stdout.
- Exit `1`: usage error (missing arg, unknown flag).
- Exit `2`: parse failure (file missing, library exception, unsupported / pre-alpha replay).

The library returns a `StormReplayParseStatus`; four of its statuses still
populate enough state for the extractor to run, so the sidecar treats them as
exit 0 and lets the Python layer categorise the result:

- `Success` and `PTRRegion`: full parse, emitted as-is.
- `Incomplete`: missing score data. The sidecar emits JSON with
  `isIncomplete: true` regardless of whether individual players have a
  `ScoreResult`. Python rejects via the `incomplete` category.
- `TryMeMode`: Try Me / tutorial game. The library still sets
  `replay.GameMode = TryMe`, so the emitted JSON carries `gameMode: "TryMe"`
  and Python rejects via the `unwanted_mode` category.

Everything else (`Exception`, `UnexpectedResult`, `PreAlphaWipe`,
`FileSizeTooLarge`, `FileNotFound`, `Unknown`) exits 2 with the status and any
exception message on stderr.

All error messages go to stderr. Python reads stdout as JSON.

The JSON schema is the intermediate shape consumed by
[pipeline/parser.py](../../pipeline/parser.py): typed library fields
(`build`, `gameMode`, `lobbyMode`, `mapInternalId`, `winningTeam`, ...)
plus the raw event walks for first blood, death sources, votes, jungle
camp captures, chat records, pings, and disconnects. The Python layer
resolves hero/map names, detects ARAM, computes KDA, and analyses chat
toxicity.

## Build

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

```bash
dotnet pack -c Release -o ./nupkg
```

This produces `nupkg/heroes-replay-parser-cs.<version>.nupkg`. The
Sauna Tent batch pipeline runs this automatically on first install (see
below), so you only need to invoke it manually when iterating on the C#
code.

## Install (dotnet global tool)

The Sauna Tent batch pipeline checks for the tool on startup. If
missing, it prompts y/N, runs `dotnet pack` to build the nupkg if it is
not already present, and installs the tool. To install manually:

```bash
dotnet pack -c Release -o ./nupkg
dotnet tool install --global --add-source ./nupkg heroes-replay-parser-cs
```

Uninstall:

```bash
dotnet tool uninstall --global heroes-replay-parser-cs
```

## Run manually

```bash
heroes-replay-parser-cs path/to/replay.StormReplay --pretty
```
