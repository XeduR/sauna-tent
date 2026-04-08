// Hero page: overall stats, per-player breakdown, talent builds, tier pick rates
// Supports filtering by mode, party size, date range, map, and min games.
var HeroView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "", map: "", minGames: "10", seasons: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "", map: "", minGames: "10", seasons: "" };
	var heroData = null;
	var matchIndex = null;
	var heroName = null;
	var aramMaps = [];
	var buildsTable = null;
	var allyTable = null;
	var heroChart = null;
	var currentMask = null;
	var currentWrl = null;
	var talentData = null;

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["hero-players"].defaultMask;
	}

	function getWrl() {
		if (currentWrl != null) return currentWrl;
		return StandardTable.readWrlFromURL();
	}

	function hasDataFilters() {
		// Baseline hero data excludes alt games, so disabling the global
		// No alts filter forces a client-side recompute from the match index.
		return filters.mode || filters.partySize || filters.dateFrom || filters.dateTo || filters.map
			|| !GlobalFilters.getNoAlts();
	}

	function getAvailableMaps() {
		// Apply all active filters except map itself to determine valid maps
		var maplessFilters = {};
		for (var key in filters) maplessFilters[key] = filters[key];
		maplessFilters.map = "";
		var subset = MatchIndexUtils.filter(matchIndex, maplessFilters);

		var mapSet = {};
		for (var i = 0; i < subset.length; i++) {
			var m = subset[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				if (m.rosterPlayers[j].hero === heroName) {
					mapSet[m.map] = true;
					break;
				}
			}
		}
		return Object.keys(mapSet).sort();
	}

	// Compute stats from match index when data filters are active
	function computeFiltered() {
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var initAccum = function() {
			return { games: 0, wins: 0, losses: 0, totalDuration: 0,
				totalKills: 0, totalDeaths: 0, totalAssists: 0, totalHeroDamage: 0, totalSiegeDamage: 0,
				totalHealing: 0, totalSelfHealing: 0, totalDamageTaken: 0,
				totalXpContribution: 0, totalMercCaptures: 0, totalTimeSpentDead: 0,
				durationMin: null, durationMax: null, lastPlayed: null, byPartySize: {} };
		};

		var overall = initAccum();
		var playerStats = {};

		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (rp.hero !== heroName) continue;

				var accums = [overall];
				if (!playerStats[rp.name]) playerStats[rp.name] = initAccum();
				accums.push(playerStats[rp.name]);

				for (var a = 0; a < accums.length; a++) {
					var s = accums[a];
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

		finalize(overall);
		for (var name in playerStats) {
			finalize(playerStats[name]);
		}

		return { overall: overall, playerStats: playerStats };
	}

	// Recompute build and tier pick stats from match index when filters are active
	function computeFilteredBuilds(filtered, hero) {
		var builds = {};
		var tierPicks = [];
		for (var t = 0; t < 7; t++) tierPicks.push({});

		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (rp.hero !== hero) continue;
				var tc = rp.talentChoices;
				if (!tc || tc.length === 0) continue;

				var choices = [];
				var hasAny = false;
				for (var t = 0; t < 7; t++) {
					var v = (t < tc.length && tc[t]) ? tc[t] : 0;
					choices.push(v);
					if (v > 0) hasAny = true;
				}
				if (!hasAny) continue;

				var isWin = rp.result === "win";

				var key = choices.join(",");
				if (!builds[key]) builds[key] = { games: 0, wins: 0 };
				builds[key].games++;
				if (isWin) builds[key].wins++;

				for (var t = 0; t < 7; t++) {
					if (choices[t] > 0) {
						var c = choices[t];
						if (!tierPicks[t][c]) tierPicks[t][c] = { games: 0, wins: 0 };
						tierPicks[t][c].games++;
						if (isWin) tierPicks[t][c].wins++;
					}
				}
			}
		}

		var buildList = [];
		for (var key in builds) {
			var b = builds[key];
			var talents = key.split(",").map(Number);
			buildList.push({
				talents: talents,
				games: b.games,
				wins: b.wins,
				losses: b.games - b.wins,
				winrate: b.games > 0 ? Math.round(b.wins / b.games * 10000) / 10000 : 0,
			});
		}
		buildList.sort(function(a, b) { return b.games - a.games; });

		var tierPicksOut = [];
		for (var t = 0; t < 7; t++) {
			var tierTotal = 0;
			for (var c in tierPicks[t]) tierTotal += tierPicks[t][c].games;
			var tierList = [];
			for (var c in tierPicks[t]) {
				var tp = tierPicks[t][c];
				tierList.push({
					choice: Number(c),
					games: tp.games,
					wins: tp.wins,
					losses: tp.games - tp.wins,
					winrate: tp.games > 0 ? Math.round(tp.wins / tp.games * 10000) / 10000 : 0,
					pickrate: tierTotal > 0 ? tp.games / tierTotal : 0,
				});
			}
			tierList.sort(function(a, b) { return a.choice - b.choice; });
			tierPicksOut.push(tierList);
		}

		return { builds: buildList, tierPicks: tierPicksOut };
	}

	function buildPlayerRows(data, minGames, partyData) {
		var rows = [];
		var totalGames = 0;
		for (var name in data) {
			if (data[name].games >= minGames) totalGames += data[name].games;
		}
		for (var name in data) {
			var p = data[name];
			if (p.games < minGames) continue;
			var avg = p.averages || null;
			rows.push({
				player: name,
				pickRate: totalGames > 0 ? p.games / totalGames : 0,
				games: p.games,
				wins: p.wins,
				losses: p.losses,
				winrate: p.winrate,
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
				durationMin: p.durationMin || null,
				durationMax: p.durationMax || null,
				durationAvg: p.averageDurationSeconds || p.avgDuration || null,
				lastPlayed: p.lastPlayed || null
			});
			StandardTable.addPartyWinrates(rows[rows.length - 1], partyData ? partyData[name] : (p.byPartySize || null));
		}
		return rows;
	}

	function renderBuilds(builds) {
		if (!builds.builds || builds.builds.length === 0) {
			return '<h2 class="section-title">Popular Builds</h2>' +
				'<p class="text-muted">No build data available.</p>';
		}

		var rows = [];
		var limit = Math.min(builds.builds.length, AppSettings.hero.topBuildsCount);
		var sorted = builds.builds.slice().sort(function(a, b) { return b.games - a.games; });
		for (var i = 0; i < limit; i++) {
			var b = sorted[i];
			var talentValues = [];
			for (var t = 0; t < 7; t++) {
				var val = (t < b.talents.length) ? b.talents[t] : 0;
				talentValues.push(val);
			}
			rows.push({
				t1: talentValues[0], t4: talentValues[1], t7: talentValues[2],
				t10: talentValues[3], t13: talentValues[4], t16: talentValues[5], t20: talentValues[6],
				games: b.games, wins: b.wins, losses: b.losses, winrate: b.winrate,
			});
		}

		function fmtTalent(tierIdx) {
			return function(v) {
				return talentIconHtml(heroName, tierIdx, v, talentData);
			};
		}

		var columns = [
			{ key: "t1", label: "T1", className: "talent-cell", noSort: true, format: fmtTalent(0) },
			{ key: "t4", label: "T4", className: "talent-cell", noSort: true, format: fmtTalent(1) },
			{ key: "t7", label: "T7", className: "talent-cell", noSort: true, format: fmtTalent(2) },
			{ key: "t10", label: "T10", className: "talent-cell", noSort: true, format: fmtTalent(3) },
			{ key: "t13", label: "T13", className: "talent-cell", noSort: true, format: fmtTalent(4) },
			{ key: "t16", label: "T16", className: "talent-cell", noSort: true, format: fmtTalent(5) },
			{ key: "t20", label: "T20", className: "talent-cell", noSort: true, format: fmtTalent(6) },
			{ key: "copy", label: "", className: "talent-copy-cell", noSort: true, format: function(v, row) {
				var talents = [row.t1, row.t4, row.t7, row.t10, row.t13, row.t16, row.t20];
				return talentCopyBtnHtml(talents, heroName);
			}},
			{ key: "games", label: "Games", className: "num", format: StandardTable.FORMAT.num },
			{ key: "wins", label: "Wins", className: "num", format: StandardTable.FORMAT.num },
			{ key: "losses", label: "Losses", className: "num", format: StandardTable.FORMAT.num },
			{ key: "winrate", label: "Win Rate", className: "num", format: StandardTable.FORMAT.wr },
		];

		var headerGroups = [
			{ label: "Talents", span: 8 },
			{ label: "Games", span: 3 },
			{ label: "Win Rate", span: 1 }
		];
		buildsTable = sortableTable("builds-table", columns, rows, "games", true, headerGroups);
		return '<h2 class="section-title">Popular Builds</h2>' + buildsTable.buildHTML();
	}

	function renderTierPicks(tierPicks) {
		var tierLabels = ["1", "4", "7", "10", "13", "16", "20"];
		var html = '<h2 class="section-title">Talent Pick Rates</h2>';

		if (!tierPicks || tierPicks.length === 0) {
			html += '<p class="text-muted">No tier pick data available.</p>';
			return html;
		}

		html += '<div class="tier-picks-grid">';
		for (var t = 0; t < tierPicks.length; t++) {
			var tier = tierPicks[t];
			var tierLabel = t < tierLabels.length ? tierLabels[t] : String((t + 1));

			html += '<div class="tier-pick-card card">' +
				'<div class="tier-pick-header">Level ' + tierLabel + '</div>' +
				'<div class="tier-pick-choices">';

			var sorted = tier.slice().sort(function(a, b) { return b.pickrate - a.pickrate; });
			for (var c = 0; c < sorted.length; c++) {
				var pick = sorted[c];
				var barWidth = Math.round(pick.pickrate * 100);
				html += '<div class="tier-pick-row">' +
					'<div class="tier-pick-label">' + talentIconHtml(heroName, t, pick.choice, talentData) + '</div>' +
					'<div class="tier-pick-bar-track">' +
					'<div class="tier-pick-bar-fill" style="--bar-width:' + barWidth + '%"></div>' +
					'</div>' +
					'<div class="tier-pick-stats">' +
					'<span class="tier-pick-rate">' + (pick.pickrate * 100).toFixed(1) + '%</span>' +
					winrateSpan(pick.winrate) +
					'<span class="tier-pick-games">' + pick.games + ' games</span>' +
					'</div>' +
					'</div>';
			}
			html += '</div></div>';
		}
		html += '</div>';
		return html;
	}

	// Count this hero's picks per month from filtered matches
	function computePopularity(filtered) {
		var months = {};
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				if (m.rosterPlayers[j].hero === heroName) {
					var month = m.timestamp.substring(0, 7);
					months[month] = (months[month] || 0) + 1;
					break;
				}
			}
		}
		var sortedMonths = Object.keys(months).sort();
		var counts = [];
		for (var i = 0; i < sortedMonths.length; i++) {
			counts.push(months[sortedMonths[i]]);
		}
		return { labels: sortedMonths, data: counts };
	}

	// Win rates when paired with other heroes on the same team
	function computeAllyWinRates(filtered) {
		var allies = {};
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			// Find the roster player(s) on this hero and their result
			var heroResult = null;
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				if (m.rosterPlayers[j].hero === heroName) {
					heroResult = m.rosterPlayers[j].result;
					break;
				}
			}
			if (heroResult === null) continue;

			// Record other roster players on the same team (same result)
			var isWin = heroResult === "win";
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (rp.hero === heroName) continue;
				if (rp.result !== heroResult) continue;
				if (!allies[rp.hero]) allies[rp.hero] = { games: 0, wins: 0 };
				allies[rp.hero].games++;
				if (isWin) allies[rp.hero].wins++;
			}
		}

		var rows = [];
		for (var hero in allies) {
			var a = allies[hero];
			rows.push({
				hero: hero,
				games: a.games,
				wins: a.wins,
				losses: a.games - a.wins,
				winrate: a.games > 0 ? a.wins / a.games : 0
			});
		}
		rows.sort(function(a, b) { return b.games - a.games; });
		return rows;
	}

	function renderContent() {
		var app = document.getElementById("app");
		var minGames = filters.minGames !== "" ? Number(filters.minGames) : 0;
		var useFiltered = hasDataFilters();
		var mask = getMask();

		var wrl = getWrl();
		var partyContext = wrl === "full" ? { showAll: true, filterPartySize: filters.partySize || null } : null;

		var players;
		var partyData = null;
		if (useFiltered) {
			players = computeFiltered().playerStats;
		} else {
			players = heroData.players;
			// Pre-computed data lacks byPartySize per player; compute from match index
			partyData = MatchIndexUtils.computePartyBreakdowns(matchIndex, function(m, rp) {
				return rp.hero === heroName ? rp.name : null;
			});
		}

		var o = aggregateGroup(players, minGames);
		var rows = buildPlayerRows(players, minGames, partyData);
		var playerTable = StandardTable.create("hero-players", rows, { mask: mask, partyContext: partyContext, wrl: wrl });

		var html =
			'<div class="page-header"><h1>' + heroIconHtml(heroData.name, "lg") + escapeHtml(heroData.name) + '</h1>' +
			'<div class="subtitle">' + o.games.toLocaleString() + ' out of ' +
			heroData.overall.games.toLocaleString() + ' games</div></div>';

		html += buildPageFilterBar(filters, {
			mode: true, partySize: true, dateFrom: true, dateTo: true,
			mapOptions: getAvailableMaps(), minGames: true
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

		html += '<h2 class="section-title">Players</h2>';
		html += playerTable.buildToggles();
		html += playerTable.buildHTML();
		if (o.games > 0) {
			var buildsData;
			if (useFiltered) {
				buildsData = computeFilteredBuilds(
					MatchIndexUtils.filter(matchIndex, filters), heroName
				);
			} else {
				buildsData = heroData.builds;
			}
			html += renderBuilds(buildsData);
			html += renderTierPicks(buildsData.tierPicks);
		} else {
			buildsTable = null;
		}

		// Popularity over time and ally win rates use the full filtered set
		var heroFiltered = MatchIndexUtils.filter(matchIndex, filters);
		var popData = computePopularity(heroFiltered);

		if (heroChart) { heroChart.destroy(); heroChart = null; }
		if (popData.labels.length >= 2) {
			html += '<h2 class="section-title">Popularity Over Time</h2>' +
				'<div class="chart-container"><canvas id="hero-pick-chart"></canvas></div>';
		}

		var allyRows = computeAllyWinRates(heroFiltered);
		if (minGames > 0) {
			var filtered = [];
			for (var i = 0; i < allyRows.length; i++) {
				if (allyRows[i].games >= minGames) filtered.push(allyRows[i]);
			}
			allyRows = filtered;
		}
		if (allyRows.length > 0) {
			var allyColumns = [
				{ key: "hero", label: "Hero", format: function(v) {
					return '<a href="' + appLink('/hero/' + slugify(v)) + '">' + heroIconHtml(v) + escapeHtml(v) + '</a>';
				}},
				{ key: "games", label: "Games", className: "num", format: StandardTable.FORMAT.num },
				{ key: "wins", label: "Wins", className: "num", format: StandardTable.FORMAT.num },
				{ key: "losses", label: "Losses", className: "num", format: StandardTable.FORMAT.num },
				{ key: "winrate", label: "Win Rate", className: "num", format: StandardTable.FORMAT.wr }
			];
			allyTable = sortableTable("ally-winrate-table", allyColumns, allyRows, "games", true);
			html += '<h2 class="section-title">Ally Win Rates</h2>' +
				'<div class="text-muted chart-desc">Showing ' + allyRows.length + ' out of 90 heroes.</div>' +
				allyTable.buildHTML();
		} else {
			allyTable = null;
		}

		app.innerHTML = html;

		if (popData.labels.length >= 2) {
			heroChart = ChartUtils.createHeroPickChart("hero-pick-chart", popData.labels, popData.data);
		}
		var onWrlChange = function(newWrl, newMask) {
			currentWrl = newWrl;
			StandardTable.writeWrlToURL(newWrl);
			if (newMask != null) {
				currentMask = newMask;
				StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["hero-players"].defaultMask);
			}
			renderContent();
		};
		playerTable.attachListeners(app, function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["hero-players"].defaultMask);
			renderContent();
		}, onWrlChange);
		if (buildsTable) buildsTable.attachListeners(app);
		if (allyTable) allyTable.attachListeners(app);
		attachPageFilterListeners(app, filters, defaults, function() {
			if (filters.map) {
				var validMaps = getAvailableMaps();
				if (validMaps.indexOf(filters.map) === -1) filters.map = "";
			}
			renderContent();
		});
	}

	async function render(slug) {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading hero...</div>';
		currentMask = null;

		var keys = Object.keys(defaults);
		for (var i = 0; i < keys.length; i++) {
			filters[keys[i]] = defaults[keys[i]];
		}

		try {
			var results = await Promise.all([Data.hero(slug), Data.matchIndex(), Data.summary(), Data.settings(), Data.talentNames(), Data.talentDescriptions()]);
			heroData = results[0];
			matchIndex = results[1];
			heroName = heroData.name;
			aramMaps = results[2].aramMaps || [];
			talentData = { names: results[4], descriptions: results[5] };
			defaults.minGames = String(AppSettings.minGamesDefault);
			filters.minGames = defaults.minGames;
			readFiltersFromURL(filters, defaults);
			var fromURL = StandardTable.readMaskFromURL();
			if (fromURL != null) currentMask = fromURL;
			currentWrl = StandardTable.readWrlFromURL();
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Hero not found.</div>';
		}
	}

	return { render: render };
})();
