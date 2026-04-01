// Player profile page: stats, hero table, map table, party breakdown
var PlayerView = (function() {
	var filters = { mode: "", map: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var defaults = { mode: "", map: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var playerData = null;
	var matchIndex = null;
	var heroRoles = {};
	var playerName = null;
	var currentMask = null;
	var recentMatchData = [];

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["player-heroes"].defaultMask;
	}

	function hasDataFilters() {
		return filters.mode || filters.map || filters.dateFrom || filters.dateTo;
	}

	function getAvailableMaps() {
		var mapSet = {};
		for (var i = 0; i < matchIndex.length; i++) {
			var m = matchIndex[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				if (m.rosterPlayers[j].name === playerName) {
					mapSet[m.map] = true;
					break;
				}
			}
		}
		return Object.keys(mapSet).sort();
	}

	// Recompute hero stats from match index when filters are active
	function computeFilteredHeroes() {
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var heroes = {};
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (rp.name !== playerName) continue;
				if (!heroes[rp.hero]) {
					heroes[rp.hero] = { games: 0, wins: 0, losses: 0, totalDuration: 0,
						totalKills: 0, totalDeaths: 0, totalAssists: 0, totalHeroDamage: 0, totalSiegeDamage: 0,
						totalHealing: 0, totalSelfHealing: 0, totalDamageTaken: 0,
						totalXpContribution: 0, totalMercCaptures: 0, totalTimeSpentDead: 0,
						durationMin: null, durationMax: null, lastPlayed: null };
				}
				var h = heroes[rp.hero];
				h.games++;
				if (rp.result === "win") h.wins++;
				else h.losses++;
				h.totalDuration += m.durationSeconds;
				h.totalKills += rp.kills || 0;
				h.totalDeaths += rp.deaths || 0;
				h.totalAssists += rp.assists || 0;
				h.totalHeroDamage += rp.heroDamage || 0;
				h.totalSiegeDamage += rp.siegeDamage || 0;
				h.totalHealing += rp.healing || 0;
				h.totalSelfHealing += rp.selfHealing || 0;
				h.totalDamageTaken += rp.damageTaken || 0;
				h.totalXpContribution += rp.xpContribution || 0;
				h.totalMercCaptures += rp.mercCaptures || 0;
				h.totalTimeSpentDead += rp.timeSpentDead || 0;
				if (h.durationMin === null || m.durationSeconds < h.durationMin) h.durationMin = m.durationSeconds;
				if (h.durationMax === null || m.durationSeconds > h.durationMax) h.durationMax = m.durationSeconds;
				if (h.lastPlayed === null || m.timestamp > h.lastPlayed) h.lastPlayed = m.timestamp;
			}
		}
		for (var hero in heroes) {
			var h = heroes[hero];
			h.winrate = h.games > 0 ? h.wins / h.games : 0;
			if (h.games > 0) {
				h.averageDurationSeconds = h.totalDuration / h.games;
				h.avgDuration = h.averageDurationSeconds;
				var deaths = Math.max(h.totalDeaths, 1);
				h.averages = {
					kills: Math.round(h.totalKills / h.games * 10) / 10,
					deaths: Math.round(h.totalDeaths / h.games * 10) / 10,
					assists: Math.round(h.totalAssists / h.games * 10) / 10,
					kda: Math.round((h.totalKills + h.totalAssists) / deaths * 100) / 100,
					heroDamage: Math.round(h.totalHeroDamage / h.games),
					siegeDamage: Math.round(h.totalSiegeDamage / h.games),
					healing: Math.round(h.totalHealing / h.games),
					selfHealing: Math.round(h.totalSelfHealing / h.games),
					damageTaken: Math.round(h.totalDamageTaken / h.games),
					xpContribution: Math.round(h.totalXpContribution / h.games),
					mercCaptures: Math.round(h.totalMercCaptures / h.games * 10) / 10,
					timeSpentDead: Math.round(h.totalTimeSpentDead / h.games * 10) / 10,
				};
			}
		}
		return heroes;
	}

	// Aggregate from heroes that pass minGames with party filter support
	function aggregateHeroes(heroes, minGames, partyFilter) {
		if (!partyFilter) return aggregateGroup(heroes, minGames);
		var filtered = {};
		for (var hero in heroes) {
			var src = (heroes[hero].byPartySize || {})[partyFilter];
			if (src) filtered[hero] = src;
		}
		return aggregateGroup(filtered, minGames);
	}

	function renderRoleWinrates(heroes, partyFilter, minGames) {
		var roleStats = {};
		var heroNames = Object.keys(heroes);
		for (var i = 0; i < heroNames.length; i++) {
			var h = heroes[heroNames[i]];
			var role = heroRoles[heroNames[i]] || "Unknown";
			if (!roleStats[role]) roleStats[role] = { games: 0, wins: 0 };
			if (partyFilter) {
				var pd = (h.byPartySize || {})[partyFilter];
				if (!pd || pd.games < minGames) continue;
				roleStats[role].games += pd.games;
				roleStats[role].wins += pd.wins;
			} else {
				if (h.games < minGames) continue;
				roleStats[role].games += h.games;
				roleStats[role].wins += h.wins;
			}
		}

		var roleOrder = ["Tank", "Bruiser", "Melee Assassin", "Ranged Assassin", "Healer", "Support"];
		var html = '<h2 class="section-title">Win Rate by Role</h2><div class="stat-row">';
		for (var i = 0; i < roleOrder.length; i++) {
			var role = roleOrder[i];
			var rs = roleStats[role];
			if (rs && rs.games > 0) {
				var wr = rs.wins / rs.games;
				html += statBox(role, winrateSpan(wr) + '<div class="stat-sub">' + rs.games.toLocaleString() + ' games</div>');
			} else {
				html += statBox(role, '<span class="text-muted">-</span>');
			}
		}
		html += '</div>';
		return html;
	}

	function buildHeroRows(heroes, minGames, useFiltered, partyFilter) {
		var showAllPartyWr = !partyFilter && !useFiltered;
		var searchTerm = (filters.search || "").toLowerCase();
		var rows = [];
		var names = Object.keys(heroes);

		// Count total games for pick rate
		var totalGames = 0;
		for (var i = 0; i < names.length; i++) {
			var h = heroes[names[i]];
			if (partyFilter && !useFiltered) {
				var pd = (h.byPartySize || {})[partyFilter];
				if (pd && pd.games >= minGames) totalGames += pd.games;
			} else {
				if (h.games >= minGames) totalGames += h.games;
			}
		}

		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			var h = heroes[name];
			var role = heroRoles[name] || "Unknown";
			if (searchTerm && name.toLowerCase().indexOf(searchTerm) === -1 && role.toLowerCase().indexOf(searchTerm) === -1) continue;

			var games = h.games;
			var wins = h.wins;
			var losses = h.losses;
			var winrate = h.winrate;
			var avg = h.averages || null;

			// Use party-specific counts when filtering by party size with pre-computed data
			if (partyFilter && !useFiltered) {
				var pd = (h.byPartySize || {})[partyFilter];
				if (!pd || pd.games === 0) continue;
				games = pd.games;
				wins = pd.wins;
				losses = pd.games - pd.wins;
				winrate = pd.winrate;
				avg = pd.averages || null;
			}

			if (games < minGames) continue;

			var row = {
				hero: name,
				role: role,
				pickRate: totalGames > 0 ? games / totalGames : 0,
				games: games,
				wins: wins,
				losses: losses,
				winrate: winrate,
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
				durationMin: h.durationMin || null,
				durationMax: h.durationMax || null,
				durationAvg: h.averageDurationSeconds || null,
				lastPlayed: h.lastPlayed || null
			};

			if (showAllPartyWr) {
				var byParty = h.byPartySize || {};
				row.wrSolo = byParty["1"] ? byParty["1"].winrate : null;
				row.wrDuo = byParty["2"] ? byParty["2"].winrate : null;
				row.wr3s = byParty["3"] ? byParty["3"].winrate : null;
				row.wr4s = byParty["4"] ? byParty["4"].winrate : null;
				row.wr5s = byParty["5"] ? byParty["5"].winrate : null;
			}

			rows.push(row);
		}
		return rows;
	}

	function buildMapRows(maps, minGames) {
		var rows = [];
		var totalGames = 0;
		var names = Object.keys(maps);
		for (var i = 0; i < names.length; i++) {
			if (maps[names[i]].games >= minGames) totalGames += maps[names[i]].games;
		}
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			var m = maps[name];
			if (m.games < minGames) continue;
			var avg = m.averages || {};
			rows.push({
				map: name,
				mapType: TableConfig.mapType(name),
				mapTypeSortValue: TableConfig.mapTypeSortValue(name),
				pickRate: totalGames > 0 ? m.games / totalGames : 0,
				games: m.games,
				wins: m.wins,
				losses: m.losses,
				winrate: m.winrate,
				kills: avg.kills,
				deaths: avg.deaths,
				assists: avg.assists,
				kda: avg.kda,
				heroDamage: avg.heroDamage != null ? avg.heroDamage : null,
				siegeDamage: avg.siegeDamage != null ? avg.siegeDamage : null,
				healing: avg.healing != null ? avg.healing : null,
				selfHealing: avg.selfHealing != null ? avg.selfHealing : null,
				damageTaken: avg.damageTaken != null ? avg.damageTaken : null,
				xpContribution: avg.xpContribution != null ? avg.xpContribution : null,
				mercCaptures: avg.mercCaptures != null ? avg.mercCaptures : null,
				timeSpentDead: avg.timeSpentDead != null ? avg.timeSpentDead : null,
				durationMin: m.durationMin || null,
				durationMax: m.durationMax || null,
				durationAvg: m.averageDurationSeconds,
				lastPlayed: m.lastPlayed || null
			});
		}
		return rows;
	}

	function renderPartySize(partySize) {
		var keys = Object.keys(partySize);
		keys.sort(function(a, b) { return Number(a) - Number(b); });

		var html = '<h2 class="section-title">Party Size</h2>' +
			'<div class="table-wrap"><table>' +
			'<thead><tr>' +
			'<th class="no-sort">Party</th>' +
			'<th class="no-sort num">Games</th>' +
			'<th class="no-sort num">Wins</th>' +
			'<th class="no-sort num">Losses</th>' +
			'<th class="no-sort num">Win Rate</th>' +
			'<th class="no-sort num">Avg K</th>' +
			'<th class="no-sort num">Avg D</th>' +
			'<th class="no-sort num">Avg A</th>' +
			'<th class="no-sort num">KDA</th>' +
			'<th class="no-sort num">Avg Duration</th>' +
			'</tr></thead><tbody>';

		for (var i = 0; i < keys.length; i++) {
			var key = keys[i];
			var s = partySize[key];
			var label = PARTY_LABELS[Number(key)] || key + "-stack";
			html += '<tr>' +
				'<td>' + escapeHtml(label) + '</td>' +
				'<td class="num">' + s.games.toLocaleString() + '</td>' +
				'<td class="num">' + s.wins.toLocaleString() + '</td>' +
				'<td class="num">' + s.losses.toLocaleString() + '</td>' +
				'<td class="num">' + StandardTable.FORMAT.wr(s.winrate) + '</td>' +
				'<td class="num">' + StandardTable.FORMAT.dec(s.averages.kills) + '</td>' +
				'<td class="num">' + StandardTable.FORMAT.dec(s.averages.deaths) + '</td>' +
				'<td class="num">' + StandardTable.FORMAT.dec(s.averages.assists) + '</td>' +
				'<td class="num">' + StandardTable.FORMAT.kda(s.averages.kda) + '</td>' +
				'<td class="num">' + formatDuration(s.averageDurationSeconds) + '</td>' +
				'</tr>';
		}
		html += '</tbody></table></div>';
		return html;
	}

	function renderRecentMatches() {
		if (!recentMatchData || recentMatchData.length === 0) return '';

		var html = '<h2 class="section-title">Recent Matches</h2>' +
			'<div class="table-wrap"><table id="recent-matches-table">' +
			'<thead><tr>' +
			'<th class="no-sort">Hero</th>' +
			'<th class="no-sort">Talents</th>' +
			'<th class="no-sort">Map</th>' +
			'<th class="no-sort">Mode</th>' +
			'<th class="no-sort num">Result</th>' +
			'<th class="no-sort num">Duration</th>' +
			'<th class="no-sort">Date</th>' +
			'<th class="no-sort">Match</th>' +
			'</tr></thead><tbody>';

		for (var i = 0; i < recentMatchData.length; i++) {
			var match = recentMatchData[i];
			var playerEntry = null;
			for (var j = 0; j < match.players.length; j++) {
				if (match.players[j].rosterName === playerName) {
					playerEntry = match.players[j];
					break;
				}
			}
			if (!playerEntry) continue;

			var resultClass = playerEntry.result === "win" ? "win" : "loss";
			var resultText = playerEntry.result === "win" ? "Victory" : "Defeat";

			var talents = playerEntry.talentChoices || [];
			var talentParts = [];
			for (var t = 0; t < 7; t++) {
				talentParts.push(talents[t] && talents[t] > 0 ? String(talents[t]) : "-");
			}

			html += '<tr>' +
				'<td><a href="' + appLink('/hero/' + slugify(playerEntry.hero)) + '">' + escapeHtml(playerEntry.hero) + '</a></td>' +
				'<td class="talent-build">' + escapeHtml(talentParts.join("/")) + '</td>' +
				'<td><a href="' + appLink('/map/' + slugify(match.map)) + '">' + escapeHtml(displayMapName(match.map)) + '</a></td>' +
				'<td>' + escapeHtml(displayModeName(match.gameMode)) + '</td>' +
				'<td class="num ' + resultClass + '">' + resultText + '</td>' +
				'<td class="num">' + formatDuration(match.durationSeconds) + '</td>' +
				'<td>' + formatDateFinnish(match.timestamp) + '</td>' +
				'<td><a href="' + appLink('/match/' + match.matchId) + '">Details</a></td>' +
				'</tr>';
		}

		html += '</tbody></table></div>';
		html += '<div class="recent-matches-footer">' +
			'<a href="' + appLink('/matches') + '?pi=' + encodeURIComponent(playerName) + '" class="btn">View match history</a>' +
			'</div>';
		return html;
	}

	function renderContent() {
		var app = document.getElementById("app");
		var minGames = filters.minGames !== "" ? Number(filters.minGames) : 0;
		var useFiltered = hasDataFilters();
		var mask = getMask();

		var heroes = useFiltered ? computeFilteredHeroes() : playerData.heroes;
		var partyFilter = (!useFiltered && filters.partySize) ? filters.partySize : null;

		var o = aggregateHeroes(heroes, minGames, partyFilter);

		// Party context for the hero table's win rate segment
		var partyLabels = { "1": "Solo", "2": "Duo", "3": "3S", "4": "4S", "5": "5S" };
		var partyContext = null;
		if (partyFilter) {
			partyContext = { showAll: false, filterLabel: partyLabels[partyFilter] || "Avg" };
		} else if (!useFiltered) {
			partyContext = { showAll: true, filterLabel: null };
		}

		var heroRows = buildHeroRows(heroes, minGames, useFiltered, partyFilter);
		var heroTable = StandardTable.create("player-heroes", heroRows, { mask: mask, partyContext: partyContext });

		var html =
			'<div class="page-header"><h1>' + escapeHtml(playerData.name) + '</h1>' +
			'<div class="subtitle">' + o.games.toLocaleString() + ' out of ' +
			playerData.overall.games.toLocaleString() + ' games</div></div>';

		html += buildPageFilterBar(filters, {
			mode: true, mapOptions: getAvailableMaps(), partySize: true,
			dateFrom: true, dateTo: true, minGames: true,
			search: true, searchPlaceholder: "e.g. Murky"
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

		html += renderRoleWinrates(heroes, partyFilter, minGames);
		html += '<h2 class="section-title">Heroes</h2>';
		html += heroTable.buildToggles();
		html += heroTable.buildHTML();

		var mapTable = null;
		if (!useFiltered) {
			var mapRows = buildMapRows(playerData.maps, minGames);
			mapTable = StandardTable.create("player-maps", mapRows, { mask: mask });
			html += '<h2 class="section-title">Maps</h2>';
			html += mapTable.buildToggles();
			html += mapTable.buildHTML();
		}

		if (!useFiltered) {
			html += renderPartySize(playerData.partySize);
		}

		html += renderRecentMatches();

		app.innerHTML = html;
		var onMaskChange = function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["player-heroes"].defaultMask);
			renderContent();
		};
		heroTable.attachListeners(app, onMaskChange);
		if (mapTable) {
			mapTable.attachListeners(app, onMaskChange);
		}
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
		app.innerHTML = '<div class="loading">Loading player...</div>';
		currentMask = null;

		var keys = Object.keys(defaults);
		for (var i = 0; i < keys.length; i++) {
			filters[keys[i]] = defaults[keys[i]];
		}

		try {
			var results = await Promise.all([Data.player(slug), Data.matchIndex(), Data.summary(), Data.settings()]);
			playerData = results[0];
			matchIndex = results[1];
			heroRoles = results[2].heroRoles || {};
			playerName = playerData.name;
			defaults.minGames = String(AppSettings.minGamesDefault);
			filters.minGames = defaults.minGames;
			readFiltersFromURL(filters, defaults);
			var fromURL = StandardTable.readMaskFromURL();
			if (fromURL != null) currentMask = fromURL;

			// Load recent match files for talent build data
			var recentCount = AppSettings.recentMatchesCount || 5;
			var playerMatches = [];
			for (var i = 0; i < matchIndex.length && playerMatches.length < recentCount; i++) {
				var m = matchIndex[i];
				for (var j = 0; j < m.rosterPlayers.length; j++) {
					if (m.rosterPlayers[j].name === playerName) {
						playerMatches.push(m);
						break;
					}
				}
			}
			var matchPromises = [];
			for (var i = 0; i < playerMatches.length; i++) {
				matchPromises.push(Data.match(playerMatches[i].matchId));
			}
			recentMatchData = await Promise.all(matchPromises);

			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Player not found.</div>';
		}
	}

	return { render: render };
})();
