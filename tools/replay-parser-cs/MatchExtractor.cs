// Translates the typed StormReplay model plus raw VersionedDecoder events into
// the MatchJson DTO. The Python pipeline does all analysis (toxicity, chat
// aggregates, KDA, ARAM detection, name resolution); this class is pure
// extraction.

using System.Collections.Generic;
using System.Linq;
using Heroes.StormReplayParser;
using Heroes.StormReplayParser.Decoders;
using Heroes.StormReplayParser.GameEvent;
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
			// InvariantCulture forces ISO colons in the time separator. A culture
			// where the time separator is "." (e.g. fi-FI) otherwise emits dotted
			// timestamps, which mix incompatibly with the ISO ones and break
			// full-string timestamp comparisons downstream.
			Timestamp = replay.Timestamp.ToUniversalTime().ToString(
				"yyyy-MM-ddTHH:mm:ss.ffffffzzz", System.Globalization.CultureInfo.InvariantCulture),
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
		BuildTeamTimelines(replay, match);
		WalkTrackerEvents(replay, match, players, numPlayers);
		WalkGameEvents(replay, match, senderToIndex, numPlayers);
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
				// Tier-2: full named award identity (the boolean flags above stay
				// for tier-1 schema stability).
				pjson.MatchAwardsList.Add(award.ToString());
			}
		}

		BuildLoadout(player, pjson);
		BuildScoreExtended(score, pjson);

		return pjson;
	}

	private static void BuildLoadout(StormPlayer player, PlayerJson pjson) {
		var lo = player.PlayerLoadout;
		if (lo == null) {
			return;
		}
		pjson.Loadout = new LoadoutJson {
			SkinAndSkinTint = lo.SkinAndSkinTint,
			SkinAndSkinTintAttributeId = lo.SkinAndSkinTintAttributeId,
			MountAndMountTint = lo.MountAndMountTint,
			MountAndMountTintAttributeId = lo.MountAndMountTintAttributeId,
			Banner = lo.Banner,
			BannerAttributeId = lo.BannerAttributeId,
			Spray = lo.Spray,
			SprayAttributeId = lo.SprayAttributeId,
			AnnouncerPack = lo.AnnouncerPack,
			AnnouncerPackAttributeId = lo.AnnouncerPackAttributeId,
			VoiceLine = lo.VoiceLine,
			VoiceLineAttributeId = lo.VoiceLineAttributeId,
		};
	}

	private static void BuildScoreExtended(ScoreResult? score, PlayerJson pjson) {
		if (score == null) {
			return;
		}
		pjson.ScoreExtended = new ScoreExtendedJson {
			TownKills = score.TownKills,
			WatchTowerCaptures = score.WatchTowerCaptures,
			MinionDamage = score.MinionDamage,
			ClutchHealsPerformed = score.ClutchHealsPerformed,
			EscapesPerformed = score.EscapesPerformed,
			VengeancesPerformed = score.VengeancesPerformed,
			OutnumberedDeaths = score.OutnumberedDeaths,
			TeamfightEscapesPerformed = score.TeamfightEscapesPerformed,
		};

		var misc = score.MiscellaneousScoreResultEvents;
		if (misc != null && misc.Count > 0) {
			var miscJson = new MiscScoreJson {
				All = new Dictionary<string, int>(misc),
			};
			if (misc.TryGetValue("TimeOnPoint", out int top)) {
				miscJson.TimeOnPoint = top;
			}
			if (misc.TryGetValue("TimeInTemple", out int tit)) {
				miscJson.TimeInTemple = tit;
			}
			if (misc.TryGetValue("TimeOnPayload", out int topay)) {
				miscJson.TimeOnPayload = topay;
			}
			if (misc.TryGetValue("KilledTreasureGoblin", out int ktg)) {
				miscJson.KilledTreasureGoblin = ktg;
			}
			pjson.MiscScore = miscJson;
		}
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

	// Tier-2: complete per-team level-up and XP-breakdown timelines. Tier-1 only
	// keeps the truncated FirstToLevel checkpoints and final TeamLevels above.
	private static void BuildTeamTimelines(StormReplay replay, MatchJson match) {
		var levels = new Dictionary<string, List<TeamLevelJson>>();
		var blueLevels = ConvertLevels(replay.GetTeamLevels(StormTeam.Blue));
		var redLevels = ConvertLevels(replay.GetTeamLevels(StormTeam.Red));
		if (blueLevels.Count > 0) {
			levels["0"] = blueLevels;
		}
		if (redLevels.Count > 0) {
			levels["1"] = redLevels;
		}
		if (levels.Count > 0) {
			match.LevelTimeline = levels;
		}

		var xp = new Dictionary<string, List<XpBreakdownJson>>();
		var blueXp = ConvertXp(replay.GetTeamXPBreakdown(StormTeam.Blue));
		var redXp = ConvertXp(replay.GetTeamXPBreakdown(StormTeam.Red));
		if (blueXp.Count > 0) {
			xp["0"] = blueXp;
		}
		if (redXp.Count > 0) {
			xp["1"] = redXp;
		}
		if (xp.Count > 0) {
			match.XpBreakdown = xp;
		}
	}

	private static List<TeamLevelJson> ConvertLevels(IReadOnlyList<StormTeamLevel>? levels) {
		var result = new List<TeamLevelJson>();
		if (levels == null) {
			return result;
		}
		foreach (var entry in levels) {
			result.Add(new TeamLevelJson { Level = entry.Level, Time = entry.Time.TotalSeconds });
		}
		return result;
	}

	private static List<XpBreakdownJson> ConvertXp(IReadOnlyList<StormTeamXPBreakdown>? breakdowns) {
		var result = new List<XpBreakdownJson>();
		if (breakdowns == null) {
			return result;
		}
		foreach (var entry in breakdowns) {
			result.Add(new XpBreakdownJson {
				Level = entry.Level,
				Time = entry.Time.TotalSeconds,
				MinionXP = entry.MinionXP,
				CreepXP = entry.CreepXP,
				StructureXP = entry.StructureXP,
				HeroXP = entry.HeroXP,
				PassiveXP = entry.PassiveXP,
				TotalXP = entry.TotalXP,
			});
		}
		return result;
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
						deathSources, match, ref firstBloodLoop, ref firstBloodVictimIdx);
					break;
				}

				case StormTrackerEventType.StatGameEvent: {
					int gameLoop = LoopFromTimestamp(trackerEvent.Timestamp);
					HandleStatGame(decoder, gameLoop, match, players, numPlayers,
						ref gatesOpenLoop, ref firstBossLoop, ref firstMercLoop);
					break;
				}

				case StormTrackerEventType.UnitPositionsEvent: {
					int gameLoop = LoopFromTimestamp(trackerEvent.Timestamp);
					HandleUnitPositions(decoder, gameLoop, match);
					break;
				}

				case StormTrackerEventType.HeroBannedEvent:
					HandleDraftTiming(decoder, LoopFromTimestamp(trackerEvent.Timestamp), "ban", match);
					break;

				case StormTrackerEventType.HeroPickedEvent:
					HandleDraftTiming(decoder, LoopFromTimestamp(trackerEvent.Timestamp), "pick", match);
					break;

				case StormTrackerEventType.HeroSwappedEvent:
					HandleDraftTiming(decoder, LoopFromTimestamp(trackerEvent.Timestamp), "swap", match);
					break;
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
			Dictionary<int, int>[] deathSources, MatchJson match,
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

		// Tier-2: hero death position (structure[3,4] are direct x,y, no scaling).
		var heroDeath = new HeroUnitDeathJson { Gameloop = gameLoop, Victim = victimIdx };
		if (structure.Count >= 5) {
			heroDeath.X = (int)structure[3].GetValueAsUInt32();
			heroDeath.Y = (int)structure[4].GetValueAsUInt32();
		}

		// Death-by-source only counts kills where the killer is NOT a hero
		// (a player kill is already attributed via takedowns/assists).
		uint killerPlayerId = (structure.Count > 2 ? structure[2].OptionalData?.GetValueAsUInt32() : null) ?? 0;
		if (killerPlayerId >= 1 && killerPlayerId <= (uint)numPlayers) {
			match.HeroUnitDeaths.Add(heroDeath);
			return;
		}

		if (structure.Count < 7) {
			match.HeroUnitDeaths.Add(heroDeath);
			return;
		}
		uint? killerTagIdx = structure[5].OptionalData?.GetValueAsUInt32();
		uint? killerTagRecycle = structure[6].OptionalData?.GetValueAsUInt32();
		if (!killerTagIdx.HasValue || !killerTagRecycle.HasValue) {
			match.HeroUnitDeaths.Add(heroDeath);
			return;
		}

		var killerTag = (killerTagIdx.Value, killerTagRecycle.Value);
		if (!unitRegistry.TryGetValue(killerTag, out string? killerType) || killerType == null) {
			match.HeroUnitDeaths.Add(heroDeath);
			return;
		}
		int category = ClassifyKillerUnit(killerType);
		deathSources[victimIdx].TryGetValue(category, out int prior);
		deathSources[victimIdx][category] = prior + 1;
		heroDeath.KillerCategory = category;
		match.HeroUnitDeaths.Add(heroDeath);
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
			string campType = stringArray[0].Structure?[1].GetValueAsString() ?? "";

			// Tier-2: full capture timeline (every camp, not just first-per-category).
			long campId = structure[2].OptionalData?.ArrayData?.FirstOrDefault()?.Structure?[1].GetValueAsInt64() ?? 0;
			match.JungleCamps.Add(new JungleCampJson {
				Gameloop = gameLoop, Team = teamId, CampType = campType, CampId = campId,
			});

			if (teamId != 0 && teamId != 1) {
				return;
			}
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
			return;
		}

		if (eventName == "PlayerDeath") {
			HandlePlayerDeath(structure, gameLoop, match, numPlayers);
			return;
		}

		// Generic preservation of every StatGameEvent not consumed above. This
		// captures per-map objective events without per-map code.
		match.StatEvents.Add(new GenericStatEventJson {
			Name = eventName,
			Gameloop = gameLoop,
			Strings = ReadStatStrings(structure, 1),
			Ints = ReadStatInts(structure, 2),
			Fixeds = ReadStatInts(structure, 3),
		});
	}

	// Kill feed: victim = intData[0] (PlayerID), killers/assists = intData[1+]
	// (KillingPlayer); position = fixedData[0..1] / 4096. Tracker player ids are
	// 1-based; player index = id - 1.
	private static void HandlePlayerDeath(List<Heroes.StormReplayParser.Decoders.VersionedDecoder> structure,
			int gameLoop, MatchJson match, int numPlayers) {
		var ints = structure.Count > 2 ? structure[2].OptionalData?.ArrayData : null;
		if (ints == null || ints.Length < 1) {
			return;
		}
		long victimId = ints[0].Structure?[1].GetValueAsInt64() ?? 0;
		if (victimId < 1 || victimId > numPlayers) {
			return;
		}

		var death = new PlayerDeathJson { Gameloop = gameLoop, Victim = (int)victimId - 1 };
		for (int i = 1; i < ints.Length; i++) {
			long killerId = ints[i].Structure?[1].GetValueAsInt64() ?? 0;
			if (killerId >= 1 && killerId <= numPlayers) {
				death.Killers.Add((int)killerId - 1);
			}
		}

		var fixeds = structure.Count > 3 ? structure[3].OptionalData?.ArrayData : null;
		if (fixeds != null && fixeds.Length >= 2) {
			death.X = (fixeds[0].Structure?[1].GetValueAsInt64() ?? 0) / 4096.0;
			death.Y = (fixeds[1].Structure?[1].GetValueAsInt64() ?? 0) / 4096.0;
		}
		match.KillFeed.Add(death);
	}

	// Read a StatGameEvent data-array slot (1=stringData, 2=intData, 3=fixedData)
	// into {name, value} pairs. Each array element is a field whose Structure[0]
	// wraps the name and Structure[1] holds the value. Returns null when absent.
	private static List<StatFieldJson>? ReadStatInts(
			List<Heroes.StormReplayParser.Decoders.VersionedDecoder> structure, int slot) {
		if (structure.Count <= slot) {
			return null;
		}
		var arr = structure[slot].OptionalData?.ArrayData;
		if (arr == null || arr.Length == 0) {
			return null;
		}
		var result = new List<StatFieldJson>(arr.Length);
		foreach (var el in arr) {
			var inner = el.Structure;
			if (inner == null || inner.Count < 2) {
				continue;
			}
			result.Add(new StatFieldJson {
				Name = inner[0].Structure?[0].GetValueAsString() ?? "",
				Value = inner[1].GetValueAsInt64(),
			});
		}
		return result.Count > 0 ? result : null;
	}

	private static List<StatStringFieldJson>? ReadStatStrings(
			List<Heroes.StormReplayParser.Decoders.VersionedDecoder> structure, int slot) {
		if (structure.Count <= slot) {
			return null;
		}
		var arr = structure[slot].OptionalData?.ArrayData;
		if (arr == null || arr.Length == 0) {
			return null;
		}
		var result = new List<StatStringFieldJson>(arr.Length);
		foreach (var el in arr) {
			var inner = el.Structure;
			if (inner == null || inner.Count < 2) {
				continue;
			}
			result.Add(new StatStringFieldJson {
				Name = inner[0].Structure?[0].GetValueAsString() ?? "",
				Value = inner[1].GetValueAsString() ?? "",
			});
		}
		return result.Count > 0 ? result : null;
	}

	// SUnitPositionsEvent: structure[0] = firstUnitIndex, structure[1] = flat
	// array decoded as (indexDelta, x, y) triplets. Triplet scale unconfirmed,
	// so the raw decoded values are stored verbatim (preservation-first).
	private static void HandleUnitPositions(Heroes.StormReplayParser.Decoders.VersionedDecoder decoder,
			int gameLoop, MatchJson match) {
		var structure = decoder.Structure!;
		if (structure.Count < 2) {
			return;
		}
		var arr = structure[1].ArrayData;
		if (arr == null || arr.Length == 0) {
			return;
		}
		var items = new List<long>(arr.Length);
		foreach (var el in arr) {
			items.Add(el.GetValueAsInt64());
		}
		match.UnitPositions.Add(new UnitPositionsJson {
			Gameloop = gameLoop,
			FirstUnitIndex = (int)structure[0].GetValueAsInt64(),
			Items = items,
		});
	}

	// Draft ban/pick/swap: structure[0] = hero internal name, structure[1] =
	// controlling team (ban) or working-set slot / controlling player (pick/swap).
	private static void HandleDraftTiming(Heroes.StormReplayParser.Decoders.VersionedDecoder decoder,
			int gameLoop, string type, MatchJson match) {
		var structure = decoder.Structure!;
		if (structure.Count < 2) {
			return;
		}
		match.DraftTimeline.Add(new DraftTimingJson {
			Type = type,
			Hero = structure[0].GetValueAsString(),
			Gameloop = gameLoop,
			Value = structure[1].GetValueAsInt64(),
		});
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
				case PingMessage ping: {
					var stats = match.Players[playerIdx].Stats;
					stats.Pings = (stats.Pings ?? 0) + 1;
					// Tier-2: full ping record (position + recipient).
					match.Pings.Add(new PingRecordJson {
						PlayerIndex = playerIdx,
						Gameloop = LoopFromTimestamp(ping.Timestamp),
						X = ping.Point.X,
						Y = ping.Point.Y,
						Recipient = (int)ping.MessageTarget,
					});
					break;
				}
			}
		}
	}

	// Game events (parsed only when ShouldParseGameEvents is on). Keeps the four
	// user-approved categories and drops the high-volume noise types entirely.
	private static void WalkGameEvents(StormReplay replay, MatchJson match,
			Dictionary<StormPlayer, int> senderToIndex, int numPlayers) {
		foreach (var ge in replay.GameEvents) {
			if (ge.GameEventType == null) {
				continue;
			}
			// Observers emit game events too and are absent from StormPlayers, so
			// their sender never resolves. TryGetValue(out playerIdx) would zero the
			// sentinel and credit them to player 0; keep -1 for "not a player".
			int playerIdx = -1;
			if (ge.MessageSender != null && senderToIndex.TryGetValue(ge.MessageSender, out int senderIdx)) {
				playerIdx = senderIdx;
			}
			int gameLoop = LoopFromTimestamp(ge.Timestamp);

			switch (ge.GameEventType.Value) {
				case StormGameEventType.SCmdEvent:
					HandleAbilityCommand(ge.Data, gameLoop, playerIdx, match);
					break;

				case StormGameEventType.SHeroTalentTreeSelectedEvent: {
					long? index = ge.Data?.Structure?.Count > 0 ? ScalarOf(ge.Data.Structure[0]) : null;
					if (index.HasValue) {
						match.TalentSelections.Add(new TalentSelectionJson {
							Gameloop = gameLoop, PlayerIndex = playerIdx, Index = index.Value,
						});
					}
					break;
				}

				case StormGameEventType.STriggerPingEvent:
					HandleTriggerPing(ge.Data, gameLoop, playerIdx, match);
					break;

				case StormGameEventType.SGameUserLeaveEvent:
					match.PlayerLeaveJoin.Add(new PlayerLeaveJoinJson {
						Gameloop = gameLoop, PlayerIndex = playerIdx, Kind = "leave",
						LeaveReason = ge.Data?.Structure?.Count > 0 ? ScalarOf(ge.Data.Structure[0]) : null,
					});
					break;

				case StormGameEventType.SGameUserJoinEvent:
					match.PlayerLeaveJoin.Add(new PlayerLeaveJoinJson {
						Gameloop = gameLoop, PlayerIndex = playerIdx, Kind = "join",
					});
					break;
			}
		}
	}

	// SCmdEvent carries an m_abil substructure only for ability casts (plain
	// moves and unit-targets without an ability are dropped). The library
	// compacts absent optional fields out of the exposed structure, so slots are
	// in-order-present: [cmdFlags, abil?, data, vector?, sequence]. m_abil, when
	// present, is the structure at slot 1 whose first element fits a 16-bit
	// abilLink and second a 5-bit abilCmdIndex; a TargetPoint at slot 1 (a move)
	// has a large first coordinate and is excluded.
	private static void HandleAbilityCommand(StormGameEventData? data, int gameLoop, int playerIdx, MatchJson match) {
		var s = data?.Structure;
		if (s == null || s.Count < 2) {
			return;
		}
		// m_abil is a 2- or 3-element structure {abilLink, abilCmdIndex,
		// abilCmdData?}. A TargetPoint at slot 1 (a move) is also a 3-element
		// structure but its first element is a large coordinate; a TargetUnit is
		// a 7-element structure. Requiring count 2-3 with a 16-bit first element
		// and 5-bit second element isolates real ability casts from both.
		var abil = s[1];
		if (abil == null || abil.DataType != StormGameEventDataType.Structure || abil.Structure == null
				|| (abil.Structure.Count != 2 && abil.Structure.Count != 3)) {
			return;
		}
		long? abilLink = ScalarOf(abil.Structure[0]);
		long? abilCmdIndex = ScalarOf(abil.Structure[1]);
		if (abilLink == null || abilCmdIndex == null || abilLink > 65535 || abilCmdIndex > 31) {
			return;
		}
		// abilCmdData is an 8-bit optional. A 3-element slot whose third element
		// exceeds 8 bits is a TargetPoint move (z coordinate), not an ability.
		long? abilCmdData = abil.Structure.Count == 3 ? ScalarOf(abil.Structure[2]) : null;
		if (abil.Structure.Count == 3 && (abilCmdData == null || abilCmdData > 255)) {
			return;
		}

		var cmd = new AbilityCommandJson {
			Gameloop = gameLoop,
			PlayerIndex = playerIdx,
			CmdFlags = ScalarOf(s[0]) ?? 0,
			AbilLink = abilLink.Value,
			AbilCmdIndex = abilCmdIndex.Value,
			AbilCmdData = abilCmdData,
			Sequence = ScalarOf(s[s.Count - 1]) ?? 0,
			TargetKind = "none",
		};

		// m_data occupies the slot right after m_abil.
		var target = s.Count > 2 ? s[2] : null;
		if (target != null) {
			if (target.DataType == StormGameEventDataType.Structure && target.Structure != null) {
				var t = target.Structure;
				if (t.Count == 3) {
					cmd.TargetKind = "point";
					cmd.TargetX = ScalarOf(t[0]);
					cmd.TargetY = ScalarOf(t[1]);
					cmd.TargetZ = ScalarOf(t[2]);
				} else if (t.Count >= 3) {
					cmd.TargetKind = "unit";
					cmd.TargetUnitTag = ScalarOf(t[2]);
				}
			} else if (target.DataType != StormGameEventDataType.Structure) {
				cmd.TargetKind = "data";
			}
		}
		match.AbilityCommands.Add(cmd);
	}

	// STriggerPingEvent: [0] = point{x,y}, [1] = pinged unit tag, [2] = minimap
	// flag, [3] = m_option ping subtype.
	private static void HandleTriggerPing(StormGameEventData? data, int gameLoop, int playerIdx, MatchJson match) {
		var s = data?.Structure;
		if (s == null || s.Count < 1) {
			return;
		}
		var ping = new TriggerPingJson { Gameloop = gameLoop, PlayerIndex = playerIdx };
		var point = s[0];
		if (point != null && point.DataType == StormGameEventDataType.Structure && point.Structure != null
				&& point.Structure.Count >= 2) {
			ping.X = ScalarOf(point.Structure[0]) ?? 0;
			ping.Y = ScalarOf(point.Structure[1]) ?? 0;
		}
		if (s.Count > 1) {
			ping.PingedUnitTag = ScalarOf(s[1]) ?? 0;
		}
		if (s.Count > 2 && s[2] != null && s[2].DataType == StormGameEventDataType.Bool) {
			ping.Minimap = s[2].Boolean ?? false;
		}
		if (s.Count > 3) {
			ping.Option = ScalarOf(s[3]) ?? 0;
		}
		match.TriggerPings.Add(ping);
	}

	// Reads any integer-valued game-event node (uint32/int32/uint64) as a long.
	private static long? ScalarOf(StormGameEventData? d) {
		if (d == null) {
			return null;
		}
		return d.DataType switch {
			StormGameEventDataType.UnsignedInteger32 => d.UnsignedInteger32,
			StormGameEventDataType.Integer32 => d.Integer32,
			StormGameEventDataType.UnsignedInteger64 => (long?)d.UnsignedInteger64,
			_ => null,
		};
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
