// Translates the typed StormReplay model plus raw VersionedDecoder events into
// the MatchJson DTO. The Python pipeline does all analysis (toxicity, chat
// aggregates, KDA, ARAM detection, name resolution); this class is pure
// extraction.

using System.Collections.Generic;
using System.Linq;
using Heroes.StormReplayParser;
using Heroes.StormReplayParser.Decoders;
using Heroes.StormReplayParser.MessageEvent;
using Heroes.StormReplayParser.Player;
using Heroes.StormReplayParser.Replay;
using Heroes.StormReplayParser.TrackerEvent;

namespace HeroesReplayParserCs;

internal static class MatchExtractor {
	private const int LoopsPerSecond = 16;
	private const string BossCampType = "Boss Camp";

	private static readonly HashSet<string> MinionUnitTypes = new() {
		"FootmanMinion", "RangedMinion", "WizardMinion", "CatapultMinion",
	};

	private static readonly HashSet<string> StructureUnitTypes = new() {
		"KingsCore", "VanndarStormpike", "DrekThar",
	};

	private static readonly int[] TalentTierLevels = { 4, 7, 10, 13, 16, 20 };

	public static MatchJson Extract(StormReplay replay) {
		var players = replay.StormPlayers.ToList();
		int numPlayers = players.Count;

		var match = new MatchJson {
			Build = replay.ReplayBuild,
			Timestamp = replay.Timestamp.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffffzzz"),
			DurationSeconds = replay.ReplayLength.TotalSeconds,
			ElapsedGameLoops = replay.ElapsedGamesLoops,
			RandomSeed = replay.RandomValue,
			GameMode = replay.GameMode.ToString(),
			LobbyMode = replay.LobbyMode.ToString(),
			MapInternalId = replay.MapInfo.MapId,
			MapLocalizedName = replay.MapInfo.MapName,
		};

		if (replay.WinningTeam == StormTeam.Blue) {
			match.WinningTeam = 0;
		} else if (replay.WinningTeam == StormTeam.Red) {
			match.WinningTeam = 1;
		}

		var senderToIndex = new Dictionary<StormPlayer, int>();
		for (int i = 0; i < numPlayers; i++) {
			match.Players.Add(ConvertPlayer(players[i]));
			senderToIndex[players[i]] = i;
		}

		BuildDraft(replay, match);
		BuildTeamLevels(replay, match);
		WalkTrackerEvents(replay, match, players, numPlayers);
		WalkMessages(replay, match, senderToIndex, numPlayers);
		ApplyDisconnects(players, match, numPlayers);
		FlagIncompleteScores(players, match, numPlayers);

		return match;
	}

