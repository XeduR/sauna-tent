// Heroes main page: all heroes with filterable stats, sortable table
var HeroesMainView = (function() {
	var filters = { mode: "", map: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var defaults = { mode: "", map: "", partySize: "", dateFrom: "", dateTo: "", minGames: "10", search: "" };
	var currentMask = null;
	var currentWrl = null;
	var heroChart = null;
	var heroColors = null;

	function getMask() {
		if (currentMask != null) return currentMask;
		var fromURL = StandardTable.readMaskFromURL();
		return fromURL != null ? fromURL : TableConfig.LAYOUTS["heroes-main"].defaultMask;
	}

	function getWrl() {
		if (currentWrl != null) return currentWrl;
		return StandardTable.readWrlFromURL();
	}

	function getAvailableMaps(matchIndex) {
		var mapSet = {};
		for (var i = 0; i < matchIndex.length; i++) {
			mapSet[matchIndex[i].map] = true;
		}
		return Object.keys(mapSet).sort();
	}

	function renderContent(matchIndex, summary, skipChart) {
		var app = document.getElementById("app");
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		var heroStats = MatchIndexUtils.groupByHero(filtered);
		var heroRoles = summary.heroRoles || {};
		var minGames = filters.minGames !== "" ? Number(filters.minGames) : 0;
		var mask = getMask();

		var t = aggregateGroup(heroStats, minGames);
		var totalGames = filtered.length;

		var html = '<div class="page-header"><h1>Heroes</h1>' +
			'<div class="subtitle">' + filtered.length.toLocaleString() + ' out of ' +
			matchIndex.length.toLocaleString() + ' matches</div></div>';

		html += buildPageFilterBar(filters, { mode: true, mapOptions: getAvailableMaps(matchIndex), partySize: true, dateFrom: true, dateTo: true, minGames: true, search: true, searchPlaceholder: "e.g. Murky" });

		// Role summary
		var roleStats = {};
		for (var hero in heroStats) {
			if (heroStats[hero].games < minGames) continue;
			var role = heroRoles[hero] || "Unknown";
			if (!roleStats[role]) roleStats[role] = { games: 0, wins: 0 };
			roleStats[role].games += heroStats[hero].games;
			roleStats[role].wins += heroStats[hero].wins;
		}
		var roleOrder = ["Tank", "Bruiser", "Melee Assassin", "Ranged Assassin", "Healer", "Support"];
		html += '<div class="stat-row">';
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

		// Hero table rows
		var rows = [];
		var searchTerm = (filters.search || "").toLowerCase();
		for (var hero in heroStats) {
			var hs = heroStats[hero];
			if (hs.games < minGames) continue;
			var heroRole = heroRoles[hero] || "Unknown";
			if (searchTerm && hero.toLowerCase().indexOf(searchTerm) === -1 && heroRole.toLowerCase().indexOf(searchTerm) === -1) continue;
			var avg = hs.averages || null;
			var row = {
				hero: hero,
				role: heroRole,
				pickRate: totalGames > 0 ? hs.games / totalGames : 0,
				games: hs.games,
				wins: hs.wins,
				losses: hs.losses,
				winrate: hs.winrate,
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
				durationMin: hs.durationMin,
				durationMax: hs.durationMax,
				durationAvg: hs.avgDuration,
				lastPlayed: hs.lastPlayed
			};
			StandardTable.addPartyWinrates(row, hs.byPartySize);
			rows.push(row);
		}

		// Popularity chart
		var monthlyData = MatchIndexUtils.computeMonthlyHeroStats(filtered);
		if (monthlyData.sortedMonths.length >= 2) {
			html += '<h2 class="section-title">Top 10 Hero Popularity Over Time</h2>' +
				'<div class="text-muted" style="margin-bottom:0.5rem">Lines appear only for months where a hero ranks in the top 10. Gaps mean the hero dropped out that month.</div>' +
				'<div class="chart-container"><canvas id="hero-pop-chart"></canvas></div>';
		}

		var wrl = getWrl();
		var partyContext = wrl === "full" ? { showAll: true, filterPartySize: filters.partySize || null } : null;
		var table = StandardTable.create("heroes-main", rows, { mask: mask, partyContext: partyContext, wrl: wrl });

		var tableHtml = '<div id="heroes-table-section">' +
			'<h2 class="section-title">All Heroes</h2>' +
			table.buildToggles() +
			table.buildHTML() +
			'</div>';

		if (skipChart) {
			var section = document.getElementById("heroes-table-section");
			if (section) {
				section.outerHTML = tableHtml;
			}
		} else {
			if (heroChart) { heroChart.destroy(); heroChart = null; }

			html += tableHtml;
			app.innerHTML = html;

			if (monthlyData.sortedMonths.length >= 2) {
				heroChart = ChartUtils.createHeroPopularityChart("hero-pop-chart", monthlyData, heroColors);
			}

			attachPageFilterListeners(app, filters, defaults, function() { renderContent(matchIndex, summary); });
		}

		var onWrlChange = function(newWrl, newMask) {
			currentWrl = newWrl;
			StandardTable.writeWrlToURL(newWrl);
			if (newMask != null) {
				currentMask = newMask;
				StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["heroes-main"].defaultMask);
			}
			renderContent(matchIndex, summary, true);
		};
		table.attachListeners(app, function(newMask) {
			currentMask = newMask;
			StandardTable.writeMaskToURL(newMask, TableConfig.LAYOUTS["heroes-main"].defaultMask);
			renderContent(matchIndex, summary, true);
		}, onWrlChange);
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading heroes...</div>';
		currentMask = null;

		try {
			var results = await Promise.all([Data.matchIndex(), Data.summary(), Data.settings(), Data.heroColors()]);
			heroColors = results[3];
			defaults.minGames = String(AppSettings.minGamesDefault);
			filters.minGames = defaults.minGames;
			readFiltersFromURL(filters, defaults);
			var fromURL = StandardTable.readMaskFromURL();
			if (fromURL != null) currentMask = fromURL;
			currentWrl = StandardTable.readWrlFromURL();
			renderContent(results[0], results[1]);
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load hero data.</div>';
		}
	}

	return { render: render };
})();
