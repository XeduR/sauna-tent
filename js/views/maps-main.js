// Maps main page: all maps with filterable stats, sortable table
var MapsMainView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var currentMask = null;

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["maps-main"].defaultMask;
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
			'<div class="subtitle">' + t.games.toLocaleString() + ' out of ' +
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
			rows.push({
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
			});
		}

		var table = StandardTable.create("maps-main", rows, { mask: mask });

		html += '<h2 class="section-title">All Maps</h2>';
		html += table.buildToggles();
		html += table.buildHTML();

		app.innerHTML = html;
		table.attachListeners(app, function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["maps-main"].defaultMask);
			renderContent(matchIndex);
		});
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
			renderContent(matchIndex);
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load map data.</div>';
		}
	}

	return { render: render };
})();
