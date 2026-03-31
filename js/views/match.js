// Match detail page: full 10-player scoreboard with stats, talents, team composition
var MatchView = (function() {
	// Key stats to show in the scoreboard columns
	var STAT_COLS = [
		{ key: "kills", label: "K" },
		{ key: "assists", label: "A" },
		{ key: "deaths", label: "D" },
		{ key: "kda", label: "KDA" },
		{ key: "heroDamage", label: "Hero Dmg" },
		{ key: "siegeDamage", label: "Siege Dmg" },
		{ key: "healing", label: "Healing" },
		{ key: "damageTaken", label: "Dmg Taken" },
		{ key: "xpContribution", label: "XP" },
		{ key: "timeSpentDead", label: "Dead Time" }
	];

	function formatDate(ts) {
		var d = new Date(ts);
		return String(d.getDate()).padStart(2, "0") + "/" +
			String(d.getMonth() + 1).padStart(2, "0") + "/" +
			d.getFullYear() + " " +
			String(d.getHours()).padStart(2, "0") + ":" +
			String(d.getMinutes()).padStart(2, "0");
	}

	function formatStatValue(key, value) {
		if (key === "kda") return value.toFixed(2);
		if (key === "timeSpentDead") return formatDuration(value);
		if (typeof value === "number") return formatNumber(value);
		return String(value);
	}

	function buildTalentCells(player) {
		var html = "";
		var choices = player.talentChoices || [];
		for (var t = 0; t < 7; t++) {
			var choice = t < choices.length ? choices[t] : null;
			// Choice 0 means no pick at that tier (game ended before reaching it)
			if (choice === null || choice === 0) {
				html += '<td class="talent-cell">-</td>';
			} else {
				html += '<td class="talent-cell">' + choice + '</td>';
			}
		}
		return html;
	}

	function buildTeamTable(players, teamIndex, rosterLookup) {
		var teamResult = players.length > 0 ? players[0].result : "unknown";
		var resultClass = teamResult === "win" ? "win" : (teamResult === "loss" ? "loss" : "");
		var resultLabel = teamResult === "win" ? "Victory" : (teamResult === "loss" ? "Defeat" : teamResult);

		var html = '<div class="section-title">Team ' + (teamIndex + 1) +
			' <span class="' + resultClass + '">' + escapeHtml(resultLabel) + '</span></div>';

		html += '<div class="table-wrap"><table><thead><tr>' +
			'<th class="no-sort">Player</th>' +
			'<th class="no-sort">Hero</th>';

		for (var c = 0; c < STAT_COLS.length; c++) {
			html += '<th class="no-sort">' + STAT_COLS[c].label + '</th>';
		}

		// Talent tier headers
		var tierLevels = [1, 4, 7, 10, 13, 16, 20];
		for (var t = 0; t < tierLevels.length; t++) {
			html += '<th class="no-sort talent-cell">T' + tierLevels[t] + '</th>';
		}

		html += '</tr></thead><tbody>';

		for (var i = 0; i < players.length; i++) {
			var p = players[i];
			var s = p.stats || {};
			var isRoster = p.isRoster;

			// Player name: link to player page if roster, otherwise plain text
			var nameHtml;
			if (isRoster && p.rosterName && rosterLookup[p.rosterName]) {
				nameHtml = '<a href="' + appLink('/player/' + rosterLookup[p.rosterName]) + '">' +
					escapeHtml(p.name) + '</a>';
			} else {
				nameHtml = escapeHtml(p.name);
			}
			if (isRoster) {
				nameHtml = '<strong>' + nameHtml + '</strong>';
			}

			// Hero name: link to hero page
			var heroSlug = slugify(p.hero);
			var heroHtml = '<a href="' + appLink('/hero/' + heroSlug) + '">' + escapeHtml(p.hero) + '</a>';

			// Party indicator
			if (p.partySize && p.partySize > 1) {
				nameHtml += ' <span class="text-muted party-badge">' + p.partySize + '-stack</span>';
			}

			html += '<tr class="' + (isRoster ? "roster-player-row" : "") + '">';
			html += '<td>' + nameHtml + '</td>';
			html += '<td>' + heroHtml + '</td>';

			for (var c = 0; c < STAT_COLS.length; c++) {
				var val = s[STAT_COLS[c].key];
				var display = val !== undefined ? formatStatValue(STAT_COLS[c].key, val) : "-";
				html += '<td class="num">' + display + '</td>';
			}

			html += buildTalentCells(p);
			html += '</tr>';
		}

		html += '</tbody>';

		// Team totals row
		var totals = {};
		for (var c = 0; c < STAT_COLS.length; c++) {
			totals[STAT_COLS[c].key] = 0;
		}
		for (var i = 0; i < players.length; i++) {
			var s = players[i].stats || {};
			for (var c = 0; c < STAT_COLS.length; c++) {
				var key = STAT_COLS[c].key;
				if (key === "kda") continue; // Compute separately
				totals[key] += s[key] || 0;
			}
		}
		// KDA for team total
		totals.kda = totals.deaths > 0 ? (totals.kills + totals.assists) / totals.deaths : totals.kills + totals.assists;

		html += '<tfoot><tr class="team-total-row"><td colspan="2"><strong>Total</strong></td>';
		for (var c = 0; c < STAT_COLS.length; c++) {
			html += '<td class="num"><strong>' + formatStatValue(STAT_COLS[c].key, totals[STAT_COLS[c].key]) + '</strong></td>';
		}
		// Empty talent cells for totals row
		for (var t = 0; t < 7; t++) {
			html += '<td></td>';
		}
		html += '</tr></tfoot>';

		html += '</table></div>';
		return html;
	}

	async function render(id) {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading match...</div>';

		try {
			var results = await Promise.all([Data.match(id), Data.roster()]);
			var data = results[0];
			var roster = results[1];

			// Build roster name to slug lookup
			var rosterLookup = {};
			for (var i = 0; i < roster.players.length; i++) {
				rosterLookup[roster.players[i].name] = roster.players[i].slug;
			}

			// Split players into teams
			var teams = [[], []];
			for (var i = 0; i < data.players.length; i++) {
				var teamIdx = data.players[i].team;
				if (teamIdx === 0 || teamIdx === 1) {
					teams[teamIdx].push(data.players[i]);
				}
			}

			// Determine which team the roster is on (for display order)
			var rosterTeam = 0;
			for (var i = 0; i < data.players.length; i++) {
				if (data.players[i].isRoster) {
					rosterTeam = data.players[i].team;
					break;
				}
			}
			// Show roster team first
			var teamOrder = rosterTeam === 1 ? [1, 0] : [0, 1];

			// Match header
			var resultText = "";
			for (var i = 0; i < data.players.length; i++) {
				if (data.players[i].isRoster) {
					resultText = data.players[i].result === "win" ? "Victory" : "Defeat";
					break;
				}
			}
			// If no roster players, show the game result without bias
			if (!resultText && data.players.length > 0) {
				resultText = "Completed";
			}

			var resultClass = resultText === "Victory" ? "win" : (resultText === "Defeat" ? "loss" : "");

			var mapSlug = slugify(data.map);
			var html = '<div class="page-header">' +
				'<h1><a href="' + appLink('/map/' + mapSlug) + '">' + escapeHtml(displayMapName(data.map)) + '</a></h1>' +
				'<div class="subtitle">' +
				escapeHtml(formatDate(data.timestamp)) +
				' | ' + escapeHtml(displayModeName(data.gameMode)) +
				' | ' + formatDuration(data.durationSeconds) +
				' | Build ' + data.build +
				' | <span class="' + resultClass + '">' + escapeHtml(resultText) + '</span>' +
				'</div></div>';

			// Stat summary boxes
			html += '<div class="stat-row">';
			html += statBox("Map", '<a href="' + appLink('/map/' + mapSlug) + '">' + escapeHtml(displayMapName(data.map)) + '</a>');
			html += statBox("Mode", escapeHtml(displayModeName(data.gameMode)));
			html += statBox("Duration", formatDuration(data.durationSeconds));
			html += statBox("Date", formatDateFinnish(data.timestamp));
			html += '</div>';

			// Team scoreboards
			for (var t = 0; t < teamOrder.length; t++) {
				var idx = teamOrder[t];
				html += buildTeamTable(teams[idx], idx, rosterLookup);
			}

			// Back to match history link
			html += '<div style="margin-top:1.5rem;">' +
				'<a href="' + appLink('/matches') + '">Back to Match History</a>' +
				'</div>';

			app.innerHTML = html;
		} catch (err) {
			app.innerHTML = '<div class="error">Match not found.</div>';
		}
	}

	return { render: render };
})();
