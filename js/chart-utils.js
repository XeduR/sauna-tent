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

	// Draws each bar's formatted value above it. All labels are skipped when any one is wider
	// than its bar, so narrow charts never show a scattered few.
	function barValueLabels(format) {
		return {
			id: "barValueLabels",
			afterDatasetsDraw: function(chartInstance) {
				var context = chartInstance.ctx;
				var meta = chartInstance.getDatasetMeta(0);
				var values = chartInstance.data.datasets[0].data;

				context.save();
				context.font = "11px " + Chart.defaults.font.family;
				context.fillStyle = TableConfig.CHART.textColor;
				context.textAlign = "center";
				context.textBaseline = "bottom";

				var labels = [];
				for (var index = 0; index < meta.data.length; index++) {
					if (values[index] == null) continue;

					var bar = meta.data[index];
					var text = format(values[index]);
					if (bar.width < context.measureText(text).width) {
						labels = [];
						break;
					}
					labels.push({ text: text, x: bar.x, y: bar.y - 2 });
				}

				for (var li = 0; li < labels.length; li++) {
					context.fillText(labels[li].text, labels[li].x, labels[li].y);
				}
				context.restore();
			}
		};
	}

	function padHour(hour) {
		return (hour < 10 ? "0" : "") + hour;
	}

	function gamesText(games) {
		return games.toLocaleString() + (games === 1 ? " game" : " games");
	}

	// Bar chart over the 24 start hours. The y-axis width is pinned so stacked
	// time-of-day charts keep their hour columns aligned.
	function createHourBarChart(canvasId, config) {
		var chart = TableConfig.CHART;
		var ctx = document.getElementById(canvasId);
		if (!ctx) return null;

		var labels = [];
		for (var hour = 0; hour < config.values.length; hour++) {
			labels.push(padHour(hour));
		}

		var yScale = Object.assign({
			grid: { color: chart.gridColor },
			afterFit: function(scale) { scale.width = chart.hourAxisWidth; }
		}, config.yScale);
		yScale.ticks = Object.assign({ color: chart.textColor }, config.yScale.ticks);

		return new Chart(ctx, {
			type: "bar",
			data: {
				labels: labels,
				datasets: [{
					data: config.values,
					backgroundColor: config.colors,
					borderColor: config.colors,
					borderWidth: 1,
					borderRadius: 2
				}]
			},
			plugins: [barValueLabels(config.formatLabel)],
			options: {
				responsive: true,
				maintainAspectRatio: false,
				// Room for the value label above the tallest bar
				layout: { padding: { top: 18 } },
				scales: {
					x: { ticks: { color: chart.textColor }, grid: { color: chart.gridColor } },
					y: yScale
				},
				plugins: {
					legend: { display: false },
					title: {
						display: true,
						text: gamesText(config.totalGames) + ", by game start (" + AppSettings.overview.timeOfDayLabel + ")",
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
							label: config.tooltipLabel
						}
					}
				}
			}
		});
	}

	// Win rate per start hour; hourly is 24 {games, wins} buckets.
	function createHourlyWinrateChart(canvasId, hourly, totalGames) {
		var values = [];
		var colors = [];
		for (var hour = 0; hour < hourly.length; hour++) {
			var bucket = hourly[hour];
			if (bucket.games > 0) {
				values.push(Math.round(bucket.wins / bucket.games * 100));
				colors.push(winrateColor(bucket.wins / bucket.games));
			} else {
				values.push(null);
				colors.push(TableConfig.CHART.gridColor);
			}
		}

		return createHourBarChart(canvasId, {
			values: values,
			colors: colors,
			totalGames: totalGames,
			formatLabel: function(value) { return value + "%"; },
			yScale: {
				min: 0,
				max: 100,
				ticks: { callback: function(value) { return value + "%"; } }
			},
			tooltipLabel: function(item) {
				return [item.raw + "% win rate", gamesText(hourly[item.dataIndex].games)];
			}
		});
	}

	// Games per start hour; hourly is 24 {games, wins} buckets.
	function createHourlyGamesChart(canvasId, hourly, totalGames) {
		var values = [];
		for (var hour = 0; hour < hourly.length; hour++) {
			values.push(hourly[hour].games > 0 ? hourly[hour].games : null);
		}

		return createHourBarChart(canvasId, {
			values: values,
			colors: TableConfig.CHART.accentColor,
			totalGames: totalGames,
			formatLabel: function(value) { return value.toLocaleString(); },
			yScale: {
				beginAtZero: true,
				ticks: { precision: 0 }
			},
			tooltipLabel: function(item) { return gamesText(item.raw); }
		});
	}

	return {
		createHeroPopularityChart: createHeroPopularityChart,
		createHeroPickChart: createHeroPickChart,
		createHourlyWinrateChart: createHourlyWinrateChart,
		createHourlyGamesChart: createHourlyGamesChart
	};
})();
