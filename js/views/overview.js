// Overview page: team stats, player cards, most played heroes, game modes
// Supports filtering by mode, party size, and date range via match index.
var OverviewView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "" };
	var matchIndex = null;
	var roster = null;
	var summary = null;
	var heroChart = null;
	var heroColors = null;

	function renderPlayerCards(playerStats) {
		var html = '<h2 class="section-title">Players</h2><div class="card-grid">';
		for (var i = 0; i < roster.players.length; i++) {
			var p = roster.players[i];
			var ps = playerStats[p.name];
			if (!ps || ps.games === 0) continue;
			html += '<a href="' + appLink('/player/' + p.slug) + '" class="card player-card">' +
				'<div class="player-card-name">' + escapeHtml(p.name) + '</div>' +
				'<div class="player-card-stats">' +
				'<span>' + ps.games.toLocaleString() + ' games</span>' +
				winrateSpan(ps.winrate) +
				'</div>' +
				'<div class="player-card-bar">' +
				'<div class="player-card-bar-fill" style="width:' + (ps.winrate * 100).toFixed(1) + '%"></div>' +
				'</div>' +
				'</a>';
		}
		html += '</div>';
		return html;
	}

	function renderMostPlayedHeroes(heroStats) {
		// Sort by games descending, take top 10
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
				'<span class="hero-bar-name">' + escapeHtml(h.hero) + '</span>' +
				'<span class="hero-bar-track"><span class="hero-bar-fill" style="width:' + pct + '%"></span></span>' +
				'<span class="hero-bar-count">' + h.games.toLocaleString() + '</span>' +
				'</a>';
		}
		html += '</div>';
		return html;
	}

	function renderGameModes(modeStats) {
		var keys = Object.keys(modeStats);
		keys.sort(function(a, b) { return modeStats[b].games - modeStats[a].games; });

		var html = '<h2 class="section-title">Game Modes</h2>' +
			'<div class="table-wrap"><table>' +
			'<thead><tr class="header-group-row">' +
			'<th colspan="1" class="header-group">Mode</th>' +
			'<th colspan="3" class="header-group">Games</th>' +
			'<th colspan="1" class="header-group">Win Rate</th>' +
			'<th colspan="1" class="header-group">Duration</th>' +
			'</tr><tr>' +
			'<th class="no-sort">Name</th>' +
			'<th class="no-sort num">Total</th>' +
			'<th class="no-sort num">Win</th>' +
			'<th class="no-sort num">Loss</th>' +
			'<th class="no-sort num">Avg</th>' +
			'<th class="no-sort num">Avg</th>' +
			'</tr></thead><tbody>';

		for (var i = 0; i < keys.length; i++) {
			var mode = keys[i];
			var m = modeStats[mode];
			html += '<tr>' +
				'<td>' + escapeHtml(displayModeName(mode)) + '</td>' +
				'<td class="num">' + m.games.toLocaleString() + '</td>' +
				'<td class="num">' + m.wins.toLocaleString() + '</td>' +
				'<td class="num">' + m.losses.toLocaleString() + '</td>' +
				'<td class="num">' + winrateSpan(m.winrate) + '</td>' +
				'<td class="num">' + formatDuration(m.avgDuration) + '</td>' +
				'</tr>';
		}
		html += '</tbody></table></div>';
		return html;
	}

	function renderMetaStats(metaStats) {
		var side = metaStats.teamSide;
		var fb = metaStats.firstBlood;
		var boss = metaStats.firstBoss;
		var merc = metaStats.firstMerc;
		var html = "";

		// Match Factors table: team side, first blood, first boss, first merc
		var factorRows = [];
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

	function renderChatStats(filtered) {
		if (filters.mode === "Custom") {
			return '<h2 class="section-title">Chat Statistics</h2>' +
				'<div class="text-muted">Chat win rate correlation is not available for Custom games.</div>';
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
		return renderMetaFactorTable("Chat Statistics", rows);
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
				'<div class="text-muted" style="margin-bottom:0.5rem">Lines appear only for months where a hero ranks in the top 10. Gaps mean the hero dropped out that month.</div>' +
				'<div class="chart-container"><canvas id="overview-hero-pop-chart"></canvas></div>';
		}

		html += renderMostPlayedHeroes(heroStats);

		// Team Compositions
		var compRows = computeRoleCompositions(filtered);
		var compTable = null;
		if (compRows.length > 0) {
			var compColumns = [
				{ key: "roles", label: "Roles", noSort: true },
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
		html += renderChatStats(filtered);

		// Only show mode table if not filtering by a specific mode
		if (!filters.mode) {
			html += renderGameModes(modeStats);
		}

		if (heroChart) { heroChart.destroy(); heroChart = null; }
		app.innerHTML = html;
		if (monthlyData.sortedMonths.length >= 2) {
			heroChart = ChartUtils.createHeroPopularityChart("overview-hero-pop-chart", monthlyData, heroColors);
		}
		if (compTable) compTable.attachListeners(app);
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
