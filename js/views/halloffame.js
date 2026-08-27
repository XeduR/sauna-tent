// Hall of Fame page: top-N lists for various records and achievements (N from AppSettings)
var HallOfFameView = (function() {
	var filters = { mode: "", dateFrom: "", dateTo: "", seasons: "", noAlts: true };
	var defaults = { mode: "", dateFrom: "", dateTo: "", seasons: "", noAlts: true };
	var matchIndex = null;

	function getMode() {
		return filters.mode || "Overall";
	}

	function descHtml(text) {
		if (!text) return "";
		return '<div class="hof-card-desc">' + escapeHtml(text) + '</div>';
	}

	// Maps HoF stat keys to their source in match index rosterPlayer entries.
	// "top" = top-level field on rp, "hof" = inside rp.hof dict.
	var SINGLE_GAME_STATS = {
		heroDamage:         { src: "top" },
		siegeDamage:        { src: "top" },
		healing:            { src: "top" },
		damageSoaked:       { src: "top" },
		kills:              { src: "top" },
		xpContribution:     { src: "top" },
		deaths:             { src: "top" },
		timeSpentDead:      { src: "top" },
		chatMessages:       { src: "hof" },
		pings:              { src: "hof" },
		disconnects:        { src: "hof" },
		votesReceived:      { src: "hof" },
		deathsByMinions:    { src: "hof" },
		deathsByMercs:      { src: "hof" },
		deathsByStructures: { src: "hof" },
		deathsByMonsters:   { src: "hof" },
	};

	// Heroes excluded from specific single-game record categories (the raw stat is
	// garbage/meaningless for them, e.g. Gall shares Cho's body so soaks nothing).
	var HOF_HERO_EXCLUSIONS = {
		damageSoaked:    { "Gall": true },
		damageSoakedMin: { "Gall": true, "Abathur": true },
		deaths:          { "Abathur": true, "Gall": true },
	};

	// Labels for stat cards (mirrors pipeline labels)
	var STAT_LABELS = {
		heroDamage:         "Most Hero Damage",
		siegeDamage:        "Most Siege Damage",
		healing:            "Most Healing",
		damageSoaked:       "Most Damage Taken",
		kills:              "Most Kills",
		xpContribution:     "Most XP Contribution",
		deaths:             "The Feeder Award",
		timeSpentDead:      "Time Spent Dead",
		chatMessages:       "Most Messages (Single Game)",
		pings:              "Most Pings (Single Game)",
		disconnects:        "Most Disconnects (Single Game)",
		votesReceived:      "Most Votes (Single Game)",
		deathsByMinions:    "Killed by Minions",
		deathsByMercs:      "Killed by Mercs",
		deathsByStructures: "Killed by Structures",
		deathsByMonsters:   "Killed by Monsters",
		damageSoakedMin:    "Least Damage Taken",
	};

	// Descriptions for stat categories
	var STAT_DESC = {
		heroDamage: "Damage dealt to enemy heroes.",
		siegeDamage: "Damage to structures, minions, and summons.",
		healing: "Healing done to allied heroes.",
		damageSoaked: "Damage taken in a single game.",
		damageSoakedMin: "This player avoids fights the most (excl. Abathur & Gall).",
		kills: "Killing blows on enemy heroes.",
		xpContribution: "Personal XP from lanes, mercs, and kills.",
		deaths: "Most deaths in a single game (excl. Abathur & Gall).",
		timeSpentDead: "Total time spent dead in a single game.",
		chatMessages: "Chat messages sent in a single game.",
		pings: "Pings sent in a single game.",
		disconnects: "Times disconnected in a single game.",
		votesReceived: "Votes received in a single game.",
		deathsByMinions: "Deaths to lane minions in a single game.",
		deathsByMercs: "Deaths to mercenary camps in a single game.",
		deathsByStructures: "Deaths to forts, keeps, towers, and core.",
		deathsByMonsters: "Deaths to bosses, map objectives, and monsters.",
	};

	// Single-game stats that also get a per-minute record variant (value/duration*60).
	var PER_MINUTE_STATS = ["heroDamage", "siegeDamage", "healing", "xpContribution"];

	var PER_MINUTE_LABELS = {
		heroDamage:     "Most Hero Damage / min",
		siegeDamage:    "Most Siege Damage / min",
		healing:        "Most Healing / min",
		xpContribution: "Most XP / min",
	};

	var PER_MINUTE_DESC = {
		heroDamage:     "Hero damage per minute in a single game.",
		siegeDamage:    "Siege damage per minute in a single game.",
		healing:        "Healing per minute in a single game.",
		xpContribution: "XP contribution per minute in a single game.",
	};

	// Per-minute values display with one decimal and thousands grouping.
	function formatPerMinute(v) {
		return v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	}

	// Tie-break for single-game / single-match record lists: when two records share
	// the same value, the earlier match holds the record.
	function byEarlierMatch(a, b) {
		if (a.timestamp < b.timestamp) return -1;
		if (a.timestamp > b.timestamp) return 1;
		return 0;
	}

	// Compute top-N single-game records for a stat from filtered matches.
	// invert=true means lowest value wins (for damageSoakedMin).
	// perMinute=true rescales the raw value to a per-minute rate (value/duration*60).
	function computeSingleGameRecords(filtered, statKey, topN, invert, perMinute) {
		var excluded = HOF_HERO_EXCLUSIONS[statKey] || {};
		var srcKey = statKey === "damageSoakedMin" ? "damageSoaked" : statKey;
		var srcSpec = SINGLE_GAME_STATS[srcKey];
		if (!srcSpec) return [];

		var records = [];
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (rp.isAlt) continue;
				if (excluded[rp.hero]) continue;

				var val;
				if (srcSpec.src === "top") {
					val = rp[srcKey] || 0;
				} else {
					val = (rp.hof && rp.hof[srcKey]) ? rp.hof[srcKey] : 0;
				}

				if (val <= 0) continue;
				if (perMinute) {
					if (!m.durationSeconds) continue;
					val = val / m.durationSeconds * 60;
				}

				records.push({
					value: val,
					playerName: rp.name,
					hero: rp.hero,
					map: m.map,
					gameMode: m.gameMode,
					matchId: m.matchId,
					timestamp: m.timestamp,
					durationSeconds: m.durationSeconds,
				});
			}
		}

		if (invert) {
			records.sort(function(a, b) { return a.value - b.value || byEarlierMatch(a, b); });
		} else {
			records.sort(function(a, b) { return b.value - a.value || byEarlierMatch(a, b); });
		}
		return records.slice(0, topN);
	}

	// Compute top-N game duration records from filtered matches.
	// resultFilter: "win", "loss", or null (any result).
	// shortest: true = shortest first, false = longest first.
	function computeGameDurationRecords(filtered, topN, resultFilter, shortest) {
		var records = [];
		var seen = {};
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			if (seen[m.matchId]) continue;
			seen[m.matchId] = true;
			if (resultFilter && m.result !== resultFilter) continue;
			records.push({
				map: m.map,
				gameMode: m.gameMode,
				matchId: m.matchId,
				timestamp: m.timestamp,
				durationSeconds: m.durationSeconds,
				result: m.result,
			});
		}
		if (shortest) {
			records.sort(function(a, b) { return a.durationSeconds - b.durationSeconds || byEarlierMatch(a, b); });
		} else {
			records.sort(function(a, b) { return b.durationSeconds - a.durationSeconds || byEarlierMatch(a, b); });
		}
		return records.slice(0, topN);
	}

	function renderUnavailableCard(title, description) {
		return '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(title) + '</div>' +
			descHtml(description) +
			'<div class="text-muted">This record is not available in the chosen game mode.</div></div>';
	}

	function renderStatCard(category, records, description, valueFormat) {
		var label = category.label || category;
		var top = records.slice(0, AppSettings.hallOfFame.topEntries);

		var html = '<div class="hof-card card">' +
			'<div class="hof-card-title">' + escapeHtml(label) + '</div>' +
			descHtml(description);

		if (top.length === 0) {
			html += '<div class="text-muted">No records</div>';
		} else {
			html += '<div class="hof-list">';
			for (var i = 0; i < top.length; i++) {
				var r = top[i];
				var value;
				if (valueFormat) {
					value = valueFormat(r.value);
				} else {
					value = r.value;
					if (typeof value === "number" && value >= 1000) {
						value = formatNumber(value);
					}
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
		// Order by Wilson lower bound so a tiny high-winrate sample can't top the
		// board; the displayed winrate + games stay raw.
		entries.sort(function(a, b) {
			return wilsonLowerBound(b.wins, b.games) - wilsonLowerBound(a.wins, a.games) || b.games - a.games;
		});
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

	// Sorted proportion records (value/games). Ordered by Wilson lower bound so a
	// perfect record over a few games can't outrank a strong one over many; the
	// displayed percentage stays the raw val/games. Players below the minimum game
	// floor are excluded entirely.
	function cumTopByPercent(cum, key) {
		// Coerce so a browser holding a cached settings.json without the floor key
		// degrades to unfloored rather than blanking every percentage card.
		var minGames = AppSettings.hallOfFame.percentageMinGames || 0;
		var records = [];
		for (var name in cum.games) {
			var val = cum.stats[name][key] || 0;
			var g = cum.games[name];
			if (g >= minGames && val > 0) {
				records.push({ playerName: name, pct: val / g, value: val, games: g });
			}
		}
		records.sort(function(a, b) {
			return wilsonLowerBound(b.value, b.games) - wilsonLowerBound(a.value, a.games) || b.games - a.games;
		});
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
			descHtml("Fewest total deaths to minions, mercs, structures, and monsters.");

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
			descHtml("Average time spent on fire per game.");

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
			descHtml("Total games played.") + '<div class="hof-list">';
		for (var i = 0; i < Math.min(AppSettings.hallOfFame.topEntries, gamePairs.length); i++) {
			var p = gamePairs[i];
			html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
				'<div class="hof-entry-main"><span class="hof-value">' + p.value.toLocaleString() + '</span> ' +
				'<a href="' + appLink('/player/' + slugify(p.name)) + '">' + escapeHtml(p.name) + '</a></div></div>';
		}
		html += '</div></div>';

		// Highest winrate (minimum games from AppSettings.hallOfFame.winrateMinGames).
		// Ordered by Wilson lower bound; the game floor and the raw displayed rate stay.
		var wrPairs = [];
		for (var name in playerGames) {
			if (playerGames[name] >= AppSettings.hallOfFame.winrateMinGames) {
				wrPairs.push({ name: name, winrate: playerWins[name] / playerGames[name], games: playerGames[name], wins: playerWins[name] });
			}
		}
		wrPairs.sort(function(a, b) {
			return wilsonLowerBound(b.wins, b.games) - wilsonLowerBound(a.wins, a.games) || b.games - a.games;
		});

		html += '<div class="hof-card card"><div class="hof-card-title">Highest Winrate</div>' +
			descHtml("Minimum " + AppSettings.hallOfFame.winrateMinGames + " games.") + '<div class="hof-list">';
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
			descHtml("Different heroes played.") + '<div class="hof-list">';
		for (var i = 0; i < Math.min(AppSettings.hallOfFame.topEntries, heroPairs.length); i++) {
			var p = heroPairs[i];
			html += '<div class="hof-entry"><span class="hof-rank">' + (i + 1) + '</span>' +
				'<div class="hof-entry-main"><span class="hof-value">' + p.value + '</span> heroes ' +
				'<a href="' + appLink('/player/' + slugify(p.name)) + '">' + escapeHtml(p.name) + '</a></div></div>';
		}
		html += '</div></div>';

		return html;
	}

	// Client-side aggregation of named end-of-match awards from the match index.
	// Each rosterPlayer may carry an `awards` list (award names); this counts them
	// per player per award and tracks each player's total games for the "(N games)"
	// detail. Mirrors aggregateCumulative's mode + alt filtering.
	function aggregateNamedAwards(filtered, mode) {
		var byAward = {};
		var games = {};
		for (var i = 0; i < filtered.length; i++) {
			var match = filtered[i];
			if (match.hasAlt) continue;
			if (mode !== "Overall" && match.gameMode !== mode) continue;
			for (var j = 0; j < match.rosterPlayers.length; j++) {
				var rp = match.rosterPlayers[j];
				if (rp.isAlt) continue;
				games[rp.name] = (games[rp.name] || 0) + 1;
				var awards = rp.awards;
				if (!awards) continue;
				for (var k = 0; k < awards.length; k++) {
					var an = awards[k];
					if (!byAward[an]) byAward[an] = {};
					byAward[an][rp.name] = (byAward[an][rp.name] || 0) + 1;
				}
			}
		}
		return { byAward: byAward, games: games };
	}

	// Award identities arrive as the library's MatchAwardType enum names
	// ("MostSiegeDamageDone"), so split them into words for display. The second
	// pass keeps acronyms whole: "MostXPContribution" -> "Most XP Contribution".
	function awardLabel(name) {
		return name
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	}

	// Named-award leaderboard section: one card per award name, top players by
	// award count. Self-hides entirely when the index carries no award data.
	function renderNamedAwards(filtered, mode) {
		var agg = aggregateNamedAwards(filtered, mode);
		var awardNames = Object.keys(agg.byAward).sort();
		if (awardNames.length === 0) return "";

		var html = '<h3 class="section-title">Named Awards</h3><div class="hof-grid">';
		for (var a = 0; a < awardNames.length; a++) {
			var an = awardNames[a];
			var counts = agg.byAward[an];
			var records = [];
			for (var name in counts) {
				records.push({ playerName: name, value: counts[name], games: agg.games[name] || 0 });
			}
			records.sort(function(x, y) { return y.value - x.value || y.games - x.games; });
			var label = awardLabel(an);
			html += renderCumulativeCard(label, records, "Times awarded " + label + " at the end of a match.");
		}
		html += '</div>';
		return html;
	}

	function renderContent() {
		var app = document.getElementById("app");
		var mode = getMode();
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var cum = aggregateCumulative(filtered, mode);
		// Accidental Team Chats is always about Custom games regardless of mode filter.
		// Filter with mode cleared so date/season still apply but mode doesn't blank it.
		var customFilters = {};
		for (var key in filters) customFilters[key] = filters[key];
		customFilters.mode = "";
		var filteredForCustom = MatchIndexUtils.filter(matchIndex, customFilters);
		var cumCustom = aggregateCumulative(filteredForCustom, "Custom");

		var html = '<div class="page-header"><h1>Hall of Fame <span class="hof-title-shame">and Shame</span></h1>' +
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
		html += '<h2 class="hof-page-section">Hall of Fame</h2>';
		html += '<h3 class="section-title">Best Stacks</h3><div class="hof-grid">';
		var smg = AppSettings.hallOfFame.stackMinGames;
		html += renderStackCard("Best Duos", stacks2, smg.duo, "Highest winrate duo combinations.");
		html += renderStackCard("Best 3-Stacks", stacks3, smg.trio, "Highest winrate 3-player parties.");
		html += renderStackCard("Best 4-Stacks", stacks4, smg.quad, "Highest winrate 4-player parties.");
		html += renderStackCard("Best 5-Stacks", stacks5, smg.full, "Highest winrate full teams.");
		html += '</div>';

		var topN = AppSettings.hallOfFame.topEntries;
		html += '<h3 class="section-title">Single-Game Records</h3><div class="hof-grid">';
		var statKeys = ["heroDamage", "siegeDamage", "healing", "damageSoaked", "kills", "xpContribution"];
		for (var i = 0; i < statKeys.length; i++) {
			var records = computeSingleGameRecords(filtered, statKeys[i], topN, false);
			html += renderStatCard({ label: STAT_LABELS[statKeys[i]] }, records, STAT_DESC[statKeys[i]]);
		}
		// Per-minute counterparts, shown alongside the totals (same tie-break + hero exclusions).
		for (var pm = 0; pm < PER_MINUTE_STATS.length; pm++) {
			var pmKey = PER_MINUTE_STATS[pm];
			var pmRecords = computeSingleGameRecords(filtered, pmKey, topN, false, true);
			html += renderStatCard({ label: PER_MINUTE_LABELS[pmKey] }, pmRecords, PER_MINUTE_DESC[pmKey], formatPerMinute);
		}
		html += renderGameCard("Shortest Games Won", computeGameDurationRecords(filtered, topN, "win", true), "Fastest victory.");
		html += renderGameCard("Longest Games Won", computeGameDurationRecords(filtered, topN, "win", false), "Longest match ending in victory.");
		html += '</div>';

		var hasSocialData = SINGLE_GAME_STATS.chatMessages || hasCumStat(cum, "chatMessages") ||
			SINGLE_GAME_STATS.votesReceived || hasCumStat(cum, "votesReceived");
		if (hasSocialData) {
			html += '<h3 class="section-title">Social</h3><div class="hof-grid">';
			html += renderStatCard({ label: STAT_LABELS.chatMessages }, computeSingleGameRecords(filtered, "chatMessages", topN, false), STAT_DESC.chatMessages);
			if (hasCumStat(cum, "chatMessagesTeam")) {
				html += renderCumulativeCard("Total Messages (Team Chat)", cumTopByValue(cum, "chatMessagesTeam"), "Chat messages sent to own team. You know what for.");
			}
			html += renderStatCard({ label: STAT_LABELS.pings }, computeSingleGameRecords(filtered, "pings", topN, false), STAT_DESC.pings);
			if (hasCumStat(cum, "pings")) {
				html += renderCumulativeCard("Total Pings", cumTopByValue(cum, "pings"), "Pings sent across all games.");
			}
			if (filters.mode !== "" && filters.mode !== "Custom") {
				html += renderUnavailableCard("Total All Chat", 'Friendly messages sent to other team, e.g. "gl & hf".');
				html += renderUnavailableCard("Accidental Team Chats", "Team chat in Custom games (probably meant for all chat).");
			} else {
				if (hasCumStat(cumCustom, "chatMessagesAll")) {
					html += renderCumulativeCard("Total All Chat", cumTopByValue(cumCustom, "chatMessagesAll"), 'Friendly messages sent to other team, e.g. "gl & hf".');
				}
				html += renderCumulativeCard("Accidental Team Chats", cumTopByValue(cumCustom, "chatMessagesTeam"),
					"Team chat in Custom games (probably meant for all chat).");
			}
			if (hasCumStat(cum, "chatGlhf")) {
				html += renderPercentCard("Sportsmanlike Start", cumTopByPercent(cum, "chatGlhf"),
					"Percentage of games where the player greeted with \"gl hf\".", "greetings");
			}
			if (hasCumStat(cum, "chatGamesClean")) {
				html += renderPercentCard("Conversationalist", cumTopByPercent(cum, "chatGamesClean"),
					"Percentage of games with chat without triggering the toxic word detection.", "clean games");
			}
			if (hasCumStat(cum, "votesGiven")) {
				html += renderCumulativeCard("Total Votes Given", cumTopByValue(cum, "votesGiven"), "Post-game votes given to other players.");
			}
			if (hasCumStat(cum, "votesReceived")) {
				html += renderCumulativeCard("Total Votes Received", cumTopByValue(cum, "votesReceived"), "Post-game votes received from others.");
			}
			html += renderStatCard({ label: STAT_LABELS.votesReceived }, computeSingleGameRecords(filtered, "votesReceived", topN, false), STAT_DESC.votesReceived);
			html += '</div>';
		}

		html += '<h3 class="section-title">Player Records</h3><div class="hof-grid">';
		html += renderFunStats(filtered);
		html += renderAvgTimeOnFireCard(cum);
		if (hasCumStat(cum, "hasAward")) {
			html += renderCumulativeCard("Most End-of-Match Awards", cumTopByValue(cum, "hasAward"), "Total post-game awards across all games.");
		}
		if (hasCumStat(cum, "awardMVP")) {
			html += renderPercentCard("MVP Percentage", cumTopByPercent(cum, "awardMVP"), "Percentage of games awarded MVP.", "MVPs");
		}
		if (hasCumStat(cum, "regenGlobes")) {
			html += renderCumulativeCard("A Game of Globes", cumTopByValue(cum, "regenGlobes"), "Total number of globes collected.");
		}
		if (hasCumStat(cum, "femaleHero")) {
			html += renderPercentCard("Gender Equality", cumTopByPercent(cum, "femaleHero"), "Percentage of games played with female characters.", "female hero games");
		}
		html += '</div>';

		// Named awards; the section self-hides when the index carries no award data.
		html += renderNamedAwards(filtered, mode);

		// Hall of Shame
		html += '<div class="hof-shame-divider"></div>';
		html += '<h2 class="hof-page-section">Hall of Shame</h2>';

		// Beatings
		html += '<h3 class="section-title">Beatings</h3><div class="hof-grid">';
		var snarkyKeys = ["deaths", "timeSpentDead"];
		for (var i = 0; i < snarkyKeys.length; i++) {
			var records = computeSingleGameRecords(filtered, snarkyKeys[i], topN, false);
			html += renderStatCard({ label: STAT_LABELS[snarkyKeys[i]] }, records, STAT_DESC[snarkyKeys[i]]);
		}
		html += renderStatCard({ label: STAT_LABELS.damageSoakedMin }, computeSingleGameRecords(filtered, "damageSoakedMin", topN, true), STAT_DESC.damageSoakedMin);

		var deathSourceKeys = ["deathsByMinions", "deathsByMercs", "deathsByStructures", "deathsByMonsters"];
		for (var i = 0; i < deathSourceKeys.length; i++) {
			var key = deathSourceKeys[i];
			html += renderStatCard({ label: STAT_LABELS[key] }, computeSingleGameRecords(filtered, key, topN, false), STAT_DESC[key]);
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
				html += renderCumulativeCard(deathCumulativeLabels[key], cumTopByValue(cum, key), "Total " + deathCumulativeLabels[key].toLowerCase() + ".");
			}
		}
		html += renderMostScaredCard(cum);
		html += '</div>';

		// Social
		html += '<h3 class="section-title">Social</h3><div class="hof-grid">';
		if (hasCumStat(cum, "disconnectedAtEnd")) {
			html += renderCumulativeCard("Rage Quits", cumTopByValue(cum, "disconnectedAtEnd"), "Games left without returning.");
		}
		if (hasCumStat(cum, "chatGamesToxic")) {
			html += renderPercentCard("Most Toxic Conversationalist", cumTopByPercent(cum, "chatGamesToxic"),
				"Percentage of games where the player sent a toxic message.", "toxic games");
		}
		if (filters.mode !== "" && filters.mode !== "Custom") {
			html += renderUnavailableCard("Offensive GG", "Percentage of Custom games with an early or premature \"gg\".");
		} else if (hasCumStat(cumCustom, "chatOffensiveGg")) {
			html += renderPercentCard("Offensive GG", cumTopByPercent(cumCustom, "chatOffensiveGg"),
				"Percentage of Custom games with an early or premature \"gg\".", "offensive ggs");
		}
		html += '</div>';

		// Matches
		html += '<h3 class="section-title">Matches</h3><div class="hof-grid">';
		var shortestLost = computeGameDurationRecords(filtered, topN, "loss", true);
		var longestLost = computeGameDurationRecords(filtered, topN, "loss", false);
		if (shortestLost.length > 0 || longestLost.length > 0) {
			html += renderGameCard("Shortest Games Lost", shortestLost, "Fastest defeat.");
			html += renderGameCard("Longest Games Lost", longestLost, "Longest match ending in defeat.");
		} else {
			html += renderGameCard("Shortest Games", computeGameDurationRecords(filtered, topN, null, true), "Shortest match by duration.");
			html += renderGameCard("Longest Games", computeGameDurationRecords(filtered, topN, null, false), "Longest match by duration.");
		}
		html += '</div>';

		html += '<p class="hof-footnote">Rate boards (win rates and percentages) are ordered by their Wilson 95% lower bound, so a few lucky games can\'t outrank a long, consistent record. Single-game record ties go to the earlier match.</p>';

		app.innerHTML = html;
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(); });
	}

	function setNoAltsToggleDisabled(disabled) {
		var toggle = document.getElementById("global-no-alts-toggle");
		if (!toggle) return;
		toggle.disabled = disabled;
		var label = toggle.parentElement;
		if (disabled) {
			label.classList.add("disabled");
			label.title = "Alts are not tracked for Hall of Fame.";
		} else {
			label.classList.remove("disabled");
			label.title = "Hide matches containing alt accounts";
		}
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading Hall of Fame...</div>';

		setNoAltsToggleDisabled(true);
		// HoF ignores the global noAlts toggle, so the `na` URL param is meaningless here.
		// Underlying GlobalFilters state and localStorage are preserved; only the URL is cleaned.
		GlobalFilters.stripNoAltsFromURL();

		try {
			var results = await Promise.all([Data.matchIndex(), Data.settings()]);
			matchIndex = results[0];
			readFiltersFromURL(filters, defaults);
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load Hall of Fame data.</div>';
		}
	}

	// Called by Router before dispatching any view so HoF's overrides
	// don't leak into the next page (toggle disabled state, missing `na` param).
	function restoreNoAltsToggle() {
		setNoAltsToggleDisabled(false);
		GlobalFilters.writeNoAltsToURL();
	}

	return { render: render, restoreNoAltsToggle: restoreNoAltsToggle };
})();
