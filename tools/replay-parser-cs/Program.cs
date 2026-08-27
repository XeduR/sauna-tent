// CLI entrypoint for the C# sidecar parser.
// Usage: heroes-replay-parser-cs <replay-path> [--pretty]
//
// Exit codes:
//   0 - success (JSON written to stdout)
//   1 - usage error (no args, --help)
//   2 - parse failure (file missing, library error, score data missing)

using System.Text.Json;
using System.Text.Json.Serialization;
using Heroes.StormReplayParser;
using HeroesReplayParserCs;

if (args.Length == 0 || args[0] == "--help" || args[0] == "-h") {
	System.Console.Error.WriteLine("Usage: heroes-replay-parser-cs <replay-path> [--pretty]");
	return 1;
}

string replayPath = args[0];
bool pretty = false;
for (int i = 1; i < args.Length; i++) {
	if (args[i] == "--pretty") {
		pretty = true;
	} else {
		System.Console.Error.WriteLine($"Unknown argument: {args[i]}");
		return 1;
	}
}

if (!System.IO.File.Exists(replayPath)) {
	System.Console.Error.WriteLine($"File not found: {replayPath}");
	return 2;
}

StormReplayResult result;
try {
	result = StormReplay.Parse(replayPath, new ParseOptions {
		AllowPTR = true,
		ShouldParseTrackerEvents = true,
		ShouldParseMessageEvents = true,
		ShouldParseGameEvents = true,
	});
} catch (System.Exception ex) {
	System.Console.Error.WriteLine($"Library threw while parsing: {ex}");
	return 2;
}

// Statuses where the library still populates result.Replay enough to extract
// from. Success / PTRRegion are full parses; Incomplete signals missing score
// data only; TryMeMode flags a TryMe game but the metadata is intact. The
// Python pipeline rejects TryMe via the gameMode filter and Incomplete via
// the isIncomplete flag, so passing these through gives a clean category in
// the per-category breakdown instead of swelling the unparseable bucket.
bool isRecoverable = result.Status == StormReplayParseStatus.Success
	|| result.Status == StormReplayParseStatus.PTRRegion
	|| result.Status == StormReplayParseStatus.Incomplete
	|| result.Status == StormReplayParseStatus.TryMeMode;

if (!isRecoverable || result.Replay == null) {
	// Full ToString() (not just Message) surfaces the inner exception + stack the
	// library swallows into result.Exception, which is needed to diagnose the
	// otherwise-opaque unparseable replays.
	string detail = result.Exception?.ToString() ?? "no exception detail";
	System.Console.Error.WriteLine($"Parse failed (status={result.Status}): {detail}");
	return 2;
}

MatchJson match;
try {
	match = MatchExtractor.Extract(result.Replay);
} catch (System.Exception ex) {
	System.Console.Error.WriteLine($"Extraction failed (status={result.Status}): {ex.GetType().Name}: {ex.Message}");
	return 2;
}

// Library said incomplete but every player happens to have a ScoreResult:
// trust the library and force the flag so Python categorises it cleanly.
if (result.Status == StormReplayParseStatus.Incomplete) {
	match.IsIncomplete = true;
}

var jsonOptions = new JsonSerializerOptions {
	PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
	DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
	DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
	WriteIndented = pretty,
};

try {
	string json = JsonSerializer.Serialize(match, jsonOptions);
	System.Console.Out.WriteLine(json);
} catch (System.Exception ex) {
	System.Console.Error.WriteLine($"JSON serialisation failed: {ex.GetType().Name}: {ex.Message}");
	return 2;
}

return 0;
