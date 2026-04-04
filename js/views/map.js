// Map page: overall stats, per-player breakdown, per-hero breakdown
// Supports filtering by mode, party size, date range, and min games.
var MapView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", seasons: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", seasons: "" };
	var mapData = null;
	var matchIndex = null;
	var mapName = null;
	var currentMask = null;
	var currentWrl = null;

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["map-players"].defaultMask;
	}

	function getWrl() {
		if (currentWrl != null) return currentWrl;
		return StandardTable.readWrlFromURL();
	}

	function hasDataFilters() {
		return filters.mode || filters.partySize || filters.dateFrom || filters.dateTo;
	}

	// Compute stats from match index when data filters are active
	function computeFiltered() {
		var filtered = MatchIndexUtils.filter(matchIndex, filters);

		var mapMatches = [];
		for (var i = 0; i < filtered.length; i++) {
			if (filtered[i].map === mapName) mapMatches.push(filtered[i]);
		}

		var initAccum = function() {
			return { games: 0, wins: 0, losses: 0, totalDuration: 0,
				totalKills: 0, totalDeaths: 0, totalAssists: 0, totalHeroDamage: 0, totalSiegeDamage: 0,
				totalHealing: 0, totalSelfHealing: 0, totalDamageTaken: 0,
				totalXpContribution: 0, totalMercCaptures: 0, totalTimeSpentDead: 0,
				durationMin: null, durationMax: null, lastPlayed: null, byPartySize: {} };
		};

		var playerStats = {};
		var heroStats = {};

		for (var i = 0; i < mapMatches.length; i++) {
			var m = mapMatches[i];

			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];

				var targets = [];
				if (!playerStats[rp.name]) playerStats[rp.name] = initAccum();
				targets.push(playerStats[rp.name]);
				if (!heroStats[rp.hero]) heroStats[rp.hero] = initAccum();
				targets.push(heroStats[rp.hero]);

				for (var t = 0; t < targets.length; t++) {
					var s = targets[t];
					s.games++;
					if (rp.result === "win") s.wins++;
					else s.losses++;
					s.totalDuration += m.durationSeconds;
					s.totalKills += rp.kills || 0;
					s.totalDeaths += rp.deaths || 0;
					s.totalAssists += rp.assists || 0;
					s.totalHeroDamage += rp.heroDamage || 0;
					s.totalSiegeDamage += rp.siegeDamage || 0;
					s.totalHealing += rp.healing || 0;
					s.totalSelfHealing += rp.selfHealing || 0;
					s.totalDamageTaken += rp.damageTaken || 0;
					s.totalXpContribution += rp.xpContribution || 0;
					s.totalMercCaptures += rp.mercCaptures || 0;
					s.totalTimeSpentDead += rp.timeSpentDead || 0;
					if (s.durationMin === null || m.durationSeconds < s.durationMin) s.durationMin = m.durationSeconds;
					if (s.durationMax === null || m.durationSeconds > s.durationMax) s.durationMax = m.durationSeconds;
					if (s.lastPlayed === null || m.timestamp > s.lastPlayed) s.lastPlayed = m.timestamp;
					var ps = String(rp.partySize || 1);
					if (!s.byPartySize[ps]) s.byPartySize[ps] = { games: 0, wins: 0 };
					s.byPartySize[ps].games++;
					if (rp.result === "win") s.byPartySize[ps].wins++;
				}
			}
		}

		var finalize = function(s) {
			s.winrate = s.games > 0 ? s.wins / s.games : 0;
			s.avgDuration = s.games > 0 ? s.totalDuration / s.games : 0;
			if (s.games > 0) {
				s.averageDurationSeconds = s.totalDuration / s.games;
				var deaths = Math.max(s.totalDeaths, 1);
				s.averages = {
					kills: Math.round(s.totalKills / s.games * 10) / 10,
					deaths: Math.round(s.totalDeaths / s.games * 10) / 10,
					assists: Math.round(s.totalAssists / s.games * 10) / 10,
					kda: Math.round((s.totalKills + s.totalAssists) / deaths * 100) / 100,
					heroDamage: Math.round(s.totalHeroDamage / s.games),
					siegeDamage: Math.round(s.totalSiegeDamage / s.games),
					healing: Math.round(s.totalHealing / s.games),
					selfHealing: Math.round(s.totalSelfHealing / s.games),
					damageTaken: Math.round(s.totalDamageTaken / s.games),
					xpContribution: Math.round(s.totalXpContribution / s.games),
					mercCaptures: Math.round(s.totalMercCaptures / s.games * 10) / 10,
					timeSpentDead: Math.round(s.totalTimeSpentDead / s.games * 10) / 10,
				};
			}
			for (var ps in s.byPartySize) {
				var pd = s.byPartySize[ps];
				pd.winrate = pd.games > 0 ? pd.wins / pd.games : 0;
			}
		};

		for (var name in playerStats) {
			finalize(playerStats[name]);
		}
		for (var hero in heroStats) {
			finalize(heroStats[hero]);
		}

		return { playerStats: playerStats, heroStats: heroStats };
	}

	function buildEntityRows(data, minGames, partyData) {
		var rows = [];
		var totalGames = 0;
		for (var name in data) {
			if (data[name].games >= minGames) totalGames += data[name].games;
		}
		for (var name in data) {
			var e = data[name];
			if (e.games < minGames) continue;
			var avg = e.averages || null;
			rows.push({
				_name: name,
				pickRate: totalGames > 0 ? e.games / totalGames : 0,
				games: e.games,
				wins: e.wins,
				losses: e.losses,
				winrate: e.winrate,
				kills: avg ? avg.kills : null,
				deaths: avg ? avg.deaths : null,
				assists: avg ? avg.assists : null,
				kda: avg ? avg.kda : null,
				heroDamage: avg ? avg.heroDamage : null,
				siegeDamage: avg ? avg.siegeDamage : null,
				healing: avg ? avg.healing : null,
				selfHealing: avg ? avg.selfHealing : null,
				damageTaken: avg ? avg.damageTaken : null,
				xpContribution: avg ? avg.xpContribution : null,
				mercCaptures: avg ? avg.mercCaptures : null,
				timeSpentDead: avg ? avg.timeSpentDead : null,
				durationMin: e.durationMin || null,
				durationMax: e.durationMax || null,
				durationAvg: e.averageDurationSeconds || e.avgDuration || null,
				lastPlayed: e.lastPlayed || null
			});
			StandardTable.addPartyWinrates(rows[rows.length - 1], partyData ? partyData[name] : (e.byPartySize || null));
		}
		return rows;
	}

	function buildPlayerRows(data, minGames, partyData) {
		var base = buildEntityRows(data, minGames, partyData);
		for (var i = 0; i < base.length; i++) {
			base[i].player = base[i]._name;
			delete base[i]._name;
		}
		return base;
	}

	function buildHeroRows(data, minGames, partyData) {
		var base = buildEntityRows(data, minGames, partyData);
		for (var i = 0; i < base.length; i++) {
			base[i].hero = base[i]._name;
			delete base[i]._name;
		}
		return base;
	}

	function renderContent() {
		var app = document.getElementById("app");
		var minGames = filters.minGames !== "" ? Number(filters.minGames) : 0;
		var useFiltered = hasDataFilters();
		var mask = getMask();

		var wrl = getWrl();
		var partyContext = wrl === "full" ? { showAll: true, filterPartySize: filters.partySize || null } : null;

		var players, heroesData;
		var playerPartyData = null;
		var heroPartyData = null;
		if (useFiltered) {
			var computed = computeFiltered();
			players = computed.playerStats;
			heroesData = computed.heroStats;
		} else {
			players = mapData.players;
			heroesData = mapData.heroes;
			// Pre-computed data lacks byPartySize; compute from match index
			playerPartyData = MatchIndexUtils.computePartyBreakdowns(matchIndex, function(m, rp) {
				return m.map === mapName ? rp.name : null;
			});
			heroPartyData = MatchIndexUtils.computePartyBreakdowns(matchIndex, function(m, rp) {
				return m.map === mapName ? rp.hero : null;
			});
		}

		var o = aggregateGroup(players, minGames);
		var playerRows = buildPlayerRows(players, minGames, playerPartyData);
		var heroRows = buildHeroRows(heroesData, minGames, heroPartyData);

		var playerTable = StandardTable.create("map-players", playerRows, { mask: mask, partyContext: partyContext, wrl: wrl });
		var heroTable = StandardTable.create("map-heroes", heroRows, { mask: mask, partyContext: partyContext, wrl: wrl });

		var html =
			'<div class="page-header"><h1>' + escapeHtml(displayMapName(mapName)) + '</h1>' +
			'<div class="subtitle">' + o.games.toLocaleString() + ' out of ' +
			mapData.overall.games.toLocaleString() + ' games</div></div>';

		var isAram = !!ARAM_MAPS[mapName];
		var modeOptions = isAram
			? [{ value: "ARAM", label: "ARAM" }, { value: "Custom", label: "Custom" }]
			: [{ value: "StormLeague", label: "Storm League" }, { value: "Custom", label: "Custom" }];

		html += buildPageFilterBar(filters, {
			mode: true, modeOptions: modeOptions, partySize: true, dateFrom: true, dateTo: true, minGames: true
		});

		html += '<h2 class="section-title">Summary</h2>';
		html += '<div class="stat-row">' +
			statBox("Win Rate", winrateSpan(o.winrate)) +
			statBox("Wins", o.wins.toLocaleString()) +
			statBox("Losses", o.losses.toLocaleString());

		if (o.averages) {
			html += statBox("KDA", o.averages.kda.toFixed(2)) +
				statBox("Avg Kills", o.averages.kills.toFixed(1)) +
				statBox("Avg Deaths", o.averages.deaths.toFixed(1)) +
				statBox("Avg Assists", o.averages.assists.toFixed(1));
		} else {
			html += statBox("KDA", "-") +
				statBox("Avg Kills", "-") +
				statBox("Avg Deaths", "-") +
				statBox("Avg Assists", "-");
		}
		html += statBox("Avg Duration", formatDuration(o.averageDurationSeconds || o.avgDuration || 0));
		html += '</div>';

		// Match factors and level lead for this map
		var mapMatches = [];
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		for (var mi = 0; mi < filtered.length; mi++) {
			if (filtered[mi].map === mapName) mapMatches.push(filtered[mi]);
		}
		var metaStats = MatchIndexUtils.computeMetaStats(mapMatches);
		var factorRows = [];
		var side = metaStats.teamSide;
		var fb = metaStats.firstBlood;
		var boss = metaStats.firstBoss;
		var merc = metaStats.firstMerc;
		if (side.left.games > 0 || side.right.games > 0) {
			factorRows.push(["Spawned Left Side", side.left]);
			factorRows.push(["Spawned Right Side", side.right]);
		}
		if (fb.got.games > 0 || fb.gave.games > 0) {
			factorRows.push(["Got First Blood", fb.got]);
			factorRows.push(["Gave First Blood", fb.gave]);
		}
		if (boss.got.games > 0 || boss.gave.games > 0) {
			factorRows.push(["Got First Boss", boss.got]);
			factorRows.push(["Gave First Boss", boss.gave]);
		}
		if (merc.got.games > 0 || merc.gave.games > 0) {
			factorRows.push(["Got First Merc", merc.got]);
			factorRows.push(["Gave First Merc", merc.gave]);
		}
		var lp = metaStats.loungePick;
		if (lp.mapPick.games > 0) {
			factorRows.push(["Lounge: map pick", lp.mapPick]);
		}
		if (lp.firstPick.games > 0) {
			factorRows.push(["Lounge: first pick", lp.firstPick]);
		}
		if (factorRows.length > 0) {
			html += renderMetaFactorTable("Match Factors", factorRows);
		}
		html += renderLevelLeadTable(metaStats.levelLead);

		html += '<h2 class="section-title">Players</h2>';
		html += playerTable.buildToggles();
		html += playerTable.buildHTML();

		html += '<h2 class="section-title">Heroes</h2>';
		html += heroTable.buildToggles();
		html += heroTable.buildHTML();

		app.innerHTML = html;

		var onMaskChange = function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["map-players"].defaultMask);
			renderContent();
		};
		var onWrlChange = function(newWrl, newMask) {
			currentWrl = newWrl;
			StandardTable.writeWrlToURL(newWrl);
			if (newMask != null) {
				currentMask = newMask;
				StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["map-players"].defaultMask);
			}
			renderContent();
		};
		playerTable.attachListeners(app, onMaskChange, onWrlChange);
		heroTable.attachListeners(app, onMaskChange, onWrlChange);
		attachAllSortableListeners(app);
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(); });
	}

	async function render(slug) {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading map...</div>';
		currentMask = null;

		var keys = Object.keys(defaults);
		for (var i = 0; i < keys.length; i++) {
			filters[keys[i]] = defaults[keys[i]];
		}

		try {
			var results = await Promise.all([Data.map(slug), Data.matchIndex(), Data.settings()]);
			mapData = results[0];
			matchIndex = results[1];
			mapName = mapData.name;
			defaults.minGames = String(AppSettings.minGamesDefault);
			filters.minGames = defaults.minGames;
			readFiltersFromURL(filters, defaults);
			var fromURL = StandardTable.readMaskFromURL();
			if (fromURL != null) currentMask = fromURL;
			currentWrl = StandardTable.readWrlFromURL();
			if (filters.mode) {
				var isAram = !!ARAM_MAPS[mapName];
				if (isAram && filters.mode === "StormLeague") filters.mode = "";
				if (!isAram && filters.mode === "ARAM") filters.mode = "";
			}
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Map not found.</div>';
		}
	}

	return { render: render };
})();