	private static PlayerJson ConvertPlayer(StormPlayer player) {
		var pjson = new PlayerJson {
			Name = player.Name,
			HeroLocalizedFallback = player.PlayerHero?.HeroName ?? "",
			Team = player.Team == StormTeam.Blue ? 0 : (player.Team == StormTeam.Red ? 1 : -1),
			Result = player.IsWinner ? "win" : "loss",
			IsComputer = player.PlayerType == PlayerType.Computer ? 1 : null,
		};

		string heroInternal = player.PlayerHero?.HeroUnitId ?? "";
		if (heroInternal.StartsWith("Hero", System.StringComparison.Ordinal)) {
			heroInternal = heroInternal[4..];
		}
		pjson.HeroInternal = string.IsNullOrEmpty(heroInternal) ? null : heroInternal;

		if (player.ToonHandle != null) {
			pjson.Toon.Region = player.ToonHandle.Region;
			pjson.Toon.RealmId = player.ToonHandle.Realm;
			pjson.Toon.ProfileId = player.ToonHandle.Id;
		}

		int heroLevel = player.PlayerHero?.HeroLevel ?? 0;
		pjson.HeroLevel = heroLevel > 0 ? heroLevel : null;

		var score = player.ScoreResult;
		pjson.TalentChoices = new List<int?> {
			score?.Tier1Talent,
			score?.Tier4Talent,
			score?.Tier7Talent,
			score?.Tier10Talent,
			score?.Tier13Talent,
			score?.Tier16Talent,
			score?.Tier20Talent,
		};

		if (score != null) {
			var s = pjson.Stats;
			s.Kills = score.SoloKills;
			s.Deaths = score.Deaths;
			s.Assists = score.Assists;
			s.Takedowns = score.Takedowns;
			s.HeroDamage = score.HeroDamage;
			s.SiegeDamage = score.SiegeDamage;
			s.StructureDamage = score.StructureDamage;
			s.Healing = score.Healing;
			s.SelfHealing = score.SelfHealing;
			s.DamageTaken = score.DamageTaken;
			s.XpContribution = score.ExperienceContribution;
			s.TimeSpentDead = (int)System.Math.Round(score.TimeSpentDead.TotalSeconds);
			s.MercCaptures = score.MercCampCaptures;
			s.CreepDamage = score.CreepDamage;
			s.SummonDamage = score.SummonDamage;
			s.TimeCCdEnemyHeroes = (int)System.Math.Round(score.TimeCCdEnemyHeroes.TotalSeconds);
			s.DamageSoaked = score.DamageSoaked;
			s.HighestKillStreak = score.HighestKillStreak;
			s.ProtectionGiven = score.ProtectionGivenToAllies;
			s.TeamfightHeroDamage = score.TeamfightHeroDamage;
			s.TeamfightDamageTaken = score.TeamfightDamageTaken;
			s.TeamfightHealing = score.TeamfightHealingDone;
			s.MinionKills = score.MinionKills;
			s.RegenGlobes = score.RegenGlobes;
			s.Multikill = score.Multikill;
			s.PhysicalDamage = score.PhysicalDamage;
			s.SpellDamage = score.SpellDamage;
			if (score.OnFireTimeonFire.HasValue) {
				s.TimeOnFire = (int)System.Math.Round(score.OnFireTimeonFire.Value.TotalSeconds);
			}

			// EndOfMatchAwardGivenToNonwinner appears in MiscellaneousScoreResultEvents
			// when the library's GetScoreResult dispatch doesn't recognise it as a
			// typed stat. Awarded matches sets HasAward but no MVP/map flag.
			if (score.MiscellaneousScoreResultEvents != null &&
					score.MiscellaneousScoreResultEvents.TryGetValue("EndOfMatchAwardGivenToNonwinner", out int internalAward) &&
					internalAward == 1) {
				s.AwardInternal = 1;
			}
		}

		if (player.MatchAwards != null && player.MatchAwards.Count > 0) {
			pjson.Stats.HasAward = 1;
			foreach (var award in player.MatchAwards) {
				if (award == MatchAwardType.MVP) {
					pjson.Stats.AwardMVP = 1;
				} else if ((int)award >= 1001 && (int)award <= 1099) {
					pjson.Stats.AwardMapSpecific = 1;
				}
			}
		}

		return pjson;
	}

	private static void BuildDraft(StormReplay replay, MatchJson match) {
		foreach (var pick in replay.DraftPicks) {
			int team = pick.Team == StormTeam.Blue ? 0 : (pick.Team == StormTeam.Red ? 1 : -1);
			if (team < 0) {
				continue;
			}
			string type = pick.PickType switch {
				StormDraftPickType.Banned => "ban",
				StormDraftPickType.Picked => "pick",
				_ => "",
			};
			if (type.Length == 0) {
				continue;
			}
			match.Draft.Add(new DraftEntryJson {
				Type = type,
				Team = team,
				Hero = pick.HeroSelected,
			});
		}
	}

