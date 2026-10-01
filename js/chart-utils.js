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
				maintainAspectRatio: false,
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
						backgroundColor: "rgb(0, 0, 0)",
						filter: function(item) { return item.raw != null; },
						itemSort: function(a, b) { return b.raw - a.raw; }
					}
				},
				interaction: { mode: "index", intersect: false }
			}
		});
	}

	// Create a bar chart for a single hero's pick count per month.
	function createHeroPickChart(canvasId, labels, data) {
		if (labels.length < 2) return null;

		var chart = TableConfig.CHART;
		var ctx = document.getElementById(canvasId);
		if (!ctx) return null;

		return new Chart(ctx, {
			type: "bar",
			data: {
				labels: labels,
				datasets: [{
					data: data,
					backgroundColor: "rgb(59, 130, 246)",
					borderColor: "rgb(59, 130, 246)",
					borderWidth: 1,
					borderRadius: 2
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				scales: {
					x: { ticks: { color: chart.textColor }, grid: { color: chart.gridColor } },
					y: {
						beginAtZero: true,
						ticks: { color: chart.textColor, precision: 0 },
						grid: { color: chart.gridColor }
					}
				},
				plugins: {
					legend: { display: false },
					tooltip: {
						backgroundColor: "rgb(0, 0, 0)",
						callbacks: {
							label: function(item) {
								return item.raw + (item.raw === 1 ? " game" : " games");
							}
						}
					}
				}
			}
		});
	}

	// Draws "NN%" above each bar, skipping bars too narrow to fit the text.
	var barPercentLabels = {
		id: "barPercentLabels",
		afterDatasetsDraw: function(chartInstance) {
			var context = chartInstance.ctx;
			var meta = chartInstance.getDatasetMeta(0);
			var values = chartInstance.data.datasets[0].data;

			context.save();
			context.font = "11px " + Chart.defaults.font.family;
			context.fillStyle = TableConfig.CHART.textColor;
			context.textAlign = "center";
			context.textBaseline = "bottom";
			for (var index = 0; index < meta.data.length; index++) {
				if (values[index] == null) continue;

				var bar = meta.data[index];
				var text = values[index] + "%";
				if (bar.width < context.measureText(text).width) continue;
				context.fillText(text, bar.x, bar.y - 2);
			}
			context.restore();
		}
	};

	function padHour(hour) {
		return (hour < 10 ? "0" : "") + hour;
	}

	// Win rate per start hour; hourly is 24 {games, wins} buckets.
	function createHourlyWinrateChart(canvasId, hourly, totalGames) {
		var chart = TableConfig.CHART;
		var ctx = document.getElementById(canvasId);
		if (!ctx) return null;

		var labels = [];
		var values = [];
		var colors = [];
		for (var hour = 0; hour < hourly.length; hour++) {
			var bucket = hourly[hour];
			labels.push(padHour(hour));
			if (bucket.games > 0) {
				values.push(Math.round(bucket.wins / bucket.games * 100));
				colors.push(winrateColor(bucket.wins / bucket.games));
			} else {
				values.push(null);
				colors.push(chart.gridColor);
			}
		}

		var titleText = totalGames.toLocaleString() + (totalGames === 1 ? " game" : " games") +
			", by game start (" + AppSettings.overview.timeOfDayLabel + ")";

		return new Chart(ctx, {
			type: "bar",
			data: {
				labels: labels,
				datasets: [{
					data: values,
					backgroundColor: colors,
					borderColor: colors,
					borderWidth: 1,
					borderRadius: 2
				}]
			},
			plugins: [barPercentLabels],
			options: {
				responsive: true,
				maintainAspectRatio: false,
				// Room for the percent label above a 100% bar
				layout: { padding: { top: 18 } },
				scales: {
					x: { ticks: { color: chart.textColor }, grid: { color: chart.gridColor } },
					y: {
						min: 0,
						max: 100,
						ticks: {
							color: chart.textColor,
							callback: function(value) { return value + "%"; }
						},
						grid: { color: chart.gridColor }
					}
				},
				plugins: {
					legend: { display: false },
					title: {
						display: true,
						text: titleText,
						color: chart.textColor,
						font: { weight: "normal" }
					},
					tooltip: {
						backgroundColor: "rgb(0, 0, 0)",
						callbacks: {
							title: function(items) {
								var hourText = padHour(items[0].dataIndex);
								return hourText + ":00-" + hourText + ":59";
							},
							label: function(item) {
								var games = hourly[item.dataIndex].games;
								return [item.raw + "% win rate", games.toLocaleString() + (games === 1 ? " game" : " games")];
							}
						}
					}
				}
			}
		});
	}

	return {
		createHeroPopularityChart: createHeroPopularityChart,
		createHeroPickChart: createHeroPickChart,
		createHourlyWinrateChart: createHourlyWinrateChart
	};
})();
