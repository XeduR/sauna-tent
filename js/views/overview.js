// Overview page: team stats, player cards, most played heroes, game modes
// Supports filtering by mode, party size, and date range via match index.
var OverviewView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "", seasons: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "", seasons: "" };
	var matchIndex = null;
	var roster = null;
	var summary = null;
	var heroChart = null;
	var hourChart = null;
	var hourGamesChart = null;
	var heroColors = null;

	function renderPlayerCard(p, ps, isAlt) {
		var cls = isAlt ? 'card player-card player-card-alt' : 'card player-card';
		var altBadge = isAlt ? '<span class="nav-alt-tag">alt</span>' : '';
		return '<a href="' + appLink('/player/' + p.slug) + '" class="' + cls + '">' +
			'<div class="player-card-name">' + escapeHtml(p.name) + altBadge + '</div>' +
			'<div class="player-card-stats">' +
			'<span>' + ps.games.toLocaleString() + ' games</span>' +
			winrateSpan(ps.winrate) +
			'</div>' +
			'<div class="player-card-bar">' +
			'<div class="player-card-bar-fill" style="--bar-width:' + (ps.winrate * 100).toFixed(1) + '%"></div>' +
			'</div>' +
			'</a>';
	}

	function renderPlayerCards(playerStats) {
		var html = '<h2 class="section-title">Players</h2><div class="card-grid">';
		for (var i = 0; i < roster.players.length; i++) {
			var p = roster.players[i];
			var ps = playerStats[p.name];
			if (!ps || ps.games === 0) continue;
			html += renderPlayerCard(p, ps, false);
		}
		var showAlts = window.GlobalFilters && !window.GlobalFilters.getNoAlts();
		if (showAlts && roster.alts) {
			for (var ai = 0; ai < roster.alts.length; ai++) {
				var a = roster.alts[ai];
				var as = playerStats[a.name];
				if (!as || as.games === 0) continue;
				html += renderPlayerCard(a, as, true);
			}
		}
		html += '</div>';
		return html;
	}

	function renderMostPlayedHeroes(heroStats) {
		// Sort by games descending, take top N (AppSettings.overview.topHeroesCount)
		var entries = [];
		for (var hero in heroStats) {
			entries.push({ hero: hero, games: heroStats[hero].games });
		}
		entries.sort(function(a, b) { return b.games - a.games; });
		var top = entries.slice(0, AppSettings.overview.topHeroesCount);

		if (top.length === 0) return "";
		var maxGames = top[0].games;
		var html = '<h2 class="section-title">Most Played Heroes</h2><div class="hero-bars">';
		for (var i = 0; i < top.length; i++) {
			var h = top[i];
			var heroSlug = slugify(h.hero);
			var pct = (h.games / maxGames * 100).toFixed(1);
			html += '<a href="' + appLink('/hero/' + heroSlug) + '" class="hero-bar-row">' +
				'<span class="hero-bar-name">' + heroIconHtml(h.hero) + escapeHtml(h.hero) + '</span>' +
				'<span class="hero-bar-track"><span class="hero-bar-fill" style="--bar-width:' + pct + '%"></span></span>' +
				'<span class="hero-bar-count">' + h.games.toLocaleString() + '</span>' +
				'</a>';
		}
		html += '</div>';
		return html;
	}

	function renderGameModes(modeStats) {
		var rows = [];
		for (var mode in modeStats) {
			var m = modeStats[mode];
			rows.push({
				name: displayModeName(mode),
				games: m.games,
				wins: m.wins,
				losses: m.losses,
				winrate: m.winrate,
				avgDuration: m.avgDuration
			});
		}

		var fmtNum = function(v) { return v.toLocaleString(); };
		var columns = [
			{ key: "name", label: "Name" },
			{ key: "games", label: "Total", className: "num", format: fmtNum },
			{ key: "wins", label: "Win", className: "num", format: fmtNum },
			{ key: "losses", label: "Loss", className: "num", format: fmtNum },
			{ key: "winrate", label: "Avg", className: "num", format: function(v) { return winrateSpan(v); } },
			{ key: "avgDuration", label: "Avg", className: "num", format: function(v) { return formatDuration(v); } }
		];
		var headerGroups = [
			{ label: "Mode", span: 1 },
			{ label: "Games", span: 3 },
			{ label: "Win Rate", span: 1 },
			{ label: "Duration", span: 1 }
		];

		var table = sortableTable("game-modes-table", columns, rows, "name", false, headerGroups);
		registerSortableTable(table);
		return '<h2 class="section-title">Game Modes</h2>' + table.buildHTML();
	}

	function renderMetaStats(metaStats) {
		var html = "";
		var factorRows = buildMatchFactorRows(metaStats);
		if (factorRows.length > 0) {
			html += renderMetaFactorTable("Match Factors", factorRows);
		}

		html += renderLevelLeadTable(metaStats.levelLead);
		return html;
	}

	// Find the roster team ID from a match entry's teams object
	function getRosterTeam(teams) {
		for (var t in teams) {
			for (var j = 0; j < teams[t].length; j++) {
				if (teams[t][j].isRoster) return t;
			}
		}
		return null;
	}

	function computeRoleCompositions(filtered) {
		var heroRolesMap = summary.heroRoles || {};
		var roleComps = {};

		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			var teamId = getRosterTeam(m.teams);
			if (teamId === null) continue;

			var team = m.teams[teamId];
			var roles = [];
			for (var j = 0; j < team.length; j++) {
				roles.push(heroRolesMap[team[j].hero] || "Unknown");
			}

			roles.sort();
			var roleKey = roles.join(", ");
			if (!roleComps[roleKey]) roleComps[roleKey] = { games: 0, wins: 0 };
			roleComps[roleKey].games++;
			if (m.result === "win") roleComps[roleKey].wins++;
		}

		var rows = [];
		for (var key in roleComps) {
			var c = roleComps[key];
			if (c.games >= AppSettings.overview.minGamesForComposition) {
				rows.push({
					roles: key,
					games: c.games,
					wins: c.wins,
					losses: c.games - c.wins,
					winrate: c.wins / c.games,
				});
			}
		}
		rows.sort(function(a, b) { return b.winrate - a.winrate || b.games - a.games; });
		return rows.slice(0, AppSettings.overview.topCompositionsCount);
	}

	function streakRowLabel(length, isWin) {
		if (isWin) return "After " + length + (length === 1 ? " win" : " wins");
		return "After " + length + (length === 1 ? " loss" : " losses");
	}

	function renderStreakStats(filtered) {
		var streaks = MatchIndexUtils.computeStreakStats(matchIndex, filtered);
		var lengths = AppSettings.streaks.lengths;
		var rows = [];
		var rowOrder = [];
		for (var wi = 0; wi < lengths.length; wi++) {
			var winLabel = streakRowLabel(lengths[wi], true);
			rowOrder.push(winLabel);
			if (streaks.afterWins[lengths[wi]].games > 0) rows.push([winLabel, streaks.afterWins[lengths[wi]]]);
		}
		for (var li = 0; li < lengths.length; li++) {
			var lossLabel = streakRowLabel(lengths[li], false);
			rowOrder.push(lossLabel);
			if (streaks.afterLosses[lengths[li]].games > 0) rows.push([lossLabel, streaks.afterLosses[lengths[li]]]);
		}
		if (rows.length === 0) return "";

		var config = AppSettings.streaks;
		var description = '<p class="text-muted section-description">' +
			'Win rate of the next game when the previous games in a back-to-back run were all won or all lost. ' +
			'Every game in the run has at least ' + config.minPlayers + ' roster players (alt accounts count when shown). ' +
			'Each game starts within ' + config.maxGapMinutes + ' minutes of the previous one ending, ' +
			'in the same game mode, with at most ' + config.maxDroppedPlayers + (config.maxDroppedPlayers === 1 ? ' player' : ' players') + ' leaving (joining players are fine), ' +
			'and no continuing player played another game in between. ' +
			'Every game in the run must also match the current filters.' +
			'</p>';
		var conditionSortFn = function(condition) { return rowOrder.indexOf(condition); };
		return renderMetaFactorTable("Win Rate After Consecutive Results", rows, conditionSortFn, description);
	}

	function renderChatStats(filtered) {
		if (isCustomMode(filters.mode)) {
			return '<h2 class="section-title">Chat Statistics</h2>' +
				'<div class="text-muted">Chat win rate correlation is not available for Lounge games.</div>';
		}

		var chatStats = MatchIndexUtils.computeChatStats(filtered);
		var rows = [];
		if (chatStats.noChat.games > 0) rows.push(["No Team Chat", chatStats.noChat]);
		if (chatStats.anyChat.games > 0) rows.push(["Team Chat", chatStats.anyChat]);
		if (chatStats.cleanChat.games > 0) rows.push(["Non-Toxic Chat", chatStats.cleanChat]);
		if (chatStats.toxicRoster.games > 0) rows.push(["Toxic Chat (Roster)", chatStats.toxicRoster]);
		if (chatStats.toxicOther.games > 0) rows.push(["Toxic Chat (Non-Roster)", chatStats.toxicOther]);
		if (chatStats.toxicMixed.games > 0) rows.push(["Toxic Chat (Mixed)", chatStats.toxicMixed]);
		if (rows.length === 0) return "";
		var description = '<p class="text-muted section-description">' +
			'Chat sent in the final 60 seconds of a match is excluded from these stats. ' +
			'A "gg" after the game is already decided should not count as chat that affected the outcome.' +
			'</p>';
		return renderMetaFactorTable("Chat Statistics", rows, null, description);
	}

	function renderContent() {
		var app = document.getElementById("app");
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var t = MatchIndexUtils.totals(filtered);
		var playerStats = MatchIndexUtils.groupByPlayer(filtered);
		var heroStats = MatchIndexUtils.groupByHero(filtered);
		var modeStats = MatchIndexUtils.groupByMode(filtered);

		var html =
			'<div class="page-header"><h1>Sauna Tent</h1>' +
			'<div class="subtitle">' + t.games.toLocaleString() + ' out of ' +
			matchIndex.length.toLocaleString() + ' matches</div></div>';

		html += buildPageFilterBar(filters, { mode: true, partySize: true, dateFrom: true, dateTo: true });

		html += '<h2 class="section-title">Summary</h2>';
		html += '<div class="stat-row">' +
			statBox("Total Games", t.games.toLocaleString()) +
			statBox("Wins", t.wins.toLocaleString()) +
			statBox("Losses", t.losses.toLocaleString()) +
			statBox("Win Rate", winrateSpan(t.winrate)) +
			'</div>';

		html += renderPlayerCards(playerStats);

		// Hero popularity chart
		var monthlyData = MatchIndexUtils.computeMonthlyHeroStats(filtered);
		if (monthlyData.sortedMonths.length >= 2) {
			html += '<h2 class="section-title">Top 10 Hero Popularity Over Time</h2>' +
				'<div class="text-muted chart-desc">Lines appear only for months where a hero ranks in the top 10. Gaps mean the hero dropped out that month.</div>' +
				'<div class="chart-container"><canvas id="overview-hero-pop-chart"></canvas></div>';
		}

		html += renderMostPlayedHeroes(heroStats);

		// Team Compositions
		var compRows = computeRoleCompositions(filtered);
		var compTable = null;
		if (compRows.length > 0) {
			var compColumns = [
				{ key: "roles", label: "Roles", noSort: true, format: function(v) {
					var parts = v.split(", ");
					var html = "";
					for (var i = 0; i < parts.length; i++) {
						html += roleIconHtml(parts[i]);
					}
					return html;
				}},
				{ key: "games", label: "Total", className: "num", format: function(v) { return v.toLocaleString(); } },
				{ key: "wins", label: "Win", className: "num", format: function(v) { return v.toLocaleString(); } },
				{ key: "losses", label: "Loss", className: "num", format: function(v) { return v.toLocaleString(); } },
				{ key: "winrate", label: "Win Rate", className: "num", format: function(v) { return winrateSpan(v); } },
			];
			var compHeaderGroups = [
				{ label: "Composition", span: 1 },
				{ label: "Games", span: 3 },
				{ label: "Win Rate", span: 1 },
			];
			compTable = sortableTable("comp-table", compColumns, compRows, "games", true, compHeaderGroups);
			html += '<h2 class="section-title">Team Compositions</h2>';
			html += compTable.buildHTML();
		}

		html += renderMetaStats(MatchIndexUtils.computeMetaStats(filtered));

		// Hours under the game floor are blanked so their noisy win rates never draw a bar.
		var minHourGames = AppSettings.overview.timeOfDayMinGames;
		var shownHourly = [];
		var shownHourGames = 0;
		var hourly = MatchIndexUtils.computeHourlyWinrates(filtered);
		for (var hi = 0; hi < hourly.length; hi++) {
			var hourBucket = hourly[hi].games >= minHourGames ? hourly[hi] : { games: 0, wins: 0 };
			shownHourly.push(hourBucket);
			shownHourGames += hourBucket.games;
		}

		if (filtered.length > 0) {
			html += '<h2 class="section-title">Win Rate by Time of Day</h2>' +
				'<div class="text-muted chart-desc">Only hours with at least ' + minHourGames + ' games are shown.</div>';
			if (shownHourGames > 0) {
				html += '<div class="chart-container"><canvas id="overview-hour-chart"></canvas></div>';
			} else {
				html += '<div class="text-muted">No hour has enough games with the current filters.</div>';
			}

			html += '<h2 class="section-title">Games Played by Time of Day</h2>' +
				'<div class="chart-container chart-container-short"><canvas id="overview-hour-games-chart"></canvas></div>';
		}

		html += renderStreakStats(filtered);

		html += renderChatStats(filtered);

		// Only show mode table if not filtering by a specific mode
		if (!filters.mode) {
			html += renderGameModes(modeStats);
		}

		if (heroChart) { heroChart.destroy(); heroChart = null; }
		if (hourChart) { hourChart.destroy(); hourChart = null; }
		if (hourGamesChart) { hourGamesChart.destroy(); hourGamesChart = null; }
		app.innerHTML = html;
		if (monthlyData.sortedMonths.length >= 2) {
			heroChart = ChartUtils.createHeroPopularityChart("overview-hero-pop-chart", monthlyData, heroColors);
		}
		if (filtered.length > 0 && shownHourGames > 0) {
			hourChart = ChartUtils.createHourlyWinrateChart("overview-hour-chart", shownHourly, shownHourGames);
		}
		if (filtered.length > 0) {
			hourGamesChart = ChartUtils.createHourlyGamesChart("overview-hour-games-chart", hourly, filtered.length);
		}
		if (compTable) compTable.attachListeners(app);
		attachAllSortableListeners(app);
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(); });
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading overview...</div>';

		try {
			var results = await Promise.all([Data.matchIndex(), Data.roster(), Data.summary(), Data.settings(), Data.heroColors()]);
			matchIndex = results[0];
			roster = results[1];
			summary = results[2];
			heroColors = results[4];
			readFiltersFromURL(filters, defaults);
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load summary data.</div>';
		}
	}

	return { render: render };
})();
