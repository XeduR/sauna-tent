// Players main page: all roster players with filterable stats
var PlayersView = (function() {
	var filters = { mode: "", partySize: "", dateFrom: "", dateTo: "" };
	var defaults = { mode: "", partySize: "", dateFrom: "", dateTo: "" };
	var currentMask = null;
	var currentWrl = null;

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["players-main"].defaultMask;
	}

	function getWrl() {
		if (currentWrl != null) return currentWrl;
		return StandardTable.readWrlFromURL();
	}

	function buildPlayerRows(matchIndex, roster, filtered) {
		var stats = MatchIndexUtils.groupByPlayer(filtered);
		var totalGames = filtered.length;
		var rows = [];
		for (var i = 0; i < roster.players.length; i++) {
			var p = roster.players[i];
			var ps = stats[p.name];
			if (!ps || ps.games === 0) continue;
			var avg = ps.averages || null;
			rows.push({
				player: p.name,
				slug: p.slug,
				games: ps.games,
				pickRate: totalGames > 0 ? ps.games / totalGames : 0,
				wins: ps.wins,
				losses: ps.losses,
				winrate: ps.winrate,
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
				durationMin: ps.durationMin,
				durationMax: ps.durationMax,
				durationAvg: ps.avgDuration,
				lastPlayed: ps.lastPlayed
			});
			StandardTable.addPartyWinrates(rows[rows.length - 1], ps.byPartySize);
		}
		return rows;
	}

	function renderContent(matchIndex, roster) {
		var app = document.getElementById("app");
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var stats = MatchIndexUtils.groupByPlayer(filtered);
		var t = MatchIndexUtils.totals(filtered);
		var mask = getMask();

		var html = '<div class="page-header"><h1>Players</h1>' +
			'<div class="subtitle">' + t.games.toLocaleString() + ' out of ' +
			matchIndex.length.toLocaleString() + ' matches</div></div>';

		html += buildPageFilterBar(filters, { mode: true, partySize: true, dateFrom: true, dateTo: true });

		// Player cards
		html += '<div class="card-grid">';
		for (var i = 0; i < roster.players.length; i++) {
			var p = roster.players[i];
			var ps = stats[p.name];
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

		var wrl = getWrl();
		var partyContext = wrl === "full" ? { showAll: true } : null;
		var rows = buildPlayerRows(matchIndex, roster, filtered);
		var table = StandardTable.create("players-main", rows, { mask: mask, partyContext: partyContext, wrl: wrl });

		html += '<h2 class="section-title">Player Stats</h2>';
		html += table.buildToggles();
		html += table.buildHTML();

		app.innerHTML = html;
		var onWrlChange = function(newWrl) {
			currentWrl = newWrl;
			StandardTable.writeWrlToURL(newWrl);
			renderContent(matchIndex, roster);
		};
		table.attachListeners(app, function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["players-main"].defaultMask);
			renderContent(matchIndex, roster);
		}, onWrlChange);
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(matchIndex, roster); });
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading players...</div>';
		currentMask = null;

		try {
			var results = await Promise.all([Data.matchIndex(), Data.roster()]);
			readFiltersFromURL(filters, defaults);
			var fromURL = StandardTable.readMaskFromURL();
			if (fromURL != null) currentMask = fromURL;
			currentWrl = StandardTable.readWrlFromURL();
			renderContent(results[0], results[1]);
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load player data.</div>';
		}
	}

	return { render: render };
})();
