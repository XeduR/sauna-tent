// Match detail page: full 10-player scoreboard with stats, talents, team composition
var MatchView = (function() {
	var talentData = null;
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

	// DD/MM/YYYY HH:MM for human-readable display. Tables use DD/MM/YYYY (formatDateFinnish).
	function formatDate(ts) {
		var d = new Date(ts);
		return String(d.getDate()).padStart(2, "0") + "/" +
			String(d.getMonth() + 1).padStart(2, "0") + "/" +
			d.getFullYear() + " " +
			String(d.getHours()).padStart(2, "0") + ":" +
			String(d.getMinutes()).padStart(2, "0");
	}

	function formatStatValue(key, value) {
		if (key === "kda") return value === Infinity ? "Perfect" : value.toFixed(2);
		if (key === "timeSpentDead") return formatDuration(value);
		if (typeof value === "number") return formatNumber(value);
		return String(value);
	}

	function fmtStat(key) {
		return function(v) {
			if (v == null) return "-";
			return formatStatValue(key, v);
		};
	}

	function fmtTalent(tierIdx) {
		return function(v, row) {
			if (!v || v === 0) return '<span class="text-muted">-</span>';
			return talentIconHtml(row.hero, tierIdx, v, talentData);
		};
	}

	function buildTeamTable(players, teamIndex, rosterLookup, teamLevels) {
		var teamResult = players.length > 0 ? players[0].result : "unknown";
		var resultClass = teamResult === "win" ? "win" : (teamResult === "loss" ? "loss" : "");
		var resultLabel = teamResult === "win" ? "Victory" : (teamResult === "loss" ? "Defeat" : teamResult);

		var levelHtml = "";
		if (teamLevels && teamLevels[String(teamIndex)]) {
			levelHtml = " (level " + teamLevels[String(teamIndex)] + ")";
		}

		var titleHtml = '<div class="section-title">Team ' + (teamIndex + 1) +
			' <span class="' + resultClass + '">' + escapeHtml(resultLabel) + '</span>' +
			escapeHtml(levelHtml) + '</div>';

		var tierLevels = [1, 4, 7, 10, 13, 16, 20];
		var rows = [];
		for (var i = 0; i < players.length; i++) {
			var p = players[i];
			var s = p.stats || {};
			var displayName = p.name;
			var slug = null;
			if (p.isRoster && p.rosterName && rosterLookup[p.rosterName]) {
				displayName = p.rosterName;
				slug = rosterLookup[p.rosterName];
			} else if (p.isAlt && p.altName && rosterLookup[p.altName]) {
				displayName = p.altName;
				slug = rosterLookup[p.altName];
			}
			var row = {
				name: displayName,
				hero: p.hero,
				isRoster: !!p.isRoster,
				isAlt: !!p.isAlt,
				rosterSlug: slug,
				partySize: p.partySize || 0
			};
			for (var c = 0; c < STAT_COLS.length; c++) {
				row[STAT_COLS[c].key] = s[STAT_COLS[c].key] != null ? s[STAT_COLS[c].key] : null;
			}
			var choices = p.talentChoices || [];
			for (var t = 0; t < 7; t++) {
				row["t" + tierLevels[t]] = t < choices.length ? choices[t] : 0;
			}
			rows.push(row);
		}

		var columns = [
			{ key: "name", label: "Player", format: function(v, row) {
				var html;
				if (row.rosterSlug) {
					html = '<a href="' + appLink('/player/' + row.rosterSlug) + '">' + escapeHtml(v) + '</a>';
				} else {
					html = escapeHtml(v);
				}
				if (row.isRoster) html = '<strong>' + html + '</strong>';
				else if (row.isAlt) html += ' <span class="nav-alt-tag">alt</span>';
				if (row.partySize > 1) html += ' <span class="text-muted party-badge">' + row.partySize + '-stack</span>';
				return html;
			}},
			{ key: "hero", label: "Hero", format: function(v) {
				return '<a href="' + appLink('/hero/' + slugify(v)) + '">' + heroIconHtml(v) + escapeHtml(v) + '</a>';
			}}
		];

		for (var c = 0; c < STAT_COLS.length; c++) {
			columns.push({
				key: STAT_COLS[c].key,
				label: STAT_COLS[c].label,
				className: "num",
				format: fmtStat(STAT_COLS[c].key)
			});
		}

		for (var t = 0; t < tierLevels.length; t++) {
			columns.push({
				key: "t" + tierLevels[t],
				label: "T" + tierLevels[t],
				className: "talent-cell",
				noSort: true,
				format: fmtTalent(t)
			});
		}

		// Team totals footer
		var totals = {};
		for (var c = 0; c < STAT_COLS.length; c++) {
			totals[STAT_COLS[c].key] = 0;
		}
		for (var i = 0; i < players.length; i++) {
			var s = players[i].stats || {};
			for (var c = 0; c < STAT_COLS.length; c++) {
				var key = STAT_COLS[c].key;
				if (key === "kda") continue;
				totals[key] += s[key] || 0;
			}
		}
		totals.kda = totals.deaths > 0 ? (totals.kills + totals.assists) / totals.deaths : Infinity;

		var tfootHtml = '<tfoot><tr class="team-total-row"><td colspan="2"><strong>Total</strong></td>';
		for (var c = 0; c < STAT_COLS.length; c++) {
			tfootHtml += '<td class="num"><strong>' + formatStatValue(STAT_COLS[c].key, totals[STAT_COLS[c].key]) + '</strong></td>';
		}
		for (var t = 0; t < 7; t++) {
			tfootHtml += '<td></td>';
		}
		tfootHtml += '</tr></tfoot>';

		var tableId = "team-" + teamIndex + "-table";
		var table = sortableTable(tableId, columns, rows, "name", false, null, {
			rowClass: function(row) { return (row.isRoster || row.isAlt) ? "roster-player-row" : ""; },
			tfoot: tfootHtml
		});
		registerSortableTable(table);
		return titleHtml + table.buildHTML();
	}

	function buildDraftSection(draft) {
		if (!draft || draft.length === 0) return "";

		// Number bans and picks globally in event order so Ban #1/Pick #1 identify
		// the first ban/pick across the whole draft, not per-team.
		var byTeam = { 0: [], 1: [] };
		var banNum = 0;
		var pickNum = 0;
		var firstPickTeam = null;
		for (var i = 0; i < draft.length; i++) {
			var d = draft[i];
			if (d.team !== 0 && d.team !== 1) continue;
			var label;
			if (d.type === "ban") {
				banNum++;
				label = "Ban #" + banNum;
			} else {
				pickNum++;
				label = "Pick #" + pickNum;
				if (firstPickTeam === null) firstPickTeam = d.team;
			}
			byTeam[d.team].push({ type: d.type, hero: d.hero, label: label });
		}

		function buildEntry(entry) {
			var cls = "draft-entry" + (entry.type === "ban" ? " draft-ban" : "");
			return '<div class="' + cls + '">' +
				heroIconHtml(entry.hero, "lg") +
				'<span class="draft-label">' + entry.label + '</span>' +
				'</div>';
		}

		function buildTeamRow(teamIdx) {
			var entries = byTeam[teamIdx];
			var labelHtml = "Team " + (teamIdx + 1);
			if (teamIdx === firstPickTeam) {
				labelHtml += ' <span class="draft-first-pick">(first pick)</span>';
			}
			var entriesHtml = "";
			for (var i = 0; i < entries.length; i++) {
				entriesHtml += buildEntry(entries[i]);
			}
			return '<div class="draft-team-row">' +
				'<div class="draft-team-label">' + labelHtml + '</div>' +
				'<div class="draft-team">' + entriesHtml + '</div>' +
				'</div>';
		}

		var html = '<div class="section-title">Draft</div>';
		html += '<div class="draft-section">';
		html += buildTeamRow(0);
		html += buildTeamRow(1);
		html += '</div>';

		return html;
	}

	async function render(id) {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading match...</div>';

		try {
			var results = await Promise.all([Data.match(id), Data.roster(), Data.talentNames(), Data.talentDescriptions()]);
			var data = results[0];
			var roster = results[1];
			talentData = { names: results[2], descriptions: results[3] };

			// Build roster name to slug lookup (includes alts for clickable links)
			var rosterLookup = {};
			for (var i = 0; i < roster.players.length; i++) {
				rosterLookup[roster.players[i].name] = roster.players[i].slug;
			}
			if (roster.alts) {
				for (var ai = 0; ai < roster.alts.length; ai++) {
					rosterLookup[roster.alts[ai].name] = roster.alts[ai].slug;
				}
			}

			// Split players into teams
			var teams = [[], []];
			for (var i = 0; i < data.players.length; i++) {
				var teamIdx = data.players[i].team;
				if (teamIdx === 0 || teamIdx === 1) {
					teams[teamIdx].push(data.players[i]);
				}
			}

			// Determine which team the roster is on (for display order);
			// falls back to alt if the match has no true roster members.
			var rosterTeam = 0;
			var found = false;
			for (var i = 0; i < data.players.length; i++) {
				if (data.players[i].isRoster) {
					rosterTeam = data.players[i].team;
					found = true;
					break;
				}
			}
			if (!found) {
				for (var i = 0; i < data.players.length; i++) {
					if (data.players[i].isAlt) {
						rosterTeam = data.players[i].team;
						break;
					}
				}
			}
			// Show roster team first
			var teamOrder = rosterTeam === 1 ? [1, 0] : [0, 1];

			// Match header (roster perspective, falling back to alt)
			var resultText = "";
			for (var i = 0; i < data.players.length; i++) {
				if (data.players[i].isRoster) {
					resultText = data.players[i].result === "win" ? "Victory" : "Defeat";
					break;
				}
			}
			if (!resultText) {
				for (var i = 0; i < data.players.length; i++) {
					if (data.players[i].isAlt) {
						resultText = data.players[i].result === "win" ? "Victory" : "Defeat";
						break;
					}
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

			// Draft order (non-ARAM draft modes only)
			html += buildDraftSection(data.draft);

			// Team scoreboards
			for (var t = 0; t < teamOrder.length; t++) {
				var idx = teamOrder[t];
				html += buildTeamTable(teams[idx], idx, rosterLookup, data.teamLevels);
			}

			// Back to match history link
			html += '<div class="back-link">' +
				'<a href="' + appLink('/matches') + '">Back to Match History</a>' +
				'</div>';

			app.innerHTML = html;
			attachAllSortableListeners(app);
		} catch (err) {
			app.innerHTML = '<div class="error">Match not found.</div>';
		}
	}

	return { render: render };
})();
