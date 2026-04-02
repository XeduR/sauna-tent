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
				mapType: TableConfig.mapTypeSortValue(map),
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
		var partyContext = wrl === "full" ? { showAll: true, filterPartySize: filters.partySize || null } : null;
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
			var capRows = [];
			for (var ci = 0; ci < captureRows.length; ci++) {
				var cr = captureRows[ci];
				capRows.push({
					map: cr.map,
					bossWr: cr.bossGot.games > 0 ? cr.bossGot.winrate : null,
					mercWr: cr.mercGot.games > 0 ? cr.mercGot.winrate : null
				});
			}
			var capColumns = [
				{ key: "map", label: "Map", format: function(v) {
					return '<a href="' + appLink('/map/' + slugify(v)) + '">' + escapeHtml(displayMapName(v)) + '</a>';
				}},
				{ key: "bossWr", label: "Boss", className: "num", format: StandardTable.FORMAT.wr },
				{ key: "mercWr", label: "Mercenary", className: "num", format: StandardTable.FORMAT.wr }
			];
			var capTable = sortableTable("capture-wr-table", capColumns, capRows, "map", false);
			registerSortableTable(capTable);
			html += '<h2 class="section-title">First Capture Win Rate</h2>' + capTable.buildHTML();
		}

		app.innerHTML = html;
		var onWrlChange = function(newWrl, newMask) {
			currentWrl = newWrl;
			StandardTable.writeWrlToURL(newWrl);
			if (newMask != null) {
				currentMask = newMask;
				StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["maps-main"].defaultMask);
			}
			renderContent(matchIndex);
		};
		table.attachListeners(app, function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["maps-main"].defaultMask);
			renderContent(matchIndex);
		}, onWrlChange);
		attachAllSortableListeners(app);
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