	private static void BuildTeamLevels(StormReplay replay, MatchJson match) {
		int blueFinal = replay.GetTeamFinalLevel(StormTeam.Blue) ?? 0;
		int redFinal = replay.GetTeamFinalLevel(StormTeam.Red) ?? 0;
		if (blueFinal > 0 || redFinal > 0) {
			match.TeamLevels = new Dictionary<string, int> {
				["0"] = blueFinal,
				["1"] = redFinal,
			};
		}

		var blueLevels = replay.GetTeamLevels(StormTeam.Blue);
		var redLevels = replay.GetTeamLevels(StormTeam.Red);

		foreach (int level in TalentTierLevels) {
			System.TimeSpan? blueTime = FindLevelTime(blueLevels, level);
			System.TimeSpan? redTime = FindLevelTime(redLevels, level);
			if (blueTime.HasValue && redTime.HasValue) {
				if (blueTime.Value < redTime.Value) {
					match.FirstToLevel[level.ToString()] = 0;
				} else if (redTime.Value < blueTime.Value) {
					match.FirstToLevel[level.ToString()] = 1;
				}
				// Tie: omit, matching Python parity behaviour.
			} else if (blueTime.HasValue) {
				match.FirstToLevel[level.ToString()] = 0;
			} else if (redTime.HasValue) {
				match.FirstToLevel[level.ToString()] = 1;
			}
		}
	}

	private static System.TimeSpan? FindLevelTime(IReadOnlyList<StormTeamLevel>? levels, int level) {
		if (levels == null) {
			return null;
		}
		foreach (var entry in levels) {
			if (entry.Level == level) {
				return entry.Time;
			}
		}
		return null;
	}

	private static void WalkTrackerEvents(StormReplay replay, MatchJson match, List<StormPlayer> players, int numPlayers) {
		// hero_tags maps (tag_index, tag_recycle) of a hero unit to the player
		// index it belongs to. Built from SUnitBornEvent walks; used to
		// classify SUnitDiedEvent as hero death + identify killer category.
		var unitRegistry = new Dictionary<(uint, uint), string>();
		var heroTags = new Dictionary<(uint, uint), int>();
		int? gatesOpenLoop = null;
		int? firstBloodLoop = null;
		int firstBloodVictimIdx = -1;
		int? firstBossLoop = null;
		int? firstMercLoop = null;
		var deathSources = new Dictionary<int, int>[numPlayers];
		for (int i = 0; i < numPlayers; i++) {
			deathSources[i] = new Dictionary<int, int>();
		}

		foreach (var trackerEvent in replay.TrackerEvents) {
			var decoder = trackerEvent.VersionedDecoder;
			if (decoder == null || decoder.Structure == null) {
				continue;
			}

			switch (trackerEvent.TrackerEventType) {
				case StormTrackerEventType.UnitBornEvent:
					HandleUnitBorn(decoder, numPlayers, unitRegistry, heroTags);
					break;

				case StormTrackerEventType.UnitDiedEvent: {
					int gameLoop = LoopFromTimestamp(trackerEvent.Timestamp);
					HandleUnitDied(decoder, gameLoop, gatesOpenLoop, numPlayers, heroTags, unitRegistry,
						deathSources, ref firstBloodLoop, ref firstBloodVictimIdx);
					break;
				}

				case StormTrackerEventType.StatGameEvent: {
					int gameLoop = LoopFromTimestamp(trackerEvent.Timestamp);
					HandleStatGame(decoder, gameLoop, match, players, numPlayers,
						ref gatesOpenLoop, ref firstBossLoop, ref firstMercLoop);
					break;
				}
			}
		}

		// First blood team: the team that did NOT get killed (i.e. the killer's team).
		if (firstBloodVictimIdx >= 0 && firstBloodVictimIdx < numPlayers) {
			int victimTeam = match.Players[firstBloodVictimIdx].Team;
			if (victimTeam == 0 || victimTeam == 1) {
				match.FirstBloodTeam = 1 - victimTeam;
			}
		}

		for (int i = 0; i < numPlayers; i++) {
			var stats = match.Players[i].Stats;
			foreach (var pair in deathSources[i]) {
				if (pair.Value <= 0) {
					continue;
				}
				switch (pair.Key) {
					case 0: stats.DeathsByMinions = pair.Value; break;
					case 1: stats.DeathsByMercs = pair.Value; break;
					case 2: stats.DeathsByStructures = pair.Value; break;
					case 3: stats.DeathsByMonsters = pair.Value; break;
				}
			}
		}
	}

