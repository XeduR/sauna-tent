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

	// --- Tier-2 superset extraction ---
	// Everything below is emitted for the tier-2 archive only. The Python
	// pipeline's write_match applies an explicit whitelist so none of it reaches
	// the tier-1 committed match schema.

	// Full per-team level-up timeline, keyed "0" (Blue) / "1" (Red).
	public Dictionary<string, List<TeamLevelJson>>? LevelTimeline { get; set; }
	// Full per-team XP breakdown (~60s cadence), keyed "0" / "1".
	public Dictionary<string, List<XpBreakdownJson>>? XpBreakdown { get; set; }
	// Full message-event ping records (position + sender + recipient).
	public List<PingRecordJson> Pings { get; set; } = new();
	// Kill feed from the PlayerDeath StatGameEvent: victim + all killers/assists.
	public List<PlayerDeathJson> KillFeed { get; set; } = new();
	// Hero-death positions from SUnitDiedEvent (x,y at structure[3,4]).
	public List<HeroUnitDeathJson> HeroUnitDeaths { get; set; } = new();
	// Full jungle-camp capture timeline (every capture, not just first).
	public List<JungleCampJson> JungleCamps { get; set; } = new();
	// Draft ban/pick/swap timeline with per-entry gameloop (typed DraftPicks
	// drops timing).
	public List<DraftTimingJson> DraftTimeline { get; set; } = new();
	// SUnitPositionsEvent snapshots: firstUnitIndex + raw flat item array.
	public List<UnitPositionsJson> UnitPositions { get; set; } = new();
	// Generic preservation of every StatGameEvent not consumed by a dedicated
	// path above. Captures per-map objective events without per-map code.
	public List<GenericStatEventJson> StatEvents { get; set; } = new();
	// SCmdEvent records that carry an m_abil substructure (ability casts).
	public List<AbilityCommandJson> AbilityCommands { get; set; } = new();
	// SHeroTalentTreeSelectedEvent: live talent-selection timing.
	public List<TalentSelectionJson> TalentSelections { get; set; } = new();
	// STriggerPingEvent (game event) ping records.
	public List<TriggerPingJson> TriggerPings { get; set; } = new();
	// SGameUserLeaveEvent / SGameUserJoinEvent records.
	public List<PlayerLeaveJoinJson> PlayerLeaveJoin { get; set; } = new();
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

	// --- Tier-2 superset extraction (per player) ---
	// Full named award identities (enum names). The tier-1 boolean award flags
	// in Stats are kept separately for schema stability.
	public List<string> MatchAwardsList { get; set; } = new();
	// Equipped cosmetics catalog ids (skin/mount/banner/spray/announcer/voice
	// + AttributeId variants), stored as-is.
	public LoadoutJson? Loadout { get; set; }
	// ScoreResult typed props not present in the tier-1 Stats schema.
	public ScoreExtendedJson? ScoreExtended { get; set; }
	// ScoreResult.MiscellaneousScoreResultEvents: named map/objective fields
	// plus the entire dict stored generically.
	public MiscScoreJson? MiscScore { get; set; }
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

// --- Tier-2 superset DTOs ---
//
// PlayerIndex on the game-event records below is -1 when the event came from an
// observer (or any sender outside StormPlayers), never a valid player slot.

public class TeamLevelJson {
	public int Level { get; set; }
	public double Time { get; set; }
}

public class XpBreakdownJson {
	public int Level { get; set; }
	public double Time { get; set; }
	public int MinionXP { get; set; }
	public int CreepXP { get; set; }
	public int StructureXP { get; set; }
	public int HeroXP { get; set; }
	public int PassiveXP { get; set; }
	public long TotalXP { get; set; }
}

public class PingRecordJson {
	public int PlayerIndex { get; set; }
	public int Gameloop { get; set; }
	public double X { get; set; }
	public double Y { get; set; }
	public int Recipient { get; set; }
}

public class PlayerDeathJson {
	public int Gameloop { get; set; }
	// Victim + killers are player indices (tracker player id minus 1).
	public int Victim { get; set; }
	public List<int> Killers { get; set; } = new();
	// Death position, already divided by 4096 into map coordinates.
	public double X { get; set; }
	public double Y { get; set; }
}

public class HeroUnitDeathJson {
	public int Gameloop { get; set; }
	public int Victim { get; set; }
	// Raw x,y from SUnitDiedEvent (direct values, no scaling).
	public int X { get; set; }
	public int Y { get; set; }
	// 0=minion, 1=merc, 2=structure, 3=monster; null when killed by a player.
	public int? KillerCategory { get; set; }
}

