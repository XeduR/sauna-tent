# StormReplay Data Reference

Everything extractable from a Heroes of the Storm `.StormReplay` file. Intended as a planning reference for deciding what data to show on the dashboard.

## File Format

A `.StormReplay` is an MPQ (Mo'PaQ) archive containing 7 binary files, each decoded by a build-specific protocol module. Blizzard's `heroprotocol` tool extracts each section via command-line flags.

| Archive File | heroprotocol Flag | Contents |
|---|---|---|
| replay.header | `--header` | Protocol version, build number, total game duration |
| replay.details | `--details` | Player list, heroes, teams, result, map name, timestamp |
| replay.initdata | `--initdata` | Lobby state, game settings, cosmetics, draft data, randomSeed |
| replay.game.events | `--gameevents` | Every player input (abilities, movement, camera, selections) |
| replay.message.events | `--messageevents` | Chat messages, pings, announcements |
| replay.tracker.events | `--trackerevents` | Unit spawns/deaths, stats, objectives, score results, positions |
| replay.attributes.events | `--attributeevents` | Hero selections, talent codes, bans (key-value pairs) |

`--stats` prints SPlayerStatsEvent data to stderr. `--json` outputs as one JSON object per line (not a valid JSON array).

## Match Metadata

### From Header

- Game version (`m_version`: major, minor, revision, build, baseBuild)
- Total duration in game loops (`m_elapsedGameLoops`, divide by 16 for seconds)
- Data build number (`m_dataBuildNum`, used to select the correct protocol decoder)
- File hash (`m_fixedFileHash`)

### From Details

- Map name (`m_title`, localized to the recording player's client language)
- Match timestamp (`m_timeUTC`, Windows File Time format)
- Local time offset (`m_timeLocalOffset`)

### From Init Data

- Random seed (`m_syncLobbyState.m_gameDescription.m_randomValue`, server-set, identical across all players' replays of the same match, used for match fingerprinting)
- Game mode ID (`m_gameOptions.m_ammId`): 50001 QM, 50021 vs AI, 50031 Brawl, 50041 Practice, 50051 Unranked Draft, 50061 Hero League, 50071 Team League, -1 Custom

### From Attribute Events

- Game mode (attributes 3009 Matchmaking + 4010 Lobby type)
- Hero bans via attribute IDs 4023/4025/4028/4030/4043/4045 (scope 16)

### From Tracker Events

- Map name (language-independent, from `EndOfGameTalentChoices` event `m_stringData[2]`)
- `GatesOpen` event marks game time 0:00 (use its `_gameloop` as the offset for all time calculations)
- `GameStart` event marks match start

## Player Data

### Identity (from Details)

Per player in `m_playerList[]`:

- Player name (`m_name`)
- Hero name (`m_hero`, localized)
- Result (`m_result`: 1 = victory, 0 = defeat)
- Team (derived from slot position)
- Toon handle (`m_toon`: region, realm, id, programId)
- Working Set Slot ID (`m_workingSetSlotId`, used by draft pick events)
- Observer flag (`m_observe`)

### Cosmetics and Account Flags (from Init Data)

Per lobby slot in `m_syncLobbyState.m_lobbyState.m_slots[]`:

- Equipped skin (`m_skin`, internal ID)
- Equipped mount (`m_mount`, internal ID)
- Announcer pack (`m_announcerPack`, internal ID)
- Spray equipped (`m_spray`)
- Chat silence penalty active (`m_hasSilencePenalty`)
- Voice silence penalty active (`m_hasVoiceSilencePenalty`)
- Blizzard staff flag (`m_isBlizzardStaff`)
- Active XP boost (`m_hasActiveBoost`, added in patch 2.40)

### Hero Level (from Attribute Events)

- Hero level per player (attribute ID 4008, capped at 20)

### Client Settings (from Game Events)

- Platform (Mac flag)
- Hotkey profile name
- Camera follow setting
- Full download status

## Draft Data

### Bans (from Tracker Events)

`SHeroBannedEvent` (eventid 13), fired in draft order:

- Hero name (`m_hero`, internal name)
- Banning team (`m_controllingTeam`: 1=blue, 2=red)
- Timestamp (`_gameloop`)

Also available from attribute events (scope 16): attribute IDs 4023, 4025 (blue bans 1-2), 4028, 4030 (red bans 1-2), 4043, 4045 (blue/red ban 3).

### Picks (from Tracker Events)

`SHeroPickedEvent` (eventid 14), fired in draft order:

- Hero name (`m_hero`, internal name)
- Picking player (`m_controllingPlayer`, Working Set Slot ID, NOT tracker player ID)
- Timestamp (`_gameloop`)

Pick order is chronological (first event = first pick). Cross-reference `m_controllingPlayer` with `m_workingSetSlotId` from details to identify the player.

## Talent Choices

Available from three sources (use EndOfGameTalentChoices for the most reliable internal names):

1. **EndOfGameTalentChoices** (tracker SStatGameEvent): `m_stringData[3..9]` = tiers 1-7 as internal talent names. Also gives final level, hero name, win/loss, and map name.
2. **Attribute events**: attribute IDs 4032-4038 = tiers 1-7 as 4-character talent codes.
3. **SScoreResultEvent**: `Tier1Talent` through `Tier7Talent` as integer talent IDs.

Additionally, `TalentChosen` (tracker SStatGameEvent) fires at the moment each talent is picked, giving exact timing per tier.

`SHeroTalentTreeSelectedEvent` (game event, eventid 64) fires when the talent UI selection is made.

## End-of-Game Stats (SScoreResultEvent)

All stats below are available per player. Accessed via `m_instanceList[]` where each entry has `m_name` (stat key) and `m_values[]` indexed by tracker player ID.

### Combat

| Stat | Description |
|---|---|
| SoloKill | Killing blows |
| Assists | Assists |
| Takedowns | Kills + assists |
| Deaths | Deaths |
| HighestKillStreak | Longest kill streak without dying |
| TownKills | Structures destroyed |

### Damage Dealt

| Stat | Description |
|---|---|
| HeroDamage | Total damage to enemy heroes |
| SiegeDamage | Total siege damage (structures + minions + summons) |
| StructureDamage | Damage to structures only |
| MinionDamage | Damage to minions only |
| CreepDamage | Damage to mercenaries only |
| SummonDamage | Damage to summoned units only |
| PhysicalDamage | Auto-attack damage to all targets |
| SpellDamage | Ability damage to all targets |

### Damage Received

| Stat | Description |
|---|---|
| DamageTaken | Total damage absorbed |
| DamageSoaked | Total HP at each death (cumulative) |

### Healing and Support

| Stat | Description |
|---|---|
| Healing | Healing done to allied heroes |
| SelfHealing | Self-healing |
| ProtectionGivenToAllies | Shielding given to allies |
| ClutchHealsPerformed | Heals on low-health allies |

### Crowd Control

| Stat | Description |
|---|---|
| TimeCCdEnemyHeroes | Total CC time applied to enemies (seconds) |
| TimeStunningEnemyHeroes | Stun time (includes sleep) |
| TimeRootingEnemyHeroes | Root time |
| TimeSilencingEnemyHeroes | Silence time |

### Experience

| Stat | Description |
|---|---|
| ExperienceContribution | Personal XP contribution |
| MetaExperience | Total team XP |
| Level | Final hero level |
| TeamLevel | Final team level |

### Objectives and Map

| Stat | Description |
|---|---|
| MercCampCaptures | Mercenary camps captured |
| WatchTowerCaptures | Vision towers captured |
| TimeOnPoint | Time on objective control points |
| TimeInTemple | Time in Sky Temple zones |
| TimeOnPayload | Time on Hanamura payload |

### Teamfight Stats

| Stat | Description |
|---|---|
| TeamfightHeroDamage | Hero damage during teamfights |
| TeamfightDamageTaken | Damage taken during teamfights |
| TeamfightHealingDone | Healing during teamfights |
| TeamfightEscapesPerformed | Escapes from teamfights |

### Time and Misc

| Stat | Description |
|---|---|
| TimeSpentDead | Total time dead (seconds) |
| OnFireTimeOnFire | Time with "on fire" status (matchmade games) |
| MinionKills | Lane minions killed (from regen globe / soak context) |
| RegenGlobes | Regeneration globes picked up |
| EscapesPerformed | Total escapes |
| OutnumberedDeaths | Deaths while outnumbered |
| VengeancesPerformed | Revenge kills (killing your recent killer) |
| KilledTreasureGoblin | Treasure goblin kills (seasonal event) |

### End-of-Match Awards

Boolean fields (0 or 1). A player receives at most one award per match.

| Stat | Award |
|---|---|
| EndOfMatchAwardMVPBoolean | MVP |
| EndOfMatchAwardHighestKillStreakBoolean | Dominator |
| EndOfMatchAwardMostVengeancesPerformedBoolean | Avenger |
| EndOfMatchAwardMostDaredevilEscapesBoolean | Daredevil |
| EndOfMatchAwardMostEscapesBoolean | Escape Artist |
| EndOfMatchAwardMostXPContributionBoolean | Experienced |
| EndOfMatchAwardMostHeroDamageDoneBoolean | Painbringer |
| EndOfMatchAwardMostKillsBoolean | Finisher |
| EndOfMatchAwardHatTrickBoolean | Hat Trick |
| EndOfMatchAwardClutchHealerBoolean | Clutch Healer |
| EndOfMatchAwardMostProtectionBoolean | Protector |
| EndOfMatchAward0DeathsBoolean | Sole Survivor |
| EndOfMatchAwardMostSiegeDamageDoneBoolean | Siege Master |
| EndOfMatchAwardMostDamageTakenBoolean | Bulwark |
| EndOfMatchAward0OutnumberedDeathsBoolean | Team Player |
| EndOfMatchAwardMostHealingBoolean | Main Healer |
| EndOfMatchAwardMostStunsBoolean | Stunner |
| EndOfMatchAwardMostRootsBoolean | Trapper |
| EndOfMatchAwardMostSilencesBoolean | Silencer |
| EndOfMatchAwardMostMercCampsCapturedBoolean | Headhunter |
| EndOfMatchAwardMapSpecificBoolean | Map Objective |
| EndOfMatchAwardMostTeamfightDamageTakenBoolean | Guardian |
| EndOfMatchAwardMostTeamfightHealingDoneBoolean | Combat Medic |
| EndOfMatchAwardMostTeamfightHeroDamageDoneBoolean | Scrapper |
| EndOfMatchAwardGivenToNonwinner | Internal (award given to losing team) |

#### Map-Specific Awards

| Stat | Map |
|---|---|
| EndOfMatchAwardMostDragonShrinesCapturedBoolean | Dragon Shire |
| EndOfMatchAwardMostCurseDamageDoneBoolean | Cursed Hollow |
| EndOfMatchAwardMostCoinsPaidBoolean | Blackheart's Bay |
| EndOfMatchAwardMostImmortalDamageBoolean | Battlefield of Eternity |
| EndOfMatchAwardMostDamageDoneToZergBoolean | Braxis Holdout |
| EndOfMatchAwardMostDamageToPlantsBoolean | Garden of Terror |
| EndOfMatchAwardMostDamageToMinionsBoolean | Infernal Shrines |
| EndOfMatchAwardMostTimeInTempleBoolean | Sky Temple |
| EndOfMatchAwardMostGemsTurnedInBoolean | Tomb of the Spider Queen |
| EndOfMatchAwardMostSkullsCollectedBoolean | Haunted Mines |
| EndOfMatchAwardMostAltarDamageDone | Towers of Doom |
| EndOfMatchAwardMostNukeDamageDoneBoolean | Warhead Junction |
| EndOfMatchAwardMostInterruptedCageUnlocksBoolean | Alterac Pass |

## Player Positions and Heatmaps

### SUnitPositionsEvent (tracker, eventid 8)

Periodic position snapshots fired every 240 game loops (~15 seconds). Only tracks units that have recently dealt or taken damage (max 256 units per event).

Fields:

- `_gameloop`: timestamp
- `m_firstUnitIndex`: starting unit index
- `m_items`: array of position deltas (groups of 3 integers)

Decoding `m_items`:

```
unitIndex = m_firstUnitIndex
for i = 0 to len(m_items) step 3:
    unitIndex += m_items[i]    // unit index delta
    x = m_items[i+1] * 4      // X coordinate
    y = m_items[i+2] * 4      // Y coordinate
```

This is the primary source for player heatmaps. Resolution is ~15 seconds. Units that have not dealt or taken damage are omitted from that snapshot.

### SUnitBornEvent / SUnitDiedEvent Positions

Both events include `m_x` and `m_y` coordinates (direct values, no scaling). These give exact positions at spawn and death time, useful for death location heatmaps.

### PlayerDeath Positions (tracker SStatGameEvent)

`m_fixedData[0]` and `m_fixedData[1]` give X/Y position (divide by 4096).

### Camera Position (game events)

`SCameraUpdateEvent` (eventid 49) records camera target position, distance, pitch, and yaw. Fires frequently. Can approximate where a player is looking/paying attention.

## Kill and Death Events

### Hero Deaths (tracker SStatGameEvent: PlayerDeath)

- Killed player's tracker ID (`m_intData[0]`)
- All participating killer tracker IDs (`m_intData[1+]`, includes assists)
- Death position (`m_fixedData[0..1]`, divide by 4096)
- Timestamp (`_gameloop`)

### Unit Deaths (tracker: SUnitDiedEvent)

- Dying unit tag (index + recycle, cross-reference with SUnitBornEvent to get unit type)
- Killer player ID (`m_killerPlayerId`, null if no killer, e.g. timed despawn)
- Killer unit tag (index + recycle)
- Death position (`m_x`, `m_y`)
- Timestamp (`_gameloop`)

Covers all unit types: heroes, structures, minions, mercs, bosses, summons, objectives.

### Hero Revivals (tracker: SUnitRevivedEvent)

- Unit tag (index + recycle)
- Revival position (`m_x`, `m_y`)
- Timestamp (`_gameloop`)

## Structures

### Initialization (tracker SStatGameEvent: TownStructureInit)

Fires at match start for every structure. Establishes the full structure state.

### Destruction (tracker SStatGameEvent: TownStructureDeath)

Fires when any town structure is destroyed: forts, keeps, towers, gates, walls, healing fountains.

### Structure Unit Types (from SUnitBornEvent)

| Unit Type | Structure |
|---|---|
| TownTownHallL2 | Fort |
| TownTownHallL3 | Keep |
| TownMoonwellL2 | Fort healing fountain |
| TownMoonwellL3 | Keep healing fountain |
| TownCannonTowerL2 | Fort tower |
| TownCannonTowerL3 | Keep tower |
| TownWallL2 | Fort wall |
| TownWallL3 | Keep wall |
| TownGateL2BRUpper (etc.) | Fort gate |
| KingsCore | Core |
| VanndarStormpike, DrekThar | Alterac Pass cores |

L2 = fort tier, L3 = keep tier.

## Mercenary Camps

### Camp Initialization (tracker SStatGameEvent: JungleCampInit)

Marks initial spawn of each camp at match start.

### Camp Capture (tracker SStatGameEvent: JungleCampCapture)

- Capturing team (`m_fixedData[0]`: 1=blue, 2=red, divide by 4096)
- Camp type string (`m_stringData[0]`)
- Timestamp (`_gameloop`)

### Mercenary Unit Types (from SUnitBornEvent)

| Unit Type | Camp |
|---|---|
| MercLanerSiegeGiant | Siege giants |
| MercSiegeTrooperLaner | Bruiser camp |
| MercLanerRangedOgre, MercLanerMeleeOgre | Ogre camp |
| MercLanerMeleeKnight, MercLanerRangedMage | Knight camp |
| MercSummonerLaner | Summoner camp |
| MercLanerSentinel | Hanamura siege |
| MercGoblicSapperLaner | Goblin sapper |
| TerranHellbat | Alterac siege |
| TerranGoliath | Goliath camp |

### Boss Unit Types

| Unit Type | Map(s) |
|---|---|
| JungleGraveGolemLaner | Cursed Hollow, Sky Temple, Tomb, Alterac |
| TerranArchangelLaner | Braxis Holdout |
| SlimeBossLaner | Warhead Junction |

## Map Objectives

### Cursed Hollow

**TributeCollected** (tracker SStatGameEvent): team that collected (`m_fixedData[0]`, divide by 4096).

**RavenLordTribute** (SUnitBornEvent): tribute spawn position and time.

### Dragon Shire

**DragonKnightActivated** (tracker SStatGameEvent): activating team.

Shrine unit types: `DragonShireShrineSun`, `DragonShireShrineMoon` (SUnitBornEvent). Vehicle: `VehicleDragon`.

### Garden of Terror

**GardenTerrorActivated** (tracker SStatGameEvent): activating team.

Vehicle: `VehiclePlantHorror`.

### Sky Temple

**SkyTempleShotsFired** (tracker SStatGameEvent): team (`m_intData[2]`), damage dealt (`m_fixedData[0]`).

**SkyTempleCaptured** (tracker SStatGameEvent): temple control event.

### Battlefield of Eternity

**Immortal Defeated** (tracker SStatGameEvent): winning team (`m_intData[1]`), fight duration in seconds (`m_intData[2]`), remaining shield/power (`m_fixedData[0]`).

Immortal unit types: `BossDuelLanerHeaven`, `BossDuelLanerHell`.

### Infernal Shrines

**Infernal Shrine Captured** (tracker SStatGameEvent): winning team (`m_intData[1]`), winner's skeleton count (`m_intData[2]`), loser's skeleton count (`m_intData[3]`).

**Punisher Killed** (tracker SStatGameEvent): team (`m_intData[1]`), duration alive in seconds (`m_intData[2]`), type (`m_stringData[0]`: Arcane/Frozen/Mortar), siege damage dealt (`m_fixedData[0]`), hero damage dealt (`m_fixedData[1]`).

### Tomb of the Spider Queen

**SpidersSpawned** (tracker SStatGameEvent): team (`m_fixedData[0]`), gems required for next turn-in (`m_intData[1]`).

Webweaver unit type: `SoulEater`.

### Towers of Doom

**Altar Captured** (tracker SStatGameEvent): team (`m_intData[0]`), number of forts controlled / shots fired (`m_intData[1]`).

**Six Town Event Start / End** (tracker SStatGameEvent): team (`m_intData[0]`). Fires when all 6 towers are controlled.

**Town Captured** (tracker SStatGameEvent): controlling team AI ID (`m_intData[0]`, subtract 10 for team number).

### Braxis Holdout

**BraxisHoldoutMapEventComplete** (tracker SStatGameEvent): blue team progress (`m_fixedData[0]`, 0.0-1.0), red team progress (`m_fixedData[1]`, 0.0-1.0).

Control points: `ZergHiveControlBeacon`. Zerg wave units: `ZergZergling`, `ZergBaneling`, `ZergHydralisk`, `ZergGuardian`, `ZergUltralisk`.

Wave strength formula:

```
score = 0.1 * banelings
score = max(score, 0.25 * (hydralisks - 2))
score = max(score, 0.35 * (guardians - 1))
```

### Warhead Junction

Nuke units: `WarheadSingle`, `WarheadDropped`. Target indicator: `NukeTargetMinimapIconUnit`.

### Hanamura

Payload: `Payload_Neutral`. Pickups: `HealingPulsePickup`, `TurretPickup`.

### Volskaya Foundry

Vehicle: `VolskayaVehicle` (Triglav Protector).

### Haunted Mines

Golem: `UnderworldSummonedBoss`.

## XP Breakdown Over Time

### Periodic (tracker SStatGameEvent: PeriodicXPBreakdown)

Fires approximately every 60 seconds. All XP values in `m_fixedData` (divide by 4096).

- Team (`m_intData[0]`: 1=blue, 2=red)
- Team level (`m_intData[1]`)
- Minion XP (`m_fixedData[2]`)
- Creep (mercenary) XP (`m_fixedData[3]`)
- Structure XP (`m_fixedData[4]`)
- Hero XP (`m_fixedData[5]`)
- Trickle XP (`m_fixedData[6]`)

### End of Game (tracker SStatGameEvent: EndOfGameXPBreakdown)

Per player:

- Minion XP (`m_fixedData[0]`)
- Creep XP (`m_fixedData[1]`)
- Structure XP (`m_fixedData[2]`)
- Hero XP (`m_fixedData[3]`)
- Trickle XP (`m_fixedData[4]`)

## Team Levels Over Time

`LevelUp` (tracker SStatGameEvent): tracker player ID (`m_intData[0]`), new level (`m_intData[1]`), timestamp (`_gameloop`).

Combined with PeriodicXPBreakdown team level data, this gives full team level progression.

## Chat Messages

### Text Chat (message events: SChatMessage, eventid 0)

- Message text (`m_string`)
- Sender (`_userid.m_userId`, lobby ID)
- Recipient scope (`m_recipient`: 0=All chat, 1=Allies only, 4=Observers only)
- Timestamp (`_gameloop`)

### Pings (message events: SPingMessage, eventid 1)

- Position (`m_point.x`, `m_point.y`)
- Sender (`_userid.m_userId`)
- Recipient scope (`m_recipient`)
- Timestamp (`_gameloop`)

Also available as `STriggerPingEvent` (game events, eventid 36) with: position, pinged unit (if any), minimap flag, ping type option.

### Player Announcements (message events: SPlayerAnnounceMessage, eventid 5)

In-game communication wheel announcements:

- Announcement type: None (generic), Ability (cooldown), Behavior (buff status), Vitals (0=Health, 2=Mana)
- Link data (`m_announceLink`)
- Related unit tags
- Sender and timestamp

### Other Message Events

- **SLoadingProgressMessage** (eventid 2): loading screen progress per player
- **SServerPingMessage** (eventid 3): server-side ping
- **SReconnectNotifyMessage** (eventid 4): player disconnect/reconnect notification

## Cosmetic Usage During Match

### Spray Usage (tracker SStatGameEvent: LootSprayUsed)

- Player ToonHandle (`m_stringData[1]`)
- Spray internal ID (`m_stringData[2]`)
- Position (`m_fixedData[0..1]`, divide by 4096)

### Voice Line Usage (tracker SStatGameEvent: LootVoiceLineUsed)

- Player ToonHandle (`m_stringData[1]`)
- Voice line internal ID (`m_stringData[2]`)
- Position (`m_fixedData[0..1]`, divide by 4096)

### Cosmetic Wheel (tracker SStatGameEvent: LootWheelUsed)

Interaction with the cosmetic wheel during a match.

## Player Actions (Game Events)

Game events record every player input. This is the largest data section by far.

### Ability Usage (SCmdEvent, eventid 27)

- Ability link ID (`m_abil.m_abilLink`, build-dependent)
- Command index (`m_abil.m_abilCmdIndex`)
- Target position (`m_data.TargetPoint`: x, y, z) or target unit (`m_data.TargetUnit`)
- Command sequence number
- Timestamp

Known stable ability link values:

| Action | m_abilLink | Notes |
|---|---|---|
| Hearthstone | 114 | Current builds (varies across build ranges: 200, 119, 116, 112) |
| Taunt | 22, cmdIndex 4 | Current (was 19 in older builds) |
| Dance | 22, cmdIndex 3 | Current (was 19 in older builds) |

Ability IDs change between game builds. No stable cross-build mapping exists. Hero-specific ability identification requires build-specific lookup tables.

### Camera Movement (SCameraUpdateEvent, eventid 49)

- Target position (x, y)
- Distance/zoom level
- Pitch and yaw

### Selection Events (SSelectionDeltaEvent, eventid 28)

- Control group ID
- Selection change delta

### Other Game Events

| eventid | Type | Description |
|---|---|---|
| 5 | SUserFinishedLoadingSyncEvent | Player finished loading |
| 7 | SUserOptionsEvent | Client settings (platform, hotkeys, build) |
| 9-13 | SBank*Events | Bank file data (persistent player data storage) |
| 14 | SCameraSaveEvent | Camera bookmark |
| 29 | SControlGroupUpdateEvent | Control group / activatable changes |
| 32 | STriggerChatMessageEvent | In-game chat trigger |
| 36 | STriggerPingEvent | Ping with position, unit, minimap flag |
| 39 | SUnitClickEvent | Unit clicked (spacebar centering) |
| 46 | STriggerSoundOffsetEvent | Hero voice/sound trigger |
| 64 | SHeroTalentTreeSelectedEvent | Talent tree UI selection |

## Misc Tracker Data

### Regen Globe Pickups (tracker SStatGameEvent: RegenGlobePickedUp)

- Player tracker ID (`m_intData[0]`)
- Timestamp (`_gameloop`)

Regen globe unit types from SUnitBornEvent: `RegenGlobe`, `RegenGlobeNeutral`.

### Unit Type Changes (tracker: SUnitTypeChangeEvent, eventid 4)

- Unit tag (index + recycle)
- New type name
- Timestamp

### Unit Owner Changes (tracker: SUnitOwnerChangeEvent, eventid 3)

- Unit tag (index + recycle)
- New controlling player (0=neutral, 11=blue AI, 12=red AI)
- New upkeep player
- Timestamp

### Upgrade Events (tracker: SUpgradeEvent, eventid 5)

Related to quest talent completions. Inconsistently used across builds.

- Player ID
- Upgrade type name
- Count

### End-of-Game Time Spent Dead (tracker SStatGameEvent: EndOfGameTimeSpentDead)

- Player tracker ID (`m_intData[0]`)
- Time spent dead in seconds (`m_intData[1]`)

### End-of-Game Upvotes (tracker SStatGameEvent: EndOfGameUpVotesCollected)

- Upvoted player tracker ID (`m_intData[0]`)
- Voter's tracker ID (`m_intData[1]`)
- Current vote count (`m_intData[2]`)

### Minion Types (from SUnitBornEvent)

| Unit Type | Minion |
|---|---|
| FootmanMinion | Melee minion |
| RangedMinion | Ranged minion |
| WizardMinion | Wizard minion (drops regen globe) |
| CatapultMinion | Catapult (spawns after fort destroyed) |

## Player ID Systems

Four different ID systems exist across the replay data. Mapping between them is required.

| ID Type | Source | Used By |
|---|---|---|
| Lobby/User ID | `initdata.m_slots[].m_userId` | Game events, message events |
| Working Set Slot ID | `details.m_playerList[].m_workingSetSlotId` | SHeroPickedEvent |
| Tracker Player ID | `PlayerInit.m_intData[0]` | All tracker events |
| ToonHandle | `details.m_playerList[].m_toon` | Cross-game player identity |

Observers appear in `m_playerList` but NOT in tracker events (no PlayerInit). This can cause ID misalignment if not handled.

## Data Conversion Reference

| Conversion | Formula |
|---|---|
| Game loops to seconds | `seconds = (gameloops - gatesOpenLoop) / 16` |
| Windows File Time to date | `date = new Date(filetime / 10000 - 11644473600000)` |
| Fixed data to actual value | `value = m_fixedData / 4096` |
| Unit tag from index/recycle | `unitTag = protocol.unit_tag(index, recycle)` |
| SUnitPositionsEvent coords | `x = m_items[i+1] * 4`, `y = m_items[i+2] * 4` |
| PlayerDeath coords | `x = m_fixedData[0] / 4096`, `y = m_fixedData[1] / 4096` |
| Region codes | 1=NA, 2=EU, 3=Asia, 98=PTR |

## Known Limitations

1. **No health/mana over time**: no periodic HP or mana snapshots exist in replay data.
2. **No ability cooldown tracking**: only activation (SCmdEvent) is recorded, not cooldown state.
3. **Ability IDs are build-dependent**: `m_abilLink` values change between game builds. No stable mapping exists.
4. **No talent quest or mastery progress**: replay files do not record quest stack counts, quest completion status, or mastery talent completion. No tracker event, score result, attribute, or game event carries this data. This matches the in-game behavior where talent quest progress is not shown in the end-of-game stats screen either. Which talents are quest or mastery types can be identified from the `TalentChosen` internal names ("Quest" or "Mastery" in the `PurchaseName`), but whether they were completed during the match cannot be determined.
4. **Position sampling is coarse**: SUnitPositionsEvent fires every ~15 seconds and only for units that dealt or took damage recently.
5. **Observer ID misalignment**: observers in `m_playerList` can shift player indices. Must cross-reference via ToonHandle.
6. **heroprotocol --json output**: one JSON object per line, not a valid JSON array. Requires line-by-line parsing.
7. **SPlayerStatsEvent**: mostly SC2 engine legacy fields. Food values (divide by 4096) are the only HotS-relevant data.
8. **Revived units**: not tracked by SUnitPositionsEvent after revival in some edge cases.
9. **Draft event cross-referencing**: SHeroPickedEvent uses Working Set Slot ID, not tracker player ID.
10. **Localized strings**: hero and map names in `details` are localized to the recording client. Use tracker event internal IDs for language-independent names.
11. **Battlelobby file**: a separate file (`replay.server.battlelobby`) is created during loading screen but deleted when the client closes. Only HeroesToolChest parsers support it.

## Parsing Tools

### Official

| Tool | Language | URL |
|---|---|---|
| heroprotocol | Python | https://github.com/Blizzard/heroprotocol |
| s2protocol | Python | https://github.com/Blizzard/s2protocol |

### Community

| Tool | Language | Notes |
|---|---|---|
| Heroes.StormReplayParser | C# (.NET) | https://github.com/HeroesToolChest/Heroes.StormReplayParser |
| HeroesDecode | C# (.NET CLI) | https://github.com/HeroesToolChest/HeroesDecode |
| Heroes.ReplayParser | C# | https://github.com/barrett777/Heroes.ReplayParser (used by HotsLogs) |
| heroprotocol (nydus) | JavaScript | https://github.com/nydus/heroprotocol |
| heroprotocoljs (Farof) | JavaScript | https://github.com/Farof/heroprotocoljs |
| hots-parser | Node.js | https://github.com/ebshimizu/hots-parser (used by Stats of the Storm) |
| SwiftHeroProtocol | Swift | https://github.com/nyxhub/SwiftHeroProtocol |
| hotsdata/hots-parser | Python | https://github.com/hotsdata/hots-parser |

### Analysis and Visualization

| Tool | Notes |
|---|---|
| Stats of the Storm | Desktop app, best replay data visualization reference |
| Heroes Profile | https://www.heroesprofile.com |
| HotsLogs | https://www.hotslogs.com |
| HeroesMatchTracker | Desktop stat tracker (HeroesToolChest) |
