// Hall of Fame page: top 5 lists for various records and achievements
var HallOfFameView = (function() {
	var filters = { mode: "", dateFrom: "", dateTo: "", seasons: "" };
	var defaults = { mode: "", dateFrom: "", dateTo: "", seasons: "" };
	var hofData = null;
	var matchIndex = null;

	function filterByDate(records) {
		var hasDateFilter = filters.dateFrom || filters.dateTo;
		var seasonRanges = null;
		if (filters.seasons) {
			var seasonNums = filters.seasons.split(",");
			var allSeasons = window.AppSeasons || [];
			seasonRanges = [];
			for (var si = 0; si < allSeasons.length; si++) {
				if (seasonNums.indexOf(String(allSeasons[si].number)) !== -1) {
					seasonRanges.push(allSeasons[si]);
				}
			}
		}
		if (!hasDateFilter && (!seasonRanges || seasonRanges.length === 0)) return records;
		var result = [];
		for (var i = 0; i < records.length; i++) {
			var ts = records[i].timestamp.substring(0, 10);
			if (filters.dateFrom && ts < filters.dateFrom) continue;
			if (filters.dateTo && ts > filters.dateTo) continue;
			if (seasonRanges && seasonRanges.length > 0) {
				var inSeason = false;
				for (var sr = 0; sr < seasonRanges.length; sr++) {
					if (ts >= seasonRanges[sr].start && ts < seasonRanges[sr].end) {
						inSeason = true;
						break;
					}
				}
				if (!inSeason) continue;
			}
			result.push(records[i]);
		}
		return result;
	}

	function getMode() {
		return filters.mode || "Overall";
	}

	function descHtml(text) {
		if (!text) return "";
		return '<div class="hof-card-desc">' + escapeHtml(text) + '</div>';
	}

	// Descriptions for stat categories
	var STAT_DESC = {
		heroDamage: "Damage dealt to enemy heroes",
		siegeDamage: "Damage to structures, minions, and summons",
		healing: "Healing done to allied heroes",
		damageSoaked: "Damage taken in a single game",
		damageSoakedMin: "This player avoids fights the most (excl. Abathur & Gall)",
		kills: "Killing blows on enemy heroes",
		xpContribution: "Personal XP from lanes, mercs, and kills",
		deaths: "Most deaths in a single game (excl. Abathur & Gall)",
		timeSpentDead: "Total time spent dead in a single game",
		chatMessages: "Chat messages sent in a single game",
		pings: "Pings sent in a single game",
		disconnects: "Times disconnected in a single game",
		votesReceived: "Votes received in a single game",
		deathsByMinions: "Deaths to lane minions in a single game",
		deathsByMercs: "Deaths to mercenary camps in a single game",
		deathsByStructures: "Deaths to forts, keeps, towers, and core",
		deathsByMonsters: "Deaths to bosses, map objectives, and monsters",
	};

	function renderStatCard(category, records, description) {
		var label = category.label || category;
		var top = filterByDate(records).slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(label) + '</div>' +
			descHtml(description);

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var r = top[i];
				var value = r.value;
				if (typeof value === "number" && value >= 1000) {
					value = formatNumber(value);
				}
				html += '<div class="hof-entry">' +
					'<span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main">' +
					'<span class="hof-value">' + escapeHtml(String(value)) + '</span>' +
					'<a href="' + appLink('/player/' + slugify(r.playerName)) + '">' + escapeHtml(r.playerName) + '</a>' +
					' on <a href="' + appLink('/hero/' + slugify(r.hero)) + '">' + heroIconHtml(r.hero) + escapeHtml(r.hero) + '</a>' +
					'</div>' +
					'<div class="hof-entry-meta">' +
					'<a href="' + appLink('/match/' + r.matchId) + '">' + escapeHtml(displayMapName(r.map)) + '</a>' +
					' | ' + formatDateFinnish(r.timestamp) +
					' | ' + formatDuration(r.durationSeconds) +
					'</div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderGameCard(title, records, description) {
		var top = filterByDate(records).slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(title) + '</div>' +
			descHtml(description);

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var r = top[i];
				var resultClass = r.result === "win" ? "win" : (r.result === "loss" ? "loss" : "");
				html += '<div class="hof-entry">' +
					'<span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main">' +
					'<span class="hof-value">' + formatDuration(r.durationSeconds) + '</span>' +
					'<a href="' + appLink('/map/' + slugify(r.map)) + '">' + escapeHtml(displayMapName(r.map)) + '</a>' +
					' <span class="' + resultClass + '">' + escapeHtml(r.result === "win" ? "Victory" : "Defeat") + '</span>' +
					'</div>' +
					'<div class="hof-entry-meta">' +
					'<a href="' + appLink('/match/' + r.matchId) + '">Match</a>' +
					' | ' + formatDateFinnish(r.timestamp) +
					' | ' + escapeHtml(displayModeName(r.gameMode)) +
					'</div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderStackCard(title, stacks, minGames, description) {
		var entries = [];
		for (var key in stacks) {
			var s = stacks[key];
			if (s.games >= minGames) {
				entries.push(s);
			}
		}
		entries.sort(function(a, b) { return b.winrate - a.winrate || b.games - a.games; });
		var top = entries.slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(title) + '</div>' +
			descHtml(description);

		if (top.length === 0) {
			html += '<div class="text-muted">No stacks with ' + minGames + '+ games</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var s = top[i];
				var sizeLabel = PARTY_LABELS[s.size] || s.size + "-stack";
				var names = [];
				for (var j = 0; j < s.players.length; j++) {
					names.push('<a href="' + appLink('/player/' + slugify(s.players[j])) + '">' + escapeHtml(s.players[j]) + '</a>');
				}
				html += '<div class="hof-entry">' +
					'<span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main">' +
					winrateSpan(s.winrate) +
					' <span class="text-muted">(' + s.games + ' games)</span> ' +
					names.join(', ') +
					'</div>' +
					'<div class="hof-entry-meta">' + escapeHtml(sizeLabel) + ' | ' +
					s.wins + 'W ' + s.losses + 'L</div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	// Aggregate cumulative HoF stats from filtered match index entries.
	// All cumulative cards are computed here so they respect date/season filters.
	function aggregateCumulative(filtered, mode) {
		var games = {};
		var stats = {};
		for (var i = 0; i < filtered.length; i++) {
			var match = filtered[i];
			if (match.hasAlt) continue;
			if (mode !== "Overall" && match.gameMode !== mode) continue;
			for (var j = 0; j < match.rosterPlayers.length; j++) {
				var rp = match.rosterPlayers[j];
				if (rp.isAlt) continue;
				if (!games[rp.name]) {
					games[rp.name] = 0;
					stats[rp.name] = {};
				}
				games[rp.name]++;
				var hof = rp.hof;
				if (hof) {
					for (var key in hof) {
						stats[rp.name][key] = (stats[rp.name][key] || 0) + hof[key];
					}
				}
			}
		}
		return { games: games, stats: stats };
	}

	// Sorted records by total value descending
	function cumTopByValue(cum, key) {
		var records = [];
		for (var name in cum.games) {
			var val = cum.stats[name][key] || 0;
			if (val > 0) {
				records.push({ playerName: name, value: val, games: cum.games[name] });
			}
		}
		records.sort(function(a, b) { return b.value - a.value || b.games - a.games; });
		return records;
	}

	// Sorted records by value/games percentage descending
	function cumTopByPercent(cum, key) {
		var records = [];
		for (var name in cum.games) {
			var val = cum.stats[name][key] || 0;
			var g = cum.games[name];
			if (g > 0 && val > 0) {
				records.push({ playerName: name, pct: val / g, value: val, games: g });
			}
		}
		records.sort(function(a, b) { return b.pct - a.pct; });
		return records;
	}

	function hasCumStat(cum, key) {
		for (var name in cum.stats) {
			if (cum.stats[name][key] > 0) return true;
		}
		return false;
	}

	function renderCumulativeCard(title, records, description) {
		var top = records.slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(title) + '</div>' +
			descHtml(description);

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var r = top[i];
				html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main"><span class="hof-value">' + r.value.toLocaleString() + '</span> ' +
					'<a href="' + appLink('/player/' + slugify(r.playerName)) + '">' + escapeHtml(r.playerName) + '</a>' +
					' <span class="text-muted">(' + r.games + ' games)</span></div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderPercentCard(title, records, description, detailLabel) {
		var top = records.slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(title) + '</div>' +
			descHtml(description);

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var e = top[i];
				html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main"><span class="hof-value">' + (e.pct * 100).toFixed(1) + '%</span> ' +
					'<a href="' + appLink('/player/' + slugify(e.playerName)) + '">' + escapeHtml(e.playerName) + '</a>' +
					' <span class="text-muted">(' + e.value + ' ' + detailLabel + ' in ' + e.games + ' games)</span></div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderMostScaredCard(cum) {
		var deathKeys = ["deathsByMinions", "deathsByMercs", "deathsByStructures", "deathsByMonsters"];
		var entries = [];
		for (var name in cum.games) {
			var total = 0;
			for (var k = 0; k < deathKeys.length; k++) {
				total += cum.stats[name][deathKeys[k]] || 0;
			}
			entries.push({ playerName: name, total: total, games: cum.games[name] });
		}
		entries.sort(function(a, b) { return a.total - b.total; });
		var top = entries.slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">PvE Pacifist</div>' +
			descHtml("Fewest total deaths to minions, mercs, structures, and monsters");

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var e = top[i];
				html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main"><span class="hof-value">' + e.total + '</span> PvE deaths ' +
					'<a href="' + appLink('/player/' + slugify(e.playerName)) + '">' + escapeHtml(e.playerName) + '</a>' +
					' <span class="text-muted">(' + e.games + ' games)</span></div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderAvgTimeOnFireCard(cum) {
		var entries = [];
		for (var name in cum.games) {
			var val = cum.stats[name].timeOnFire || 0;
			var g = cum.games[name];
			if (g > 0 && val > 0) {
				entries.push({ playerName: name, avg: val / g, total: val, games: g });
			}
		}
		entries.sort(function(a, b) { return b.avg - a.avg; });
		var top = entries.slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">Average Time on Fire</div>' +
			descHtml("Average time spent on fire per game");

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var e = top[i];
				html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
					'<div class="hof-entry-main"><span class="hof-value">' + formatDuration(e.avg) + '</span> ' +
					'<a href="' + appLink('/player/' + slugify(e.playerName)) + '">' + escapeHtml(e.playerName) + '</a>' +
					' <span class="text-muted">(' + e.games + ' games)</span></div></div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderFunStats(filtered) {
		var playerGames = {};
		var playerWins = {};
		var playerHeroes = {};
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (!playerGames[rp.name]) {
					playerGames[rp.name] = 0;
					playerWins[rp.name] = 0;
					playerHeroes[rp.name] = {};
				}
				playerGames[rp.name]++;
				if (rp.result === "win") playerWins[rp.name]++;
				playerHeroes[rp.name][rp.hero] = true;
			}
		}

		var html = '';

		// Most games played
		var gamePairs = [];
		for (var name in playerGames) gamePairs.push({ name: name, value: playerGames[name] });
		gamePairs.sort(function(a, b) { return b.value - a.value; });

		html += '<div class="hof-card card"><div class="hof-card-title">Most Games Played</div>' +
			descHtml("Total games played") + '<div class="hof-list">';
		for (var i = 0; i < Math.min(AppSettings.hallOfFame.topEntries, gamePairs.length); i++) {
			var p = gamePairs[i];
			html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
				'<div class="hof-entry-main"><span class="hof-value">' + p.value.toLocaleString() + '</span> ' +
				'<a href="' + appLink('/player/' + slugify(p.name)) + '">' + escapeHtml(p.name) + '</a></div></div>';
		}
		html += '</div></div>';

		// Highest winrate (min 50 games)
		var wrPairs = [];
		for (var name in playerGames) {
			if (playerGames[name] >= AppSettings.hallOfFame.winrateMinGames) {
				wrPairs.push({ name: name, winrate: playerWins[name] / playerGames[name], games: playerGames[name] });
			}
		}
		wrPairs.sort(function(a, b) { return b.winrate - a.winrate; });

		html += '<div class="hof-card card"><div class="hof-card-title">Highest Winrate</div>' +
			descHtml("Minimum " + AppSettings.hallOfFame.winrateMinGames + " games") + '<div class="hof-list">';
		for (var i = 0; i < Math.min(AppSettings.hallOfFame.topEntries, wrPairs.length); i++) {
			var p = wrPairs[i];
			html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
				'<div class="hof-entry-main">' + winrateSpan(p.winrate) + ' <span class="text-muted">(' + p.games + ' games)</span> ' +
				'<a href="' + appLink('/player/' + slugify(p.name)) + '">' + escapeHtml(p.name) + '</a></div></div>';
		}
		html += '</div></div>';

		// Most unique heroes
		var heroPairs = [];
		for (var name in playerHeroes) {
			heroPairs.push({ name: name, value: Object.keys(playerHeroes[name]).length });
		}
		heroPairs.sort(function(a, b) { return b.value - a.value; });

		html += '<div class="hof-card card"><div class="hof-card-title">Most Unique Heroes</div>' +
			descHtml("Different heroes played") + '<div class="hof-list">';
		for (var i = 0; i < Math.min(AppSettings.hallOfFame.topEntries, heroPairs.length); i++) {
			var p = heroPairs[i];
			html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
				'<div class="hof-entry-main"><span class="hof-value">' + p.value + '</span> heroes ' +
				'<a href="' + appLink('/player/' + slugify(p.name)) + '">' + escapeHtml(p.name) + '</a></div></div>';
		}
		html += '</div></div>';

		return html;
	}

	function renderContent() {
		var app = document.getElementById("app");
		var mode = getMode();
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var cum = aggregateCumulative(filtered, mode);
		var cumCustom = aggregateCumulative(filtered, "Custom");

		var html = '<div class="page-header"><h1>Hall of Fame and Shame</h1>' +
			'<div class="subtitle">Records and achievements</div></div>';

		html += buildPageFilterBar(filters, { mode: true, dateFrom: true, dateTo: true });

		// Hall of Fame
		var stacks = MatchIndexUtils.groupByStack(filtered);
		var stacks2 = {}, stacks3 = {}, stacks4 = {}, stacks5 = {};
		for (var key in stacks) {
			var s = stacks[key];
			if (s.size === 2) stacks2[key] = s;
			else if (s.size === 3) stacks3[key] = s;
			else if (s.size === 4) stacks4[key] = s;
			else if (s.size === 5) stacks5[key] = s;
		}
		html += '<h2 class="section-title">Hall of Fame</h2><div class="hof-grid">';
		var smg = AppSettings.hallOfFame.stackMinGames;
		html += renderStackCard("Best Duos", stacks2, smg.duo, "Highest winrate duo combinations");
		html += renderStackCard("Best 3-Stacks", stacks3, smg.trio, "Highest winrate 3-player parties");
		html += renderStackCard("Best 4-Stacks", stacks4, smg.quad, "Highest winrate 4-player parties");
		html += renderStackCard("Best 5-Stacks", stacks5, smg.full, "Highest winrate full teams");
		html += '</div>';

		html += '<h3 class="section-title">Single-Game Records</h3><div class="hof-grid">';
		var statKeys = ["heroDamage", "siegeDamage", "healing", "damageSoaked", "kills", "xpContribution"];
		for (var i = 0; i < statKeys.length; i++) {
			var cat = hofData.stats[statKeys[i]];
			var records = cat[mode] || [];
			html += renderStatCard(cat, records, STAT_DESC[statKeys[i]]);
		}
		if (hofData.games.shortestWon) {
			html += renderGameCard("Shortest Games Won", hofData.games.shortestWon[mode] || [], "Fastest victory");
		}
		if (hofData.games.longestWon) {
			html += renderGameCard("Longest Games Won", hofData.games.longestWon[mode] || [], "Longest match ending in victory");
		}
		html += '</div>';

		if (hasCumStat(cum, "hasAward")) {
			html += '<h3 class="section-title">Awards</h3><div class="hof-grid">';
			html += renderCumulativeCard("Most End-of-Match Awards", cumTopByValue(cum, "hasAward"), "Total post-game awards across all games");
			html += renderPercentCard("MVP Percentage", cumTopByPercent(cum, "awardMVP"), "Percentage of games awarded MVP", "MVPs");
			html += '</div>';
		}

		var hasSocialData = hofData.stats.chatMessages || hasCumStat(cum, "chatMessages") ||
			hofData.stats.votesReceived || hasCumStat(cum, "votesReceived");
		if (hasSocialData) {
			html += '<h3 class="section-title">Social</h3><div class="hof-grid">';
			if (hofData.stats.chatMessages) {
				html += renderStatCard(hofData.stats.chatMessages, (hofData.stats.chatMessages[mode] || []), STAT_DESC.chatMessages);
			}
			if (hasCumStat(cum, "chatMessagesTeam")) {
				html += renderCumulativeCard("Total Messages (Team Chat)", cumTopByValue(cum, "chatMessagesTeam"), "Chat messages sent to own team. You know what for.");
			}
			if (hofData.stats.pings) {
				html += renderStatCard(hofData.stats.pings, (hofData.stats.pings[mode] || []), STAT_DESC.pings);
			}
			if (hasCumStat(cum, "pings")) {
				html += renderCumulativeCard("Total Pings", cumTopByValue(cum, "pings"), "Pings sent across all games");
			}
			if (hasCumStat(cum, "chatMessagesAll")) {
				html += renderCumulativeCard("Total All Chat", cumTopByValue(cum, "chatMessagesAll"), 'Friendly messages sent to other team, e.g. "gl & hf"');
			}
			html += renderCumulativeCard("Accidental Team Chats", cumTopByValue(cumCustom, "chatMessagesTeam"),
				"Team chat in Custom games (probably meant for all chat)");
			if (hasCumStat(cum, "chatGlhf")) {
				html += renderPercentCard("Sportsmanlike Start", cumTopByPercent(cum, "chatGlhf"),
					"Percentage of games where the player greeted with \"gl hf\"", "greetings");
			}
			if (hasCumStat(cum, "chatGamesClean")) {
				html += renderPercentCard("Conversationalist", cumTopByPercent(cum, "chatGamesClean"),
					"Percentage of games with chat and no toxic messages", "clean games");
			}
			if (hasCumStat(cum, "votesGiven")) {
				html += renderCumulativeCard("Total Votes Given", cumTopByValue(cum, "votesGiven"), "Post-game votes given to other players");
			}
			if (hasCumStat(cum, "votesReceived")) {
				html += renderCumulativeCard("Total Votes Received", cumTopByValue(cum, "votesReceived"), "Post-game votes received from others");
			}
			if (hofData.stats.votesReceived) {
				html += renderStatCard(hofData.stats.votesReceived, (hofData.stats.votesReceived[mode] || []), STAT_DESC.votesReceived);
			}
			html += '</div>';
		}

		html += '<h3 class="section-title">Player Records</h3><div class="hof-grid">';
		html += renderFunStats(filtered);
		html += renderAvgTimeOnFireCard(cum);
		if (hasCumStat(cum, "regenGlobes")) {
			html += renderCumulativeCard("A Game of Globes", cumTopByValue(cum, "regenGlobes"), "Total number of globes collected");
		}
		if (hasCumStat(cum, "hasMultikill")) {
			html += renderPercentCard("Multi-kill Percentage", cumTopByPercent(cum, "hasMultikill"), "Percentage of games with multikills", "multikill games");
		}
		if (hasCumStat(cum, "femaleHero")) {
			html += renderPercentCard("Gender Equality", cumTopByPercent(cum, "femaleHero"), "Percentage of games played with female characters", "female hero games");
		}
		html += '</div>';

		// Hall of Shame
		html += '<h2 class="section-title">Hall of Shame</h2><div class="hof-grid">';
		var snarkyKeys = ["deaths", "timeSpentDead"];
		var snarkyLabels = { deaths: "The Feeder Award", timeSpentDead: "Time Spent Dead" };
		for (var i = 0; i < snarkyKeys.length; i++) {
			var cat = hofData.stats[snarkyKeys[i]];
			var records = cat[mode] || [];
			var display = { label: snarkyLabels[snarkyKeys[i]] };
			html += renderStatCard(display, records, STAT_DESC[snarkyKeys[i]]);
		}

		if (hasCumStat(cum, "chatGamesToxic")) {
			html += renderPercentCard("Most Toxic Conversationalist", cumTopByPercent(cum, "chatGamesToxic"),
				"Percentage of games where the player sent a toxic message", "toxic games");
		}
		if (hasCumStat(cum, "chatOffensiveGg")) {
			html += renderPercentCard("Offensive GG", cumTopByPercent(cum, "chatOffensiveGg"),
				"Percentage of games with an early or premature \"gg\"", "offensive ggs");
		}

		if (hofData.stats.damageSoakedMin) {
			var minRecords = hofData.stats.damageSoakedMin[mode] || [];
			html += renderStatCard({ label: "Least Damage Taken" }, minRecords, STAT_DESC.damageSoakedMin);
		}

		var deathSourceKeys = ["deathsByMinions", "deathsByMercs", "deathsByStructures", "deathsByMonsters"];
		var deathSourceLabels = {
			deathsByMinions: "Killed by Minions",
			deathsByMercs: "Killed by Mercs",
			deathsByStructures: "Killed by Structures",
			deathsByMonsters: "Killed by Monsters",
		};
		for (var i = 0; i < deathSourceKeys.length; i++) {
			var key = deathSourceKeys[i];
			if (hofData.stats[key]) {
				html += renderStatCard({ label: deathSourceLabels[key] }, (hofData.stats[key][mode] || []), STAT_DESC[key]);
			}
		}
		var deathCumulativeLabels = {
			deathsByMinions: "Total Deaths to Minions",
			deathsByMercs: "Total Deaths to Mercs",
			deathsByStructures: "Total Deaths to Structures",
			deathsByMonsters: "Total Deaths to Monsters",
		};
		for (var i = 0; i < deathSourceKeys.length; i++) {
			var key = deathSourceKeys[i];
			if (hasCumStat(cum, key)) {
				html += renderCumulativeCard(deathCumulativeLabels[key], cumTopByValue(cum, key), "Total " + deathCumulativeLabels[key].toLowerCase());
			}
		}

		html += renderMostScaredCard(cum);

		if (hofData.games.shortestLost) {
			html += renderGameCard("Shortest Games Lost", hofData.games.shortestLost[mode] || [], "Fastest defeat");
		}
		if (hofData.games.longestLost) {
			html += renderGameCard("Longest Games Lost", hofData.games.longestLost[mode] || [], "Longest match ending in defeat");
		}
		if (!hofData.games.shortestLost && !hofData.games.longestLost) {
			html += renderGameCard("Shortest Games", hofData.games.shortest[mode] || [], "Shortest match by duration");
			html += renderGameCard("Longest Games", hofData.games.longest[mode] || [], "Longest match by duration");
		}

		if (hasCumStat(cum, "disconnectedAtEnd")) {
			html += renderCumulativeCard("Rage Quits", cumTopByValue(cum, "disconnectedAtEnd"), "Games left without returning");
		}
		html += '</div>';

		app.innerHTML = html;
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(); });
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading Hall of Fame...</div>';

		try {
			var results = await Promise.all([Data.hallOfFame(), Data.matchIndex(), Data.settings()]);
			hofData = results[0];
			matchIndex = results[1];
			readFiltersFromURL(filters, defaults);
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load Hall of Fame data.</div>';
		}
	}

	return { render: render };
})();