public class JungleCampJson {
	public int Gameloop { get; set; }
	public int Team { get; set; }
	public string CampType { get; set; } = "";
	public long CampId { get; set; }
}

public class DraftTimingJson {
	// "ban", "pick", or "swap".
	public string Type { get; set; } = "";
	public string Hero { get; set; } = "";
	public int Gameloop { get; set; }
	// Controlling team (ban) or working-set slot / controlling player (pick).
	public long Value { get; set; }
}

public class UnitPositionsJson {
	public int Gameloop { get; set; }
	public int FirstUnitIndex { get; set; }
	// Raw decoded flat array; interpreted as (indexDelta, x, y) triplets.
	// Scale factor for x,y unconfirmed - stored raw (preservation-first).
	public List<long> Items { get; set; } = new();
}

public class StatFieldJson {
	public string Name { get; set; } = "";
	public long Value { get; set; }
}

public class StatStringFieldJson {
	public string Name { get; set; } = "";
	public string Value { get; set; } = "";
}

public class GenericStatEventJson {
	public string Name { get; set; } = "";
	public int Gameloop { get; set; }
	public List<StatStringFieldJson>? Strings { get; set; }
	public List<StatFieldJson>? Ints { get; set; }
	// Fixed-point values stored raw; divide by 4096 for the real value.
	public List<StatFieldJson>? Fixeds { get; set; }
}

public class AbilityCommandJson {
	public int Gameloop { get; set; }
	public int PlayerIndex { get; set; }
	public long CmdFlags { get; set; }
	public long AbilLink { get; set; }
	public long AbilCmdIndex { get; set; }
	public long? AbilCmdData { get; set; }
	// "point", "unit", "none", or "data".
	public string TargetKind { get; set; } = "";
	public long? TargetX { get; set; }
	public long? TargetY { get; set; }
	public long? TargetZ { get; set; }
	public long? TargetUnitTag { get; set; }
	public long Sequence { get; set; }
}

public class TalentSelectionJson {
	public int Gameloop { get; set; }
	public int PlayerIndex { get; set; }
	// Flattened talent-tree selection index (tiers concatenated, monotonic per
	// player across the 7 picks). Mapping to a specific talent is build-dependent.
	public long Index { get; set; }
}

public class TriggerPingJson {
	public int Gameloop { get; set; }
	public int PlayerIndex { get; set; }
	public long X { get; set; }
	public long Y { get; set; }
	public long PingedUnitTag { get; set; }
	public bool Minimap { get; set; }
	// m_option ping subtype.
	public long Option { get; set; }
}

public class PlayerLeaveJoinJson {
	public int Gameloop { get; set; }
	public int PlayerIndex { get; set; }
	// "leave" or "join".
	public string Kind { get; set; } = "";
	public long? LeaveReason { get; set; }
}

public class LoadoutJson {
	public string? SkinAndSkinTint { get; set; }
	public string? SkinAndSkinTintAttributeId { get; set; }
	public string? MountAndMountTint { get; set; }
	public string? MountAndMountTintAttributeId { get; set; }
	public string? Banner { get; set; }
	public string? BannerAttributeId { get; set; }
	public string? Spray { get; set; }
	public string? SprayAttributeId { get; set; }
	public string? AnnouncerPack { get; set; }
	public string? AnnouncerPackAttributeId { get; set; }
	public string? VoiceLine { get; set; }
	public string? VoiceLineAttributeId { get; set; }
}

public class ScoreExtendedJson {
	public int TownKills { get; set; }
	public int WatchTowerCaptures { get; set; }
	public int MinionDamage { get; set; }
	public int ClutchHealsPerformed { get; set; }
	public int EscapesPerformed { get; set; }
	public int VengeancesPerformed { get; set; }
	public int OutnumberedDeaths { get; set; }
	public int TeamfightEscapesPerformed { get; set; }
}

public class MiscScoreJson {
	// Named fields pulled out of MiscellaneousScoreResultEvents when present.
	// Units of the Time* keys are unconfirmed (likely seconds); stored raw.
	public int? TimeOnPoint { get; set; }
	public int? TimeInTemple { get; set; }
	public int? TimeOnPayload { get; set; }
	public int? KilledTreasureGoblin { get; set; }
	// The entire misc dict, stored generically.
	public Dictionary<string, int> All { get; set; } = new();
}
