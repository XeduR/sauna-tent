// Shared utility functions and app initialization

function escapeHtml(str) {
	var div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

function formatWinrate(rate) {
	return (rate * 100).toFixed(1) + "%";
}

function winrateColor(rate) {
	// 40% = red, 50% = neutral, 60% = green, interpolated
	var t = Math.max(0, Math.min(1, (rate - 0.4) / 0.2));
	var r, g, b;
	if (t <= 0.5) {
		var s = t * 2;
		r = Math.round(255 + (176 - 255) * s);
		g = Math.round(68 + (176 - 68) * s);
		b = Math.round(68 + (176 - 68) * s);
	} else {
		var s = (t - 0.5) * 2;
		r = Math.round(176 + (61 - 176) * s);
		g = Math.round(176 + (220 - 176) * s);
		b = Math.round(176 + (132 - 176) * s);
	}
	return "rgb(" + r + "," + g + "," + b + ")";
}

function winrateSpan(rate) {
	return '<span class="winrate" style="color:' + winrateColor(rate) + '">' + formatWinrate(rate) + '</span>';
}

function statBox(label, value) {
	return '<div class="stat-box"><div class="label">' + escapeHtml(label) +
		'</div><div class="value">' + value + '</div></div>';
}

function statBoxHtml(labelHtml, value) {
	return '<div class="stat-box"><div class="label">' + labelHtml +
		'</div><div class="value">' + value + '</div></div>';
}

function formatDuration(seconds) {
	var total = Math.round(seconds);
	var m = Math.floor(total / 60);
	var s = total % 60;
	return m + ":" + (s < 10 ? "0" : "") + s;
}

function formatNumber(n) {
	if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
	if (n >= 1000) return (n / 1000).toFixed(1) + "K";
	return String(n);
}

// Must match pipeline's slugify exactly: lowercase, spaces to dashes, strip apostrophes and dots
function slugify(name) {
	return name.toLowerCase().replace(/ /g, "-").replace(/'/g, "").replace(/\./g, "");
}

// Icon helpers
function heroIconHtml(heroName, size) {
	var slug = slugify(heroName);
	var cls = size === "lg" ? "hero-icon-lg" : "hero-icon";
	return '<img class="' + cls + '" src="img/hero/' + slug + '/avatar.png" alt="" title="' + escapeHtml(heroName) + '">';
}

function roleIconHtml(role) {
	var file = role.toLowerCase().replace(/ /g, "-") + ".png";
	return '<img class="role-icon" src="img/roles/' + file + '" alt="" title="' + escapeHtml(role) + '">';
}

var TALENT_TIERS = [1, 4, 7, 10, 13, 16, 20];

function talentIconHtml(heroName, tierIndex, choice, talentData) {
	if (!choice || choice === 0) return '<span class="text-muted">-</span>';
	var slug = slugify(heroName);
	var level = TALENT_TIERS[tierIndex];
	var key = level + "_" + choice;
	var src = "img/hero/" + slug + "/talent" + key + ".png";
	var names = talentData && talentData.names ? talentData.names[slug] : null;
	var descs = talentData && talentData.descriptions ? talentData.descriptions[slug] : null;
	var name = names ? names[key] || "" : "";
	var desc = descs ? descs[key] || "" : "";

	return '<span class="talent-tip" data-tip-name="' + escapeHtml(name) +
		'" data-tip-desc="' + escapeHtml(desc) + '">' +
		'<img class="talent-icon" src="' + src + '" alt=""></span>';
}

function talentBuildString(talents, heroName) {
	var code = "[T";
	for (var t = 0; t < 7; t++) {
		code += (talents[t] && talents[t] > 0) ? talents[t] : "0";
	}
	return code + "," + heroName + "]";
}

function talentCopyBtnHtml(talents, heroName) {
	var str = talentBuildString(talents, heroName);
	return '<button class="talent-copy-btn" data-copy="' + escapeHtml(str) + '" title="Copy build">' +
		'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
		'<rect x="5" y="5" width="9.5" height="9.5" rx="1.5"/>' +
		'<path d="M2 10.5V2.5a.5.5 0 01.5-.5h8"/></svg></button>';
}

// Shared tooltip element, appended to body once
var talentTooltip = null;

function initTalentTooltip() {
	if (talentTooltip) return;
	talentTooltip = document.createElement("div");
	talentTooltip.className = "talent-tip-text";
	talentTooltip.style.display = "none";
	document.body.appendChild(talentTooltip);

	document.addEventListener("mouseover", function(e) {
		var tip = e.target.closest(".talent-tip");
		if (!tip) return;
		var name = tip.getAttribute("data-tip-name");
		if (!name) return;
		var desc = tip.getAttribute("data-tip-desc") || "";
		talentTooltip.innerHTML = '<div class="talent-tip-name">' + name + '</div>' + desc;
		talentTooltip.style.display = "block";
		positionTooltip(tip);
	});

	document.addEventListener("mouseout", function(e) {
		var tip = e.target.closest(".talent-tip");
		if (!tip) return;
		if (!tip.contains(e.relatedTarget)) {
			talentTooltip.style.display = "none";
		}
	});
}

function positionTooltip(anchor) {
	var rect = anchor.getBoundingClientRect();
	var tipW = talentTooltip.offsetWidth;
	var tipH = talentTooltip.offsetHeight;
	var left = rect.left + rect.width / 2 - tipW / 2;
	var top = rect.top - tipH - 6;

	// Keep within viewport
	if (left < 4) left = 4;
	if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4;
	if (top < 4) {
		top = rect.bottom + 6;
	}

	talentTooltip.style.left = left + "px";
	talentTooltip.style.top = top + "px";
}

var MODE_DISPLAY_NAMES = {
	"StormLeague": "Storm League",
	"ARAM": "ARAM",
	"Custom": "Custom"
};

function displayModeName(raw) {
	return MODE_DISPLAY_NAMES[raw] || raw;
}

var PARTY_LABELS = { 1: "Solo", 2: "Duo", 3: "3-stack", 4: "4-stack", 5: "5-stack" };

// ARAM map lookup, populated when summary loads
var ARAM_MAPS = {};

function displayMapName(name) {
	if (ARAM_MAPS[name]) return name + " (ARAM)";
	return name;
}

// Generate internal link href with base path
function appLink(path) {
	return Router.basePath + path;
}

function formatDateFinnish(isoTimestamp) {
	var parts = isoTimestamp.substring(0, 10).split("-");
	return parts[2] + "/" + parts[1] + "/" + parts[0];
}

// Registry for sortable tables created by shared render functions.
// Views call attachAllSortableListeners(container) after setting innerHTML.
var _sortableTables = [];
var _metaTableCounter = 0;

function registerSortableTable(table) {
	_sortableTables.push(table);
}

function attachAllSortableListeners(container) {
	for (var i = 0; i < _sortableTables.length; i++) {
		_sortableTables[i].attachListeners(container);
	}
	_sortableTables = [];
	_metaTableCounter = 0;
}

// Shared match factor / level lead rendering (used by overview, player, map pages).
// conditionSortFn, when provided, takes a condition string and returns a numeric
// sort value so callers can override the default alphabetic sort.
function renderMetaFactorTable(title, dataRows, conditionSortFn) {
	_metaTableCounter++;
	var tableId = "meta-table-" + _metaTableCounter;

	var rows = [];
	for (var i = 0; i < dataRows.length; i++) {
		var d = dataRows[i][1];
		rows.push({
			condition: dataRows[i][0],
			games: d.games,
			wins: d.wins,
			losses: d.games - d.wins,
			winrate: d.winrate
		});
	}

	var fmtNum = function(v) { return v.toLocaleString(); };
	var conditionCol = { key: "condition", label: "Condition" };
	if (conditionSortFn) {
		conditionCol.sortValue = function(row) { return conditionSortFn(row.condition); };
	}
	var columns = [
		conditionCol,
		{ key: "games", label: "Total", className: "num", format: fmtNum },
		{ key: "wins", label: "Win", className: "num", format: fmtNum },
		{ key: "losses", label: "Loss", className: "num", format: fmtNum },
		{ key: "winrate", label: "Avg", className: "num", format: function(v) { return winrateSpan(v); } }
	];
	var headerGroups = [
		{ label: "Factor", span: 1 },
		{ label: "Games", span: 3 },
		{ label: "Win Rate", span: 1 }
	];

	var table = sortableTable(tableId, columns, rows, "condition", false, headerGroups);
	registerSortableTable(table);
	return '<h2 class="section-title">' + title + '</h2>' + table.buildHTML();
}

function renderLevelLeadTable(levelLead) {
	if (!levelLead) return "";
	var tiers = ["4", "7", "10", "13", "16", "20"];
	var hasData = false;
	for (var i = 0; i < tiers.length; i++) {
		if (levelLead[tiers[i]] && (levelLead[tiers[i]].got.games > 0 || levelLead[tiers[i]].gave.games > 0)) {
			hasData = true;
			break;
		}
	}
	if (!hasData) return "";

	// Custom sort order: all "First to" tiers ascending, then all "Behind at" tiers ascending
	var conditionOrder = {};
	for (var i = 0; i < tiers.length; i++) {
		conditionOrder["First to " + tiers[i]] = i;
		conditionOrder["Behind at " + tiers[i]] = tiers.length + i;
	}
	var conditionSortFn = function(cond) {
		return conditionOrder[cond] != null ? conditionOrder[cond] : 999;
	};

	var rows = [];
	for (var i = 0; i < tiers.length; i++) {
		var tier = tiers[i];
		var got = levelLead[tier] ? levelLead[tier].got : { games: 0, wins: 0, losses: 0, winrate: 0 };
		var gave = levelLead[tier] ? levelLead[tier].gave : { games: 0, wins: 0, losses: 0, winrate: 0 };
		if (got.games > 0 || gave.games > 0) {
			rows.push(["First to " + tier, got]);
			rows.push(["Behind at " + tier, gave]);
		}
	}
	return renderMetaFactorTable("Level Lead", rows, conditionSortFn);
}

// Shared sortable table builder (used by player, hero, map, and main pages)
function sortableTable(tableId, columns, rows, defaultSortKey, defaultDesc, headerGroups, options) {
	options = options || {};
	var rowClassFn = options.rowClass || null;
	var tfootHtml = options.tfoot || "";
	var sortKey = defaultSortKey || columns[0].key;
	var sortDesc = defaultDesc !== undefined ? defaultDesc : true;

	function sortRows() {
		var sortCol = null;
		for (var ci = 0; ci < columns.length; ci++) {
			if (columns[ci].key === sortKey) { sortCol = columns[ci]; break; }
		}
		var getVal = (sortCol && sortCol.sortValue)
			? sortCol.sortValue
			: function(row) { return row[sortKey]; };
		rows.sort(function(a, b) {
			var va = getVal(a);
			var vb = getVal(b);
			if (typeof va === "string") {
				va = va.toLowerCase();
				vb = vb.toLowerCase();
				if (va < vb) return sortDesc ? 1 : -1;
				if (va > vb) return sortDesc ? -1 : 1;
				return 0;
			}
			return sortDesc ? vb - va : va - vb;
		});
	}

	function buildHTML() {
		sortRows();
		var html = '<div class="table-wrap"><table id="' + tableId + '"><thead>';
		if (headerGroups) {
			html += '<tr class="header-group-row">';
			var colOffset = 0;
			for (var g = 0; g < headerGroups.length; g++) {
				var grp = headerGroups[g];
				var allNoSort = true;
				if (grp.label) {
					for (var si = colOffset; si < colOffset + grp.span && si < columns.length; si++) {
						if (!columns[si].noSort) { allNoSort = false; break; }
					}
				}
				var cls = grp.label ? "header-group" : "header-group-empty";
				if (grp.label && allNoSort) cls += " no-sort";
				var firstColAttr = "";
				if (grp.label) {
					for (var ci = colOffset; ci < colOffset + grp.span && ci < columns.length; ci++) {
						if (!columns[ci].noSort) {
							firstColAttr = ' data-first-col="' + columns[ci].key + '"';
							break;
						}
					}
				}
				html += '<th colspan="' + grp.span + '" class="' + cls + '"' + firstColAttr + '>' + (grp.label || '') + '</th>';
				colOffset += grp.span;
			}
			html += '</tr>';
		}
		html += '<tr>';
		for (var c = 0; c < columns.length; c++) {
			var col = columns[c];
			var cls = col.noSort ? "no-sort" : "";
			if (!col.noSort && col.key === sortKey) {
				cls += sortDesc ? " sort-desc" : " sort-asc";
			}
			if (col.className) cls += " " + col.className;
			html += '<th data-sort-key="' + col.key + '" class="' + cls + '">' + col.label + '</th>';
		}
		html += '</tr></thead><tbody>';
		for (var r = 0; r < rows.length; r++) {
			var trCls = rowClassFn ? rowClassFn(rows[r]) : "";
			html += '<tr' + (trCls ? ' class="' + trCls + '"' : '') + '>';
			for (var c = 0; c < columns.length; c++) {
				var col = columns[c];
				var val = rows[r][col.key];
				var formatted = col.format ? col.format(val, rows[r]) : val;
				var tdClass = col.className || "";
				html += '<td class="' + tdClass + '">' + formatted + '</td>';
			}
			html += '</tr>';
		}
		if (rows.length === 0) {
			html += '<tr><td colspan="' + columns.length + '" class="text-muted" style="text-align:center;padding:1.5rem;">No results.</td></tr>';
		}
		html += '</tbody>';
		if (tfootHtml) html += tfootHtml;
		html += '</table></div>';
		return html;
	}

	function attachListeners(container) {
		var table = container.querySelector("#" + tableId);
		if (!table) return;
		var headers = table.querySelectorAll("thead th");
		for (var i = 0; i < headers.length; i++) {
			headers[i].addEventListener("click", function() {
				if (this.classList.contains("header-group-empty") || this.classList.contains("no-sort")) return;
				var key = this.getAttribute("data-sort-key") || this.getAttribute("data-first-col");
				if (!key) return;
				if (sortKey === key) {
					sortDesc = !sortDesc;
				} else {
					sortKey = key;
					var sample = rows.length > 0 ? rows[0][key] : 0;
					sortDesc = typeof sample !== "string";
				}
				var wrapper = table.parentElement;
				wrapper.outerHTML = buildHTML();
				attachListeners(container);
			});
		}
	}

	return { buildHTML: buildHTML, attachListeners: attachListeners };
}

// Aggregate overall stats from grouped entries (heroes, players, maps) that pass minGames.
// Used to keep overall stats consistent with table rows after minGames filtering.
function aggregateGroup(entries, minGames) {
	var o = { games: 0, wins: 0, losses: 0 };
	var totalKills = 0, totalDeaths = 0, totalAssists = 0, totalDuration = 0;
	var totalHeroDamage = 0, totalSiegeDamage = 0;
	var hasAverages = false, hasDuration = false;

	for (var key in entries) {
		var e = entries[key];
		if (e.games < minGames) continue;
		o.games += e.games;
		o.wins += e.wins;
		o.losses += e.losses;
		if (e.averages) {
			hasAverages = true;
			totalKills += e.averages.kills * e.games;
			totalDeaths += e.averages.deaths * e.games;
			totalAssists += e.averages.assists * e.games;
			if (e.averages.heroDamage != null) totalHeroDamage += e.averages.heroDamage * e.games;
			if (e.averages.siegeDamage != null) totalSiegeDamage += e.averages.siegeDamage * e.games;
		}
		var dur = e.averageDurationSeconds || e.avgDuration;
		if (dur) {
			hasDuration = true;
			totalDuration += dur * e.games;
		}
	}

	o.winrate = o.games > 0 ? o.wins / o.games : 0;
	if (hasAverages && o.games > 0) {
		o.averages = {
			kills: totalKills / o.games,
			deaths: totalDeaths / o.games,
			assists: totalAssists / o.games,
			kda: totalDeaths > 0 ? (totalKills + totalAssists) / totalDeaths : 0,
			heroDamage: totalHeroDamage / o.games,
			siegeDamage: totalSiegeDamage / o.games,
		};
	}
	if (hasDuration && o.games > 0) {
		o.averageDurationSeconds = totalDuration / o.games;
		o.avgDuration = o.averageDurationSeconds;
	}
	return o;
}

// Track season dropdown open state across re-renders
var _seasonDropdownOpen = false;

// Shared page filter bar builder
function buildPageFilterBar(filters, options) {
	var html = '<div class="filter-bar">';

	if (options.reset !== false) {
		html += '<button class="btn btn-reset page-filter-reset">Reset filters</button>';
	}

	html += '<div class="filter-row">';

	if (options.mode) {
		html += '<div class="filter-field">' +
			'<label for="pf-mode">Mode</label>' +
			'<select id="pf-mode">' +
			'<option value="">All</option>';
		var modeOptions = options.modeOptions || [
			{ value: "StormLeague", label: "Storm League" },
			{ value: "ARAM", label: "ARAM" },
			{ value: "Custom", label: "Custom" }
		];
		for (var mi = 0; mi < modeOptions.length; mi++) {
			var mo = modeOptions[mi];
			html += '<option value="' + mo.value + '"' + (filters.mode === mo.value ? " selected" : "") + '>' + mo.label + '</option>';
		}
		html += '</select></div>';
	}

	if (options.mode && window.AppSeasons && filters.hasOwnProperty("seasons")) {
		var seasons = window.AppSeasons;
		var selectedSeasons = filters.seasons ? filters.seasons.split(",") : [];
		var btnText = "All";
		if (selectedSeasons.length === 1) {
			for (var si = 0; si < seasons.length; si++) {
				if (String(seasons[si].number) === selectedSeasons[0]) {
					btnText = seasons[si].name;
					break;
				}
			}
		} else if (selectedSeasons.length > 1) {
			btnText = selectedSeasons.length + " seasons";
		}
		var dropdownCls = "season-select-dropdown" + (_seasonDropdownOpen ? " open" : "");
		html += '<div class="filter-field season-filter">' +
			'<label>Season</label>' +
			'<div class="season-select">' +
			'<button type="button" class="season-select-btn" id="pf-season-btn">' + escapeHtml(btnText) + '</button>' +
			'<div class="' + dropdownCls + '" id="pf-season-dropdown">';
		for (var si = seasons.length - 1; si >= 0; si--) {
			var s = seasons[si];
			var checked = selectedSeasons.indexOf(String(s.number)) !== -1 ? " checked" : "";
			html += '<label class="season-option">' +
				'<input type="checkbox" value="' + s.number + '"' + checked + '> ' +
				escapeHtml(s.name) + '</label>';
		}
		html += '</div></div></div>';
	}

	if (options.mapOptions) {
		html += '<div class="filter-field">' +
			'<label for="pf-map">Map</label>' +
			'<select id="pf-map">' +
			'<option value="">All</option>';
		for (var i = 0; i < options.mapOptions.length; i++) {
			var m = options.mapOptions[i];
			html += '<option value="' + escapeHtml(m) + '"' +
				(filters.map === m ? ' selected' : '') + '>' +
				escapeHtml(displayMapName(m)) + '</option>';
		}
		html += '</select></div>';
	}

	if (options.partySize) {
		html += '<div class="filter-field">' +
			'<label for="pf-party">Party Size</label>' +
			'<select id="pf-party">' +
			'<option value="">All</option>';
		for (var s = 1; s <= 5; s++) {
			var label = PARTY_LABELS[s] || s + "-stack";
			html += '<option value="' + s + '"' + (filters.partySize === String(s) ? " selected" : "") + '>' + label + '</option>';
		}
		html += '</select></div>';
	}

	if (options.dateFrom) {
		html += '<div class="filter-field">' +
			'<label for="pf-date-from">From</label>' +
			'<input type="date" id="pf-date-from" value="' + (filters.dateFrom || "") + '">' +
			'</div>';
	}

	if (options.dateTo) {
		html += '<div class="filter-field">' +
			'<label for="pf-date-to">To</label>' +
			'<input type="date" id="pf-date-to" value="' + (filters.dateTo || "") + '">' +
			'</div>';
	}

	if (options.minGames) {
		html += '<div class="filter-field">' +
			'<label for="pf-min-games">Min Games</label>' +
			'<input type="text" id="pf-min-games" inputmode="numeric" value="' +
			(filters.minGames !== undefined && filters.minGames !== "" ? filters.minGames : "") +
			'" class="filter-min-games">' +
			'</div>';
	}

	if (options.search) {
		html += '<div class="filter-field">' +
			'<label for="pf-search">Search</label>' +
			'<input type="text" id="pf-search" value="' + escapeHtml(filters.search || "") +
			'" placeholder="' + escapeHtml(options.searchPlaceholder || "") + '" class="filter-search">' +
			'</div>';
	}

	html += '</div></div>';
	return html;
}

// URL filter sync for shareable page links
var FILTER_URL_KEYS = {
	mode: "m",
	map: "mp",
	partySize: "ps",
	dateFrom: "df",
	dateTo: "dt",
	minGames: "mg",
	search: "q",
	seasons: "s"
};

function readFiltersFromURL(filters, defaults) {
	var params = new URLSearchParams(window.location.search);
	var hasAny = false;
	for (var key in FILTER_URL_KEYS) {
		if (filters.hasOwnProperty(key) && params.has(FILTER_URL_KEYS[key])) {
			hasAny = true;
			break;
		}
	}
	if (!hasAny) return;

	// Reset to defaults so shared URLs produce consistent results
	for (var key in defaults) {
		if (defaults.hasOwnProperty(key)) {
			filters[key] = defaults[key];
		}
	}
	// Show all data by default on shared URLs unless minGames is explicitly set
	if (filters.hasOwnProperty("minGames") && !params.has(FILTER_URL_KEYS.minGames)) {
		filters.minGames = "0";
	}
	for (var key in FILTER_URL_KEYS) {
		if (!filters.hasOwnProperty(key)) continue;
		var urlKey = FILTER_URL_KEYS[key];
		if (params.has(urlKey)) {
			filters[key] = params.get(urlKey);
		}
	}
	// Enforce season/date mutual exclusivity
	if (filters.hasOwnProperty("seasons") && filters.seasons) {
		filters.mode = "StormLeague";
		filters.dateFrom = "";
		filters.dateTo = "";
	}
}

function writeFiltersToURL(filters, defaults) {
	// Start from current URL params to preserve unmanaged keys (e.g. vf)
	var params = new URLSearchParams(window.location.search);
	for (var key in FILTER_URL_KEYS) {
		if (!filters.hasOwnProperty(key)) continue;
		var urlKey = FILTER_URL_KEYS[key];
		if (key === "minGames") {
			if (filters[key] !== "" && filters[key] !== undefined) {
				params.set(urlKey, filters[key]);
			} else {
				params.delete(urlKey);
			}
		} else if (filters[key] && filters[key] !== defaults[key]) {
			params.set(urlKey, filters[key]);
		} else {
			params.delete(urlKey);
		}
	}
	var qs = params.toString();
	var newURL = window.location.pathname + (qs ? "?" + qs : "");
	history.replaceState(null, "", newURL);
}

function attachPageFilterListeners(container, filters, defaults, onChange) {
	writeFiltersToURL(filters, defaults);
	var mode = container.querySelector("#pf-mode");
	var party = container.querySelector("#pf-party");
	var dateFrom = container.querySelector("#pf-date-from");
	var dateTo = container.querySelector("#pf-date-to");
	var minGames = container.querySelector("#pf-min-games");
	var reset = container.querySelector(".page-filter-reset");

	var map = container.querySelector("#pf-map");
	var search = container.querySelector("#pf-search");

	var seasonBtn = container.querySelector("#pf-season-btn");
	var seasonDropdown = container.querySelector("#pf-season-dropdown");

	if (mode) mode.addEventListener("change", function() {
		filters.mode = this.value;
		// Seasons only apply to Storm League
		if (this.value !== "StormLeague" && filters.hasOwnProperty("seasons")) {
			filters.seasons = "";
			_seasonDropdownOpen = false;
		}
		if (party) {
			if (this.value === "Custom") {
				filters.partySize = "5";
				party.value = "5";
				party.disabled = true;
				party.title = "Custom games only support 5-stacks";
			} else {
				party.disabled = false;
				party.title = "";
			}
		}
		onChange();
	});
	if (party) {
		if (filters.mode === "Custom") {
			filters.partySize = "5";
			party.value = "5";
			party.disabled = true;
			party.title = "Custom games only support 5-stacks";
		}
		party.addEventListener("change", function() { filters.partySize = this.value; onChange(); });
	}
	if (dateFrom) dateFrom.addEventListener("change", function() {
		filters.dateFrom = this.value;
		if (this.value && filters.hasOwnProperty("seasons")) {
			filters.seasons = "";
			_seasonDropdownOpen = false;
		}
		onChange();
	});
	if (dateTo) dateTo.addEventListener("change", function() {
		filters.dateTo = this.value;
		if (this.value && filters.hasOwnProperty("seasons")) {
			filters.seasons = "";
			_seasonDropdownOpen = false;
		}
		onChange();
	});
	if (map) map.addEventListener("change", function() { filters.map = this.value; onChange(); });
	if (search) search.addEventListener("input", function() {
		var val = this.value;
		filters.search = val;
		onChange();
		// Restore focus after re-render since onChange rebuilds the DOM
		var newSearch = container.querySelector("#pf-search");
		if (newSearch) {
			newSearch.focus();
			newSearch.setSelectionRange(val.length, val.length);
		}
	});
	if (minGames) {
		var commitMinGames = function() {
			var val = minGames.value.trim();
			var newVal;
			if (val === "" || !/^\d+$/.test(val)) {
				newVal = "0";
			} else {
				newVal = val;
			}
			minGames.value = newVal;
			// Only trigger re-render if value actually changed
			if (newVal !== filters.minGames) {
				filters.minGames = newVal;
				onChange();
			}
		};
		minGames.addEventListener("blur", commitMinGames);
		minGames.addEventListener("keydown", function(e) {
			if (e.key === "Enter" || e.key === "Escape") {
				e.preventDefault();
				this.blur();
			}
		});
	}

	// Season multi-select dropdown
	if (seasonBtn && seasonDropdown) {
		seasonBtn.addEventListener("click", function(e) {
			e.stopPropagation();
			_seasonDropdownOpen = !_seasonDropdownOpen;
			seasonDropdown.classList.toggle("open", _seasonDropdownOpen);
		});

		seasonDropdown.addEventListener("click", function(e) {
			e.stopPropagation();
		});

		var seasonCheckboxes = seasonDropdown.querySelectorAll('input[type="checkbox"]');
		for (var sci = 0; sci < seasonCheckboxes.length; sci++) {
			seasonCheckboxes[sci].addEventListener("change", function() {
				var checked = seasonDropdown.querySelectorAll('input[type="checkbox"]:checked');
				var selected = [];
				for (var j = 0; j < checked.length; j++) {
					selected.push(checked[j].value);
				}
				filters.seasons = selected.join(",");
				if (filters.seasons) {
					filters.mode = "StormLeague";
					filters.dateFrom = "";
					filters.dateTo = "";
				}
				_seasonDropdownOpen = true;
				onChange();
			});
		}
	}

	if (reset) {
		reset.addEventListener("click", function() {
			_seasonDropdownOpen = false;
			var keys = Object.keys(defaults);
			for (var i = 0; i < keys.length; i++) {
				filters[keys[i]] = defaults[keys[i]];
			}
			onChange();
		});
	}
}

// Populate nav dropdown menus from roster/data
async function populateNav() {
	var roster, summary;

	try {
		roster = await Data.roster();
		var playersMenu = document.getElementById("nav-players-menu");
		for (var i = 0; i < roster.players.length; i++) {
			var p = roster.players[i];
			var li = document.createElement("li");
			li.innerHTML = '<a href="' + appLink('/player/' + p.slug) + '">' + escapeHtml(p.name) + '</a>';
			playersMenu.appendChild(li);
		}
	} catch (err) {
		// Nav population is non-critical
	}

	// Load settings and seasons early so they're available when views render
	try {
		await Data.settings();
	} catch (err) {
		// Non-critical; views will await Data.settings() independently
	}

	try {
		window.AppSeasons = await Data.seasons();
	} catch (err) {
		// Non-critical; season filter won't render if unavailable
	}

	// Populate ARAM map lookup from summary
	try {
		summary = await Data.summary();
		if (summary.aramMaps) {
			for (var i = 0; i < summary.aramMaps.length; i++) {
				ARAM_MAPS[summary.aramMaps[i]] = true;
			}
		}
	} catch (err) {
		// Non-critical
	}
}

// Mobile nav toggle
function setupMobileNav() {
	var toggle = document.querySelector(".nav-toggle");
	var links = document.querySelector(".nav-links");

	toggle.addEventListener("click", function() {
		links.classList.toggle("open");
	});

	// Close mobile nav on link click
	links.addEventListener("click", function(e) {
		if (e.target.tagName === "A" && !e.target.classList.contains("nav-dropdown-toggle")) {
			links.classList.remove("open");
		}
	});

	// Mobile dropdown toggles: navigate to main page on click,
	// long-press or separate toggle for dropdown submenu
	var dropdownToggles = document.querySelectorAll(".nav-dropdown-toggle");
	for (var i = 0; i < dropdownToggles.length; i++) {
		dropdownToggles[i].addEventListener("click", function(e) {
			if (window.innerWidth <= 768) {
				// Navigate to the main page (href is set on the link)
				links.classList.remove("open");
			}
		});
	}
}

// Attach synced horizontal scrollbar above each data table
function attachTopScrollbars() {
	var wraps = document.querySelectorAll('.table-wrap');
	for (var i = 0; i < wraps.length; i++) {
		(function(wrap) {
			if (wrap.hasAttribute('data-scroll-synced')) return;

			var table = wrap.querySelector('table');
			if (!table) return;

			// Remove stale dummy left behind by outerHTML sort re-renders
			var prev = wrap.previousElementSibling;
			if (prev && prev.classList.contains('table-scroll-top')) {
				prev.remove();
			}

			var dummy = document.createElement('div');
			dummy.className = 'table-scroll-top';
			var inner = document.createElement('div');
			dummy.appendChild(inner);
			wrap.parentNode.insertBefore(dummy, wrap);
			inner.style.width = table.scrollWidth + 'px';
			wrap.setAttribute('data-scroll-synced', '');

			var syncing = false;
			dummy.addEventListener('scroll', function() {
				if (!syncing) {
					syncing = true;
					wrap.scrollLeft = dummy.scrollLeft;
					syncing = false;
				}
			});
			wrap.addEventListener('scroll', function() {
				if (!syncing) {
					syncing = true;
					dummy.scrollLeft = wrap.scrollLeft;
					syncing = false;
				}
			});

			if (window.ResizeObserver) {
				new ResizeObserver(function() {
					inner.style.width = table.scrollWidth + 'px';
				}).observe(table);
			}
		})(wraps[i]);
	}
}

// Register routes
Router.add("/", function() { OverviewView.render(); });
Router.add("/players", function() { PlayersView.render(); });
Router.add("/player/:slug", function(slug) { PlayerView.render(slug); });
Router.add("/heroes", function() { HeroesMainView.render(); });
Router.add("/hero/:slug", function(slug) { HeroView.render(slug); });
Router.add("/maps", function() { MapsMainView.render(); });
Router.add("/map/:slug", function(slug) { MapView.render(slug); });
Router.add("/matches", function() { MatchesView.render(); });
Router.add("/match/:id", function(id) { MatchView.render(id); });
Router.add("/hall-of-fame", function() { HallOfFameView.render(); });
Router.add("/draft", function() { DraftView.render(); });

// Init
populateNav();
setupMobileNav();
initTalentTooltip();

// Close season dropdown when clicking outside
document.addEventListener("click", function(e) {
	if (_seasonDropdownOpen && !e.target.closest(".season-select")) {
		_seasonDropdownOpen = false;
		var dd = document.querySelector(".season-select-dropdown.open");
		if (dd) dd.classList.remove("open");
	}
});

document.addEventListener("click", function(e) {
	var btn = e.target.closest(".talent-copy-btn");
	if (!btn) return;
	var text = btn.getAttribute("data-copy");
	if (!text) return;
	navigator.clipboard.writeText(text).then(function() {
		btn.classList.add("copied");
		setTimeout(function() { btn.classList.remove("copied"); }, 1500);
	});
});

Router.start();

// Auto-attach top scrollbars when #app content changes
(function() {
	var pending = false;
	var app = document.getElementById('app');
	if (!app) return;

	new MutationObserver(function() {
		if (pending) return;
		pending = true;
		requestAnimationFrame(function() {
			pending = false;
			attachTopScrollbars();
		});
	}).observe(app, { childList: true, subtree: true });
})();
