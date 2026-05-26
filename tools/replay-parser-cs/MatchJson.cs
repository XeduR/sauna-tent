// DTOs for the intermediate JSON the sidecar emits to stdout. The Python
// pipeline reads this shape and reshapes it into the per-match output schema
// (hero name resolution, ARAM detection, toxicity, chat aggregates, KDA).

using System.Collections.Generic;

namespace HeroesReplayParserCs;

public class MatchJson {
	public int Build { get; set; }
	public string Timestamp { get; set; } = "";
	public double DurationSeconds { get; set; }
	public int ElapsedGameLoops { get; set; }
	public long RandomSeed { get; set; }
	public string GameMode { get; set; } = "Unknown";
	public string LobbyMode { get; set; } = "Unknown";
	public int? WinningTeam { get; set; }
	public string? MapInternalId { get; set; }
	public string MapLocalizedName { get; set; } = "";
	public List<PlayerJson> Players { get; set; } = new();
	public int? FirstBloodTeam { get; set; }
	public Dictionary<string, int> FirstToLevel { get; set; } = new();
	public Dictionary<string, int>? TeamLevels { get; set; }
	public int? FirstBossTeam { get; set; }
	public int? FirstMercTeam { get; set; }
	public List<DraftEntryJson> Draft { get; set; } = new();
	public List<ChatRecordJson> ChatRecords { get; set; } = new();

	// True when at least one player's ScoreResult is null. Indicates an
	// incomplete game (someone left before scores were emitted). Consumers
	// either reject the match or filter it as "incomplete".
	public bool IsIncomplete { get; set; }
}

public class PlayerJson {
	public string Name { get; set; } = "";
	public string? HeroInternal { get; set; }
	public string HeroLocalizedFallback { get; set; } = "";
	public int Team { get; set; }
	public string Result { get; set; } = "";
	public ToonJson Toon { get; set; } = new();
	public int? HeroLevel { get; set; }
	public List<int?> TalentChoices { get; set; } = new();
	public StatsJson Stats { get; set; } = new();

	// 1 when PlayerType.Computer (AI). Omitted for human players so the
	// JSON stays compact for the typical case.
	public int? IsComputer { get; set; }
}

public class ToonJson {
	public int? Region { get; set; }
	public int? RealmId { get; set; }
	public long? ProfileId { get; set; }
}

public class StatsJson {
	public int Kills { get; set; }
	public int Deaths { get; set; }
	public int Assists { get; set; }
	public int Takedowns { get; set; }
	public int HeroDamage { get; set; }
	public int SiegeDamage { get; set; }
	public int StructureDamage { get; set; }
	public int Healing { get; set; }
	public int SelfHealing { get; set; }
	public int DamageTaken { get; set; }
	public int XpContribution { get; set; }
	public int TimeSpentDead { get; set; }
	public int MercCaptures { get; set; }
	public int CreepDamage { get; set; }
	public int SummonDamage { get; set; }
	public int TimeCCdEnemyHeroes { get; set; }
	public int DamageSoaked { get; set; }
	public int HighestKillStreak { get; set; }
	public int ProtectionGiven { get; set; }
	public int TeamfightHeroDamage { get; set; }
	public int TeamfightDamageTaken { get; set; }
	public int TeamfightHealing { get; set; }
	public int MinionKills { get; set; }
	public int RegenGlobes { get; set; }
	public int Multikill { get; set; }

	public int? PhysicalDamage { get; set; }
	public int? SpellDamage { get; set; }
	public int? TimeOnFire { get; set; }

	public int? AwardMVP { get; set; }
	public int? AwardMapSpecific { get; set; }
	public int? AwardInternal { get; set; }
	public int? HasAward { get; set; }

	public int? DeathsByMinions { get; set; }
	public int? DeathsByMercs { get; set; }
	public int? DeathsByStructures { get; set; }
	public int? DeathsByMonsters { get; set; }

	public int? Pings { get; set; }
	public int? Disconnects { get; set; }
	public int? DisconnectedAtEnd { get; set; }

	public int? VotesReceived { get; set; }
	public int? VotesGiven { get; set; }
}

public class DraftEntryJson {
	public string Type { get; set; } = "";
	public int Team { get; set; }
	public string Hero { get; set; } = "";
}

public class ChatRecordJson {
	public int PlayerIndex { get; set; }
	public int Gameloop { get; set; }
	public string Text { get; set; } = "";
	public int Recipient { get; set; }
}