	private static void HandleUnitBorn(Heroes.StormReplayParser.Decoders.VersionedDecoder decoder, int numPlayers,
			Dictionary<(uint, uint), string> unitRegistry, Dictionary<(uint, uint), int> heroTags) {
		var structure = decoder.Structure!;
		if (structure.Count < 4) {
			return;
		}
		uint tagIndex = structure[0].GetValueAsUInt32();
		uint tagRecycle = structure[1].GetValueAsUInt32();
		string unitTypeName = structure[2].GetValueAsString();
		uint controlPlayerId = structure[3].GetValueAsUInt32();

		var tag = (tagIndex, tagRecycle);
		unitRegistry[tag] = unitTypeName;

		// 1-based control_player_id maps directly to StormPlayers enumeration
		// order (library excludes observers, who never appear in tracker).
		if (unitTypeName.StartsWith("Hero", System.StringComparison.Ordinal)
				&& controlPlayerId >= 1 && controlPlayerId <= (uint)numPlayers) {
			heroTags[tag] = (int)controlPlayerId - 1;
		}
	}

	private static void HandleUnitDied(Heroes.StormReplayParser.Decoders.VersionedDecoder decoder,
			int gameLoop, int? gatesOpenLoop, int numPlayers,
			Dictionary<(uint, uint), int> heroTags, Dictionary<(uint, uint), string> unitRegistry,
			Dictionary<int, int>[] deathSources,
			ref int? firstBloodLoop, ref int firstBloodVictimIdx) {
		var structure = decoder.Structure!;
		if (structure.Count < 2) {
			return;
		}
		uint tagIndex = structure[0].GetValueAsUInt32();
		uint tagRecycle = structure[1].GetValueAsUInt32();
		var tag = (tagIndex, tagRecycle);

		if (!heroTags.TryGetValue(tag, out int victimIdx)) {
			return;
		}

		// First blood: earliest hero death after gates open.
		if (gatesOpenLoop.HasValue && gameLoop >= gatesOpenLoop.Value) {
			if (firstBloodLoop == null || gameLoop < firstBloodLoop.Value) {
				firstBloodLoop = gameLoop;
				firstBloodVictimIdx = victimIdx;
			}
		}

		// Death-by-source only counts kills where the killer is NOT a hero
		// (a player kill is already attributed via takedowns/assists).
		uint killerPlayerId = (structure.Count > 2 ? structure[2].OptionalData?.GetValueAsUInt32() : null) ?? 0;
		if (killerPlayerId >= 1 && killerPlayerId <= (uint)numPlayers) {
			return;
		}

		if (structure.Count < 7) {
			return;
		}
		uint? killerTagIdx = structure[5].OptionalData?.GetValueAsUInt32();
		uint? killerTagRecycle = structure[6].OptionalData?.GetValueAsUInt32();
		if (!killerTagIdx.HasValue || !killerTagRecycle.HasValue) {
			return;
		}

		var killerTag = (killerTagIdx.Value, killerTagRecycle.Value);
		if (!unitRegistry.TryGetValue(killerTag, out string? killerType) || killerType == null) {
			return;
		}
		int category = ClassifyKillerUnit(killerType);
		deathSources[victimIdx].TryGetValue(category, out int prior);
		deathSources[victimIdx][category] = prior + 1;
	}

	private static int ClassifyKillerUnit(string unitType) {
		if (MinionUnitTypes.Contains(unitType)) {
			return 0;
		}
		if (unitType.StartsWith("Merc", System.StringComparison.Ordinal)) {
			return 1;
		}
		if (StructureUnitTypes.Contains(unitType) || unitType.StartsWith("Town", System.StringComparison.Ordinal)) {
			return 2;
		}
		return 3;
	}

