// Draft tool: hero selection with conditional winrate recommendations from match history
var DraftView = (function() {
	var filters = { mode: "", map: "", dateFrom: "", dateTo: "", seasons: "" };
	var defaults = { mode: "", map: "", dateFrom: "", dateTo: "", seasons: "" };
	var rawMatchIndex = null;
	var aramMaps = [];
	var matchData = null;
	var allHeroes = [];
	var allyPicks = ["", "", "", "", ""];
	var opponentPicks = ["", "", "", "", ""];

	// Pre-process match index into roster/opponent hero lookups for fast filtering
	function prepareMatchData(matchIndex) {
		matchData = [];
		var heroSet = {};
		for (var i = 0; i < matchIndex.length; i++) {
			var m = matchIndex[i];
			var rosterTeamId = null;
			for (var t in m.teams) {
				for (var j = 0; j < m.teams[t].length; j++) {
					if (m.teams[t][j].isRoster) {
						rosterTeamId = t;
						break;
					}
				}
				if (rosterTeamId !== null) break;
			}
			if (rosterTeamId === null) continue;

			var oppTeamId = rosterTeamId === "0" ? "1" : "0";
			var rosterHeroes = {};
			var opponentHeroes = {};
			var rTeam = m.teams[rosterTeamId] || [];
			var oTeam = m.teams[oppTeamId] || [];
			for (var j = 0; j < rTeam.length; j++) {
				rosterHeroes[rTeam[j].hero] = true;
				heroSet[rTeam[j].hero] = true;
			}
			for (var j = 0; j < oTeam.length; j++) {
				opponentHeroes[oTeam[j].hero] = true;
				heroSet[oTeam[j].hero] = true;
			}

			// Store per-hero stats from roster players for combo aggregation
			var heroStats = {};
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				heroStats[rp.hero] = {
					kills: rp.kills || 0,
					deaths: rp.deaths || 0,
					assists: rp.assists || 0,
					heroDamage: rp.heroDamage || 0,
					siegeDamage: rp.siegeDamage || 0
				};
			}

			matchData.push({
				rosterHeroes: rosterHeroes,
				opponentHeroes: opponentHeroes,
				isWin: m.result === "win",
				heroStats: heroStats,
				durationSeconds: m.durationSeconds
			});
		}
		allHeroes = Object.keys(heroSet).sort();
	}

	function getAvailableMaps() {
		var mapSet = {};
		for (var i = 0; i < rawMatchIndex.length; i++) {
			mapSet[rawMatchIndex[i].map] = true;
		}
		var maps = Object.keys(mapSet).sort();
		if (filters.mode === "StormLeague") {
			return maps.filter(function(m) { return aramMaps.indexOf(m) === -1; });
		}
		return maps;
	}

	function applyFilters() {
		var filtered = MatchIndexUtils.filter(rawMatchIndex, filters);
		prepareMatchData(filtered);
		var heroSet = {};
		for (var i = 0; i < allHeroes.length; i++) heroSet[allHeroes[i]] = true;
		for (var i = 0; i < allyPicks.length; i++) {
			if (allyPicks[i] && !heroSet[allyPicks[i]]) allyPicks[i] = "";
		}
		for (var i = 0; i < opponentPicks.length; i++) {
			if (opponentPicks[i] && !heroSet[opponentPicks[i]]) opponentPicks[i] = "";
		}
	}

	function computeRecommendations() {
		var pickedSet = {};
		for (var i = 0; i < allyPicks.length; i++) {
			if (allyPicks[i]) pickedSet[allyPicks[i]] = true;
		}
		for (var i = 0; i < opponentPicks.length; i++) {
			if (opponentPicks[i]) pickedSet[opponentPicks[i]] = true;
		}

		var allyStats = {};
		var oppStats = {};
		var matchedCount = 0;

		for (var i = 0; i < matchData.length; i++) {
			var md = matchData[i];

			var allyMatch = true;
			for (var j = 0; j < allyPicks.length; j++) {
				if (allyPicks[j] && !md.rosterHeroes[allyPicks[j]]) {
					allyMatch = false;
					break;
				}
			}
			if (!allyMatch) continue;

			var oppMatch = true;
			for (var j = 0; j < opponentPicks.length; j++) {
				if (opponentPicks[j] && !md.opponentHeroes[opponentPicks[j]]) {
					oppMatch = false;
					break;
				}
			}
			if (!oppMatch) continue;

			matchedCount++;
			var hero;

			for (hero in md.rosterHeroes) {
				if (pickedSet[hero]) continue;
				if (!allyStats[hero]) allyStats[hero] = { games: 0, wins: 0 };
				allyStats[hero].games++;
				if (md.isWin) allyStats[hero].wins++;
			}

			for (hero in md.opponentHeroes) {
				if (pickedSet[hero]) continue;
				if (!oppStats[hero]) oppStats[hero] = { games: 0, wins: 0 };
				oppStats[hero].games++;
				if (md.isWin) oppStats[hero].wins++;
			}
		}

		var minRec = AppSettings.draft.minGamesForRecommendation;
		var allyRecs = [];
		for (var h in allyStats) {
			var s = allyStats[h];
			if (s.games >= minRec) {
				allyRecs.push({ hero: h, games: s.games, wins: s.wins, winrate: s.wins / s.games });
			}
		}
		var oppRecs = [];
		for (var h in oppStats) {
			var s = oppStats[h];
			if (s.games >= minRec) {
				oppRecs.push({ hero: h, games: s.games, wins: s.wins, winrate: s.wins / s.games });
			}
		}

		var byWrDesc = function(a, b) { return b.winrate - a.winrate || b.games - a.games; };
		var byWrAsc = function(a, b) { return a.winrate - b.winrate || b.games - a.games; };

		return {
			matchedCount: matchedCount,
			bestPicks: allyRecs.slice().sort(byWrDesc).slice(0, AppSettings.draft.topRecommendations),
			avoid: allyRecs.slice().sort(byWrAsc).slice(0, AppSettings.draft.topRecommendations),
			scariestPicks: oppRecs.slice().sort(byWrAsc).slice(0, AppSettings.draft.topRecommendations),
			freeWins: oppRecs.slice().sort(byWrDesc).slice(0, AppSettings.draft.topRecommendations)
		};
	}

	// Compute combo stats for selected heroes on a given side
	function computeComboStats(side) {
		var picks = side === "ally" ? allyPicks : opponentPicks;
		var selectedHeroes = [];
		for (var i = 0; i < picks.length; i++) {
			if (picks[i]) selectedHeroes.push(picks[i]);
		}
		if (selectedHeroes.length < AppSettings.draft.minHeroesForCombo) return null;

		var combo = {
			heroes: selectedHeroes,
			games: 0,
			wins: 0,
			losses: 0,
			// Per-hero aggregates within the combo
			perHero: {}
		};
		for (var i = 0; i < selectedHeroes.length; i++) {
			combo.perHero[selectedHeroes[i]] = {
				totalKills: 0, totalDeaths: 0, totalAssists: 0,
				totalHeroDamage: 0, totalSiegeDamage: 0
			};
		}

		for (var i = 0; i < matchData.length; i++) {
			var md = matchData[i];
			var pool = side === "ally" ? md.rosterHeroes : md.opponentHeroes;

			var allPresent = true;
			for (var j = 0; j < selectedHeroes.length; j++) {
				if (!pool[selectedHeroes[j]]) {
					allPresent = false;
					break;
				}
			}
			if (!allPresent) continue;

			combo.games++;
			// For ally combos, win = roster win. For opponent combos, win = roster win (we beat them).
			if (md.isWin) combo.wins++;
			else combo.losses++;

			// Only aggregate per-hero stats for ally combos (we have roster player stats)
			if (side === "ally") {
				for (var j = 0; j < selectedHeroes.length; j++) {
					var hero = selectedHeroes[j];
					var hs = md.heroStats[hero];
					if (!hs) continue;
					var ph = combo.perHero[hero];
					ph.totalKills += hs.kills;
					ph.totalDeaths += hs.deaths;
					ph.totalAssists += hs.assists;
					ph.totalHeroDamage += hs.heroDamage;
					ph.totalSiegeDamage += hs.siegeDamage;
				}
			}
		}

		if (combo.games === 0) return null;

		combo.winrate = combo.wins / combo.games;

		// Finalize per-hero averages (ally side only)
		if (side === "ally") {
			for (var i = 0; i < selectedHeroes.length; i++) {
				var hero = selectedHeroes[i];
				var ph = combo.perHero[hero];
				ph.avgKills = ph.totalKills / combo.games;
				ph.avgDeaths = ph.totalDeaths / combo.games;
				ph.avgAssists = ph.totalAssists / combo.games;
				ph.avgHeroDamage = ph.totalHeroDamage / combo.games;
				ph.avgSiegeDamage = ph.totalSiegeDamage / combo.games;
				ph.kda = ph.totalDeaths > 0
					? (ph.totalKills + ph.totalAssists) / ph.totalDeaths
					: 0;
			}
		}

		return combo;
	}

	function availableHeroes(currentValue) {
		var picked = {};
		for (var i = 0; i < allyPicks.length; i++) {
			if (allyPicks[i] && allyPicks[i] !== currentValue) picked[allyPicks[i]] = true;
		}
		for (var i = 0; i < opponentPicks.length; i++) {
			if (opponentPicks[i] && opponentPicks[i] !== currentValue) picked[opponentPicks[i]] = true;
		}
		var result = [];
		for (var i = 0; i < allHeroes.length; i++) {
			if (!picked[allHeroes[i]]) result.push(allHeroes[i]);
		}
		return result;
	}

	function readDraftPicksFromURL() {
		var params = new URLSearchParams(window.location.search);
		if (params.has("ap")) {
			var parts = params.get("ap").split(",");
			for (var i = 0; i < 5; i++) {
				allyPicks[i] = (i < parts.length) ? parts[i] : "";
			}
		}
		if (params.has("op")) {
			var parts = params.get("op").split(",");
			for (var i = 0; i < 5; i++) {
				opponentPicks[i] = (i < parts.length) ? parts[i] : "";
			}
		}
	}

	function writeDraftPicksToURL() {
		var params = new URLSearchParams(window.location.search);
		var hasAlly = false, hasOpp = false;
		for (var i = 0; i < 5; i++) {
			if (allyPicks[i]) hasAlly = true;
			if (opponentPicks[i]) hasOpp = true;
		}
		if (hasAlly) params.set("ap", allyPicks.join(","));
		else params.delete("ap");
		if (hasOpp) params.set("op", opponentPicks.join(","));
		else params.delete("op");
		var qs = params.toString();
		history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
	}

	function renderHeroSelect(id, value) {
		var options = availableHeroes(value);
		var html = '<select id="' + id + '" class="draft-hero-select">' +
			'<option value="">-- Select Hero --</option>';
		for (var i = 0; i < options.length; i++) {
			var h = options[i];
			html += '<option value="' + escapeHtml(h) + '"' +
				(h === value ? ' selected' : '') + '>' + escapeHtml(h) + '</option>';
		}
		html += '</select>';
		return html;
	}

	function renderRecPanel(title, description, entries, side) {
		var html = '<div class="draft-rec-panel card">' +
			'<div class="draft-rec-title">' + escapeHtml(title) + '</div>' +
			'<div class="draft-rec-desc text-muted">' + escapeHtml(description) + '</div>';

		if (entries.length === 0) {
			html += '<div class="text-muted">Not enough data</div>';
		} else {
			html += '<div class="draft-rec-list">';
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				var cls = e.games < AppSettings.draft.lowConfidenceThreshold ? ' draft-low-conf' : '';
				html += '<div class="draft-rec-entry' + cls + '">' +
					'<span class="draft-rec-rank">' + (i + 1) + '</span>' +
					'<a href="' + appLink('/hero/' + slugify(e.hero)) + '">' + heroIconHtml(e.hero) + escapeHtml(e.hero) + '</a> ' +
					winrateSpan(e.winrate) +
					' <span class="text-muted">(' + e.games + ' games)</span>' +
					'<button class="draft-add-btn" data-hero="' + escapeHtml(e.hero) + '" data-side="' + side + '">+Add</button>' +
					'</div>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}

	function renderComboPanel(combo, side) {
		if (!combo) return '';

		var label = side === "ally" ? "Your Combo" : "vs. Opponent Combo";
		var desc = side === "ally"
			? "Stats when these heroes play together on your team."
			: "Your win rate when facing this hero combination.";

		var html = '<div class="draft-combo-panel card">' +
			'<div class="draft-rec-title">' + escapeHtml(label) + '</div>' +
			'<div class="draft-rec-desc text-muted">' + escapeHtml(desc) + '</div>';

		html += '<div class="draft-combo-summary">' +
			'<div class="draft-combo-stat">' +
			'<span class="draft-combo-stat-label">Games</span>' +
			'<span class="draft-combo-stat-value">' + combo.games.toLocaleString() + '</span>' +
			'</div>' +
			'<div class="draft-combo-stat">' +
			'<span class="draft-combo-stat-label">Win Rate</span>' +
			'<span class="draft-combo-stat-value">' + winrateSpan(combo.winrate) + '</span>' +
			'</div>' +
			'<div class="draft-combo-stat">' +
			'<span class="draft-combo-stat-label">Wins</span>' +
			'<span class="draft-combo-stat-value">' + combo.wins + '</span>' +
			'</div>' +
			'<div class="draft-combo-stat">' +
			'<span class="draft-combo-stat-label">Losses</span>' +
			'<span class="draft-combo-stat-value">' + combo.losses + '</span>' +
			'</div>' +
			'</div>';

		// Per-hero breakdown (ally combos only, since we have roster player stats)
		if (side === "ally") {
			html += '<div class="draft-combo-heroes">';
			html += '<div class="table-wrap"><table class="draft-combo-table">';
			html += '<thead><tr>' +
				'<th>Hero</th>' +
				'<th class="num">Avg K</th>' +
				'<th class="num">Avg D</th>' +
				'<th class="num">Avg A</th>' +
				'<th class="num">KDA</th>' +
				'<th class="num">Avg Hero Dmg</th>' +
				'<th class="num">Avg Siege Dmg</th>' +
				'</tr></thead><tbody>';

			for (var i = 0; i < combo.heroes.length; i++) {
				var hero = combo.heroes[i];
				var ph = combo.perHero[hero];
				html += '<tr>' +
					'<td><a href="' + appLink('/hero/' + slugify(hero)) + '">' + heroIconHtml(hero) + escapeHtml(hero) + '</a></td>' +
					'<td class="num">' + ph.avgKills.toFixed(1) + '</td>' +
					'<td class="num">' + ph.avgDeaths.toFixed(1) + '</td>' +
					'<td class="num">' + ph.avgAssists.toFixed(1) + '</td>' +
					'<td class="num">' + ph.kda.toFixed(2) + '</td>' +
					'<td class="num">' + formatNumber(Math.round(ph.avgHeroDamage)) + '</td>' +
					'<td class="num">' + formatNumber(Math.round(ph.avgSiegeDamage)) + '</td>' +
					'</tr>';
			}
			html += '</tbody></table></div>';
			html += '</div>';
		}

		html += '</div>';
		return html;
	}

	function renderContent() {
		var app = document.getElementById("app");
		var recs = computeRecommendations();
		var allyCombo = computeComboStats("ally");
		var oppCombo = computeComboStats("opponent");

		var html = '<div class="page-header"><h1>Draft Tool</h1>' +
			'<div class="subtitle">Hero recommendations based on ' +
			recs.matchedCount.toLocaleString() + ' matching games</div></div>';

		html += buildPageFilterBar(filters, {
			mode: true,
			modeOptions: [
				{ value: "StormLeague", label: "Storm League" },
				{ value: "Custom", label: "Custom" }
			],
			mapOptions: getAvailableMaps(),
			dateFrom: true, dateTo: true
		});

		html += '<div class="draft-layout">';

		// Your Team column
		html += '<div class="draft-column">' +
			'<div class="draft-column-header">' +
			'<h2 class="draft-column-title win">Your Team</h2>' +
			'<button class="btn btn-reset draft-clear" data-side="ally">Clear</button>' +
			'</div>' +
			'<div class="draft-picks">';
		for (var i = 0; i < 5; i++) {
			html += renderHeroSelect('ally-' + i, allyPicks[i]);
		}
		html += '</div>';
		html += renderComboPanel(allyCombo, "ally");
		html += '<div class="draft-recs">';
		html += renderRecPanel("Highest Win Rate", "Heroes on your team with the best win rate in matching games.", recs.bestPicks, "ally");
		html += renderRecPanel("Lowest Win Rate", "Heroes on your team with the worst win rate in matching games.", recs.avoid, "ally");
		html += '</div></div>';

		// Opposing Team column
		html += '<div class="draft-column">' +
			'<div class="draft-column-header">' +
			'<h2 class="draft-column-title loss">Opposing Team</h2>' +
			'<button class="btn btn-reset draft-clear" data-side="opponent">Clear</button>' +
			'</div>' +
			'<div class="draft-picks">';
		for (var i = 0; i < 5; i++) {
			html += renderHeroSelect('opp-' + i, opponentPicks[i]);
		}
		html += '</div>';
		html += renderComboPanel(oppCombo, "opponent");
		html += '<div class="draft-recs">';
		html += renderRecPanel("Instant Loss", "Enemy heroes your roster struggles the most against.", recs.scariestPicks, "opponent");
		html += renderRecPanel("Free Wins", "Enemy heroes your roster beats the most.", recs.freeWins, "opponent");
		html += '</div></div>';

		html += '</div>';

		app.innerHTML = html;
		attachListeners();
		attachPageFilterListeners(app, filters, defaults, function() {
			if (filters.map) {
				var validMaps = getAvailableMaps();
				if (validMaps.indexOf(filters.map) === -1) filters.map = "";
			}
			applyFilters();
			renderContent();
		});
		writeDraftPicksToURL();
	}

	function attachListeners() {
		var app = document.getElementById("app");

		for (var i = 0; i < 5; i++) {
			(function(idx) {
				var allySelect = app.querySelector('#ally-' + idx);
				var oppSelect = app.querySelector('#opp-' + idx);
				if (allySelect) {
					allySelect.addEventListener('change', function() {
						allyPicks[idx] = this.value;
						renderContent();
					});
				}
				if (oppSelect) {
					oppSelect.addEventListener('change', function() {
						opponentPicks[idx] = this.value;
						renderContent();
					});
				}
			})(i);
		}

		var clearBtns = app.querySelectorAll('.draft-clear');
		for (var i = 0; i < clearBtns.length; i++) {
			clearBtns[i].addEventListener('click', function() {
				if (this.getAttribute('data-side') === 'ally') {
					allyPicks = ["", "", "", "", ""];
				} else {
					opponentPicks = ["", "", "", "", ""];
				}
				renderContent();
			});
		}

		var addBtns = app.querySelectorAll('.draft-add-btn');
		for (var i = 0; i < addBtns.length; i++) {
			addBtns[i].addEventListener('click', function() {
				var hero = this.getAttribute('data-hero');
				var picks = this.getAttribute('data-side') === 'ally' ? allyPicks : opponentPicks;
				for (var j = 0; j < 5; j++) {
					if (!picks[j]) {
						picks[j] = hero;
						renderContent();
						return;
					}
				}
			});
		}

		var resetBtn = app.querySelector('.page-filter-reset');
		if (resetBtn) {
			resetBtn.addEventListener('click', function() {
				allyPicks = ["", "", "", "", ""];
				opponentPicks = ["", "", "", "", ""];
			});
		}
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading Draft Tool...</div>';

		allyPicks = ["", "", "", "", ""];
		opponentPicks = ["", "", "", "", ""];

		var keys = Object.keys(defaults);
		for (var i = 0; i < keys.length; i++) {
			filters[keys[i]] = defaults[keys[i]];
		}

		try {
			var results = await Promise.all([Data.matchIndex(), Data.summary(), Data.settings()]);
			rawMatchIndex = results[0];
			aramMaps = results[1].aramMaps || [];
			readFiltersFromURL(filters, defaults);
			readDraftPicksFromURL();
			applyFilters();
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load match data.</div>';
		}
	}

	return { render: render };
})();
