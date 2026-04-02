// Segment catalog, layout definitions, and map type lookup for standard tables.
// All segment and column definitions are declarative; format functions are
// referenced by string key and resolved by the builder at render time.

var TableConfig = (function() {
	// Two-lane maps (everything else that isn't ARAM is 3-lane)
	var TWO_LANE_MAPS = {
		"Battlefield of Eternity": true,
		"Braxis Holdout": true,
		"Hanamura Temple": true
	};

	function mapType(name) {
		if (ARAM_MAPS[name]) return "ARAM";
		if (TWO_LANE_MAPS[name]) return "2-lane";
		return "3-lane";
	}

	// Map type sort value: 3-lane=3, 2-lane=2, ARAM=1
	function mapTypeSortValue(name) {
		if (ARAM_MAPS[name]) return 1;
		if (TWO_LANE_MAPS[name]) return 2;
		return 3;
	}

	// Column spec: { key, label, format, className }
	// format is a string key resolved by the builder's format registry.

	var SEGMENTS = [
		{
			id: "games",
			bit: 0,
			label: "GAMES",
			columns: [
				{ key: "pickRate", label: "Pick %", format: "pct", className: "num" },
				{ key: "games", label: "Total", format: "num", className: "num" },
				{ key: "wins", label: "Win", format: "num", className: "num" },
				{ key: "losses", label: "Loss", format: "num", className: "num" }
			]
		},
		{
			id: "winrate",
			bit: 1,
			label: "WIN RATE",
			// Columns are dynamic: base "Avg" always present, party sub-columns conditional.
			// The builder handles this via the partyContext option.
			columns: [
				{ key: "winrate", label: "Avg", format: "wr", className: "num" }
			],
			partyColumns: [
				{ key: "wrSolo", label: "Solo", format: "partyWr", className: "num" },
				{ key: "wrDuo", label: "Duo", format: "partyWr", className: "num" },
				{ key: "wr3s", label: "3S", format: "partyWr", className: "num" },
				{ key: "wr4s", label: "4S", format: "partyWr", className: "num" },
				{ key: "wr5s", label: "5S", format: "partyWr", className: "num" }
			]
		},
		{
			id: "kda",
			bit: 2,
			label: "KDA (AVG)",
			columns: [
				{ key: "kills", label: "Kill", format: "dec", className: "num" },
				{ key: "deaths", label: "Death", format: "dec", className: "num" },
				{ key: "assists", label: "Assist", format: "dec", className: "num" },
				{ key: "kda", label: "KDA", format: "kda", className: "num" }
			]
		},
		{
			id: "damage",
			bit: 3,
			label: "DAMAGE (AVG)",
			columns: [
				{ key: "heroDamage", label: "Hero Dmg", format: "dmg", className: "num" },
				{ key: "siegeDamage", label: "Siege Dmg", format: "dmg", className: "num" }
			]
		},
		{
			id: "sustain",
			bit: 4,
			label: "SUSTAIN (AVG)",
			columns: [
				{ key: "healing", label: "Healing", format: "dmg", className: "num" },
				{ key: "selfHealing", label: "Self Heal", format: "dmg", className: "num" },
				{ key: "damageTaken", label: "Dmg Taken", format: "dmg", className: "num" }
			]
		},
		{
			id: "macro",
			bit: 5,
			label: "MACRO (AVG)",
			columns: [
				{ key: "xpContribution", label: "XP", format: "dmg", className: "num" },
				{ key: "mercCaptures", label: "Mercs", format: "dec", className: "num" },
				{ key: "timeSpentDead", label: "Dead", format: "dur", className: "num" }
			]
		},
		{
			id: "duration",
			bit: 6,
			label: "DURATION",
			columns: [
				{ key: "durationMin", label: "Min", format: "dur", className: "num" },
				{ key: "durationMax", label: "Max", format: "dur", className: "num" },
				{ key: "durationAvg", label: "Avg", format: "dur", className: "num" }
			]
		},
		{
			id: "lastPlayed",
			bit: 7,
			label: "LAST PLAYED",
			columns: [
				{ key: "lastPlayed", label: "Date", format: "date", className: "num" }
			]
		}
	];

	// Index segments by id for fast lookup
	var SEGMENT_MAP = {};
	for (var i = 0; i < SEGMENTS.length; i++) {
		SEGMENT_MAP[SEGMENTS[i].id] = SEGMENTS[i];
	}

	// Default bitmasks
	var MASK_MAIN = 1 | 2 | 64;     // GAMES + WIN RATE + DURATION = 67
	var MASK_DETAIL = 1 | 2 | 4 | 8; // GAMES + WIN RATE + KDA + DAMAGE = 15

	// Identity templates
	var IDENTITY = {
		hero: {
			topLabel: "HERO",
			columns: [
				{ key: "hero", label: "Name", format: "heroLink" },
				{ key: "role", label: "Role", format: "roleIcon" }
			]
		},
		heroNameOnly: {
			topLabel: "HERO",
			columns: [
				{ key: "hero", label: "Name", format: "heroLink" }
			]
		},
		map: {
			topLabel: "MAP",
			columns: [
				{ key: "map", label: "Name", format: "mapLink" },
				{ key: "mapType", label: "Type", format: "mapType" }
			]
		},
		player: {
			topLabel: "PLAYER",
			columns: [
				{ key: "player", label: "Name", format: "playerLink" }
			]
		}
	};

	// Per-page layout definitions
	var LAYOUTS = {
		"players-main": {
			identity: "player",
			defaultMask: MASK_MAIN,
			tableId: "players-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"heroes-main": {
			identity: "hero",
			defaultMask: MASK_MAIN,
			tableId: "heroes-main-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"maps-main": {
			identity: "map",
			defaultMask: MASK_MAIN,
			tableId: "maps-main-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"player-heroes": {
			identity: "hero",
			defaultMask: MASK_DETAIL,
			tableId: "hero-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"player-maps": {
			identity: "map",
			defaultMask: MASK_DETAIL,
			tableId: "map-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"hero-players": {
			identity: "player",
			defaultMask: MASK_DETAIL,
			tableId: "player-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"map-players": {
			identity: "player",
			defaultMask: MASK_DETAIL,
			tableId: "player-table",
			defaultSortKey: "games",
			hasPartyData: true
		},
		"map-heroes": {
			identity: "heroNameOnly",
			defaultMask: MASK_DETAIL,
			tableId: "hero-table",
			defaultSortKey: "games",
			hasPartyData: true
		}
	};

	// Chart visual config for heroes-main popularity chart
	var CHART = {
		seriesColors: [
			"rgb(59, 130, 246)", "rgb(239, 68, 68)", "rgb(34, 197, 94)",
			"rgb(249, 115, 22)", "rgb(168, 85, 247)", "rgb(234, 179, 8)",
			"rgb(14, 165, 233)", "rgb(236, 72, 153)", "rgb(99, 102, 241)",
			"rgb(20, 184, 166)"
		],
		textColor: "#D8DAE0",
		gridColor: "#2A2F3A"
	};

	return {
		SEGMENTS: SEGMENTS,
		SEGMENT_MAP: SEGMENT_MAP,
		IDENTITY: IDENTITY,
		LAYOUTS: LAYOUTS,
		MASK_MAIN: MASK_MAIN,
		MASK_DETAIL: MASK_DETAIL,
		TWO_LANE_MAPS: TWO_LANE_MAPS,
		CHART: CHART,
		mapType: mapType,
		mapTypeSortValue: mapTypeSortValue
	};
})();
