# Tools

This directory contains vendored third-party tooling used by the pipeline.

## replay-parser-cs

A small .NET 8 console app that wraps [Heroes.StormReplayParser](https://github.com/HeroesToolChest/Heroes.StormReplayParser) and emits the intermediate match JSON consumed by `pipeline/parser.py`. Packaged as a user-scoped dotnet global tool. See `replay-parser-cs/README.md` for build and install instructions.