	private static void HandleStatGame(Heroes.StormReplayParser.Decoders.VersionedDecoder decoder,
			int gameLoop, MatchJson match, List<StormPlayer> players, int numPlayers,
			ref int? gatesOpenLoop, ref int? firstBossLoop, ref int? firstMercLoop) {
		var structure = decoder.Structure!;
		if (structure.Count < 1) {
			return;
		}
		string eventName = structure[0].GetValueAsString();

		if (eventName == "GatesOpen") {
			if (gatesOpenLoop == null) {
				gatesOpenLoop = gameLoop;
			}
			return;
		}

		if (eventName == "EndOfGameUpVotesCollected") {
			if (structure.Count < 3) {
				return;
			}
			var intDataArray = structure[2].OptionalData?.ArrayData;
			if (intDataArray == null || intDataArray.Length < 2) {
				return;
			}
			long upvotedId = intDataArray[0].Structure?[1].GetValueAsInt64() ?? 0;
			long voterId = intDataArray[1].Structure?[1].GetValueAsInt64() ?? 0;
			if (upvotedId >= 1 && upvotedId <= numPlayers) {
				var stats = match.Players[(int)upvotedId - 1].Stats;
				stats.VotesReceived = (stats.VotesReceived ?? 0) + 1;
			}
			if (voterId >= 1 && voterId <= numPlayers) {
				var stats = match.Players[(int)voterId - 1].Stats;
				stats.VotesGiven = (stats.VotesGiven ?? 0) + 1;
			}
			return;
		}

		if (eventName == "JungleCampCapture") {
			if (structure.Count < 4) {
				return;
			}
			var fixedArray = structure[3].OptionalData?.ArrayData;
			var stringArray = structure[1].OptionalData?.ArrayData;
			if (fixedArray == null || fixedArray.Length < 1 || stringArray == null || stringArray.Length < 1) {
				return;
			}
			long rawTeam = (fixedArray[0].Structure?[1].GetValueAsInt64() ?? 0) / 4096;
			int teamId = (int)rawTeam - 1;
			if (teamId != 0 && teamId != 1) {
				return;
			}
			string campType = stringArray[0].Structure?[1].GetValueAsString() ?? "";
			if (campType == BossCampType) {
				if (firstBossLoop == null || gameLoop < firstBossLoop.Value) {
					firstBossLoop = gameLoop;
					match.FirstBossTeam = teamId;
				}
			} else {
				if (firstMercLoop == null || gameLoop < firstMercLoop.Value) {
					firstMercLoop = gameLoop;
					match.FirstMercTeam = teamId;
				}
			}
		}
	}

	private static void WalkMessages(StormReplay replay, MatchJson match,
			Dictionary<StormPlayer, int> senderToIndex, int numPlayers) {
		foreach (var message in replay.Messages) {
			if (message.MessageSender == null
					|| !senderToIndex.TryGetValue(message.MessageSender, out int playerIdx)
					|| playerIdx < 0 || playerIdx >= numPlayers) {
				continue;
			}

			switch (message) {
				case ChatMessage chat: {
					int recipient = (int)chat.MessageTarget;
					if (recipient == (int)StormMessageTarget.Observers) {
						continue;
					}
					match.ChatRecords.Add(new ChatRecordJson {
						PlayerIndex = playerIdx,
						Gameloop = LoopFromTimestamp(chat.Timestamp),
						Text = chat.Text ?? "",
						Recipient = recipient,
					});
					break;
				}
				case PingMessage: {
					var stats = match.Players[playerIdx].Stats;
					stats.Pings = (stats.Pings ?? 0) + 1;
					break;
				}
			}
		}
	}

	private static void ApplyDisconnects(List<StormPlayer> players, MatchJson match, int numPlayers) {
		for (int i = 0; i < numPlayers; i++) {
			var disconnects = players[i].PlayerDisconnects;
			if (disconnects == null || disconnects.Count == 0) {
				continue;
			}
			var stats = match.Players[i].Stats;
			stats.Disconnects = disconnects.Count;
			foreach (var entry in disconnects) {
				if (entry.To == null) {
					stats.DisconnectedAtEnd = 1;
					break;
				}
			}
		}
	}

	private static void FlagIncompleteScores(List<StormPlayer> players, MatchJson match, int numPlayers) {
		for (int i = 0; i < numPlayers; i++) {
			if (players[i].ScoreResult == null) {
				match.IsIncomplete = true;
				return;
			}
		}
	}

	private static int LoopFromTimestamp(System.TimeSpan timestamp) {
		return (int)System.Math.Round(timestamp.TotalSeconds * LoopsPerSecond);
	}
}
