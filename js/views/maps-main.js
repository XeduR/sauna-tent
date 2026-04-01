// Maps main page: all maps with filterable stats, sortable table
var MapsMainView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var currentMask = null;
	var currentWrl = null;

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["maps-main"].defaultMask;
	}

	function getWrl() {
		if (currentWrl != null) return currentWrl;
		return StandardTable.readWrlFromURL();
	}

	function renderContent(matchIndex) {
		var app = document.getElementById("app");
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var mapStats = MatchIndexUtils.groupByMap(filtered);
		var minGames = filters.minGames !== "" ? Number(filters.minGames) : 0;
		var mask = getMask();

		var t = aggregateGroup(mapStats, minGames);
		var totalGames = filtered.length;

		var html = '<div class="page-header"><h1>Maps</h1>' +
			'<div class="subtitle">' + filtered.length.toLocaleString() + ' out of ' +
			matchIndex.length.toLocaleString() + ' matches</div></div>';

		html += buildPageFilterBar(filters, { mode: true, partySize: true, dateFrom: true, dateTo: true, minGames: true, search: true, searchPlaceholder: "e.g. Infernal" });

		// Map table rows
		var rows = [];
		var searchTerm = (filters.search || "").toLowerCase();
		for (var map in mapStats) {
			var ms = mapStats[map];
			if (ms.games < minGames) continue;
			if (searchTerm && map.toLowerCase().indexOf(searchTerm) === -1) continue;
			var avg = ms.averages || null;
			var row = {
				map: map,
				mapType: TableConfig.mapType(map),
				mapTypeSortValue: TableConfig.mapTypeSortValue(map),
				pickRate: totalGames > 0 ? ms.games / totalGames : 0,
				games: ms.games,
				wins: ms.wins,
				losses: ms.losses,
				winrate: ms.winrate,
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
				durationMin: ms.durationMin,
				durationMax: ms.durationMax,
				durationAvg: ms.avgDuration,
				lastPlayed: ms.lastPlayed
			};
			StandardTable.addPartyWinrates(row, ms.byPartySize);
			rows.push(row);
		}

		var wrl = getWrl();
		var partyContext = wrl === "full" ? { showAll: true } : null;
		var table = StandardTable.create("maps-main", rows, { mask: mask, partyContext: partyContext, wrl: wrl });

		html += '<h2 class="section-title">All Maps</h2>';
		html += table.buildToggles();
		html += table.buildHTML();

		// Overall match factors and level lead
		var metaStats = MatchIndexUtils.computeMetaStats(filtered);
		var factorRows = [];
		var side = metaStats.teamSide;
		var fb = metaStats.firstBlood;
		var boss = metaStats.firstBoss;
		var merc = metaStats.firstMerc;
		if (side.left.games > 0 || side.right.games > 0) {
			factorRows.push(["Left Side", side.left]);
			factorRows.push(["Right Side", side.right]);
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

		// Per-map first capture win rates
		var captureRows = [];
		var mapNames = Object.keys(mapStats).sort();
		for (var mi = 0; mi < mapNames.length; mi++) {
			var mn = mapNames[mi];
			if (mapStats[mn].games < minGames) continue;
			if (searchTerm && mn.toLowerCase().indexOf(searchTerm) === -1) continue;

			// Filter matches for this map and compute meta stats
			var mapMatches = [];
			for (var fi = 0; fi < filtered.length; fi++) {
				if (filtered[fi].map === mn) mapMatches.push(filtered[fi]);
			}
			var ms = MatchIndexUtils.computeMetaStats(mapMatches);
			captureRows.push({
				map: mn,
				bossGot: ms.firstBoss.got,
				mercGot: ms.firstMerc.got,
			});
		}

		var hasCapture = false;
		for (var ci = 0; ci < captureRows.length; ci++) {
			if (captureRows[ci].bossGot.games > 0 || captureRows[ci].mercGot.games > 0) {
				hasCapture = true;
				break;
			}
		}
		if (hasCapture) {
			html += '<h2 class="section-title">First Capture Win Rate</h2>' +
				'<div class="table-wrap"><table>' +
				'<thead><tr>' +
				'<th class="no-sort">Map</th>' +
				'<th class="no-sort">Boss</th>' +
				'<th class="no-sort">Mercenary</th>' +
				'</tr></thead><tbody>';
			for (var ci = 0; ci < captureRows.length; ci++) {
				var cr = captureRows[ci];
				var bossCell = cr.bossGot.games > 0 ? winrateSpan(cr.bossGot.winrate) : '<span class="text-muted">-</span>';
				var mercCell = cr.mercGot.games > 0 ? winrateSpan(cr.mercGot.winrate) : '<span class="text-muted">-</span>';
				html += '<tr>' +
					'<td><a href="' + appLink('/map/' + slugify(cr.map)) + '">' + escapeHtml(displayMapName(cr.map)) + '</a></td>' +
					'<td class="num">' + bossCell + '</td>' +
					'<td class="num">' + mercCell + '</td>' +
					'</tr>';
			}
			html += '</tbody></table></div>';
		}

		app.innerHTML = html;
		var onWrlChange = function(newWrl) {
			currentWrl = newWrl;
			StandardTable.writeWrlToURL(newWrl);
			renderContent(matchIndex);
		};
		table.attachListeners(app, function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["maps-main"].defaultMask);
			renderContent(matchIndex);
		}, onWrlChange);
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(matchIndex); });
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading maps...</div>';
		currentMask = null;

		try {
			var results = await Promise.all([Data.matchIndex(), Data.settings()]);
			var matchIndex = results[0];
			defaults.minGames = String(AppSettings.minGamesDefault);
			filters.minGames = defaults.minGames;
			readFiltersFromURL(filters, defaults);
			var fromURL = StandardTable.readMaskFromURL();
			if (fromURL != null) currentMask = fromURL;
			currentWrl = StandardTable.readWrlFromURL();
			renderContent(matchIndex);
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load map data.</div>';
		}
	}

	return { render: render };
})();
