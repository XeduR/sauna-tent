// Shared chart creation utilities.
// Depends on: TableConfig (table-config.js), Chart.js (chart.umd.min.js)

var ChartUtils = (function() {
	// Create a hero popularity chart showing each month's top 10 heroes.
	// Heroes appear and disappear as their popularity changes over time.
	// heroColors: optional object mapping hero name -> hex color string.
	function createHeroPopularityChart(canvasId, monthlyData, heroColors) {
		var labels = monthlyData.sortedMonths;
		if (labels.length < 2) return null;

		var chart = TableConfig.CHART;

		// For each month, find the top 10 heroes by games played
		var heroMonthPresence = {};
		for (var i = 0; i < labels.length; i++) {
			var m = monthlyData.months[labels[i]];
			var entries = [];
			for (var hero in m.heroes) {
				entries.push({ hero: hero, games: m.heroes[hero] });
			}
			entries.sort(function(a, b) { return b.games - a.games; });
			var top = entries.slice(0, 10);
			for (var j = 0; j < top.length; j++) {
				if (!heroMonthPresence[top[j].hero]) heroMonthPresence[top[j].hero] = {};
				heroMonthPresence[top[j].hero][i] = true;
			}
		}

		// Build a dataset per hero, null for months where they're not in top 10
		var allHeroes = Object.keys(heroMonthPresence).sort();
		var datasets = [];
		for (var i = 0; i < allHeroes.length; i++) {
			var hero = allHeroes[i];
			var data = [];
			for (var j = 0; j < labels.length; j++) {
				if (heroMonthPresence[hero][j]) {
					data.push(monthlyData.months[labels[j]].heroes[hero]);
				} else {
					data.push(null);
				}
			}
			var color = (heroColors && heroColors[hero]) || chart.seriesColors[i % chart.seriesColors.length];
			datasets.push({
				label: hero,
				data: data,
				borderColor: color,
				backgroundColor: color,
				fill: false,
				tension: 0.3,
				borderWidth: 2,
				pointRadius: 3,
				spanGaps: false
			});
		}

		var ctx = document.getElementById(canvasId);
		if (!ctx) return null;
		return new Chart(ctx, {
			type: "line",
			data: { labels: labels, datasets: datasets },
			options: {
				responsive: true,
				maintainAspectRatio: true,
				scales: {
					x: { ticks: { color: chart.textColor }, grid: { color: chart.gridColor } },
					y: {
						beginAtZero: true,
						ticks: { color: chart.textColor },
						grid: { color: chart.gridColor }
					}
				},
				plugins: {
					legend: { display: false },
					tooltip: {
						mode: "index",
						filter: function(item) { return item.raw != null; },
						itemSort: function(a, b) { return b.raw - a.raw; }
					}
				},
				interaction: { mode: "index", intersect: false }
			}
		});
	}

	return {
		createHeroPopularityChart: createHeroPopularityChart
	};
})();
