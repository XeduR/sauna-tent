// Match history page: filterable, sortable, paginated match list
var MatchesView = (function() {
	var PAGE_SIZE = 50;
	var allMatches = null;
	var filtered = [];
	var sortKey = "timestamp";
	var sortDesc = true;
	var currentPage = 0;
	var aramMaps = [];
	var filterOptions = { heroes: [], maps: [], modes: [] };

	var TOTAL_ROSTER = 6;

	function defaultFilters() {
		return {
			players: { include: [], exclude: [] },
			heroesTeam: { include: [], exclude: [] },
			heroesOpponent: { include: [], exclude: [] },
			maps: { include: [], exclude: [] },
			mode: "",
			result: "",
			partySize: "",
			dateFrom: "",
			dateTo: ""
		};
	}

	var filters = defaultFilters();

	function collectFilterOptions(matches) {
		var heroSet = {};
		var mapSet = {};
		var modeSet = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			mapSet[m.map] = true;
			modeSet[m.gameMode] = true;
			for (var t in m.teams) {
				for (var j = 0; j < m.teams[t].length; j++) {
					heroSet[m.teams[t][j].hero] = true;
				}
			}
		}
		filterOptions.heroes = Object.keys(heroSet).sort();
		filterOptions.maps = Object.keys(mapSet).sort();
		filterOptions.modes = Object.keys(modeSet).sort();
	}

	// --- Filter logic ---

	function matchHasPlayer(m, playerName) {
		for (var j = 0; j < m.rosterPlayers.length; j++) {
			if (m.rosterPlayers[j].name === playerName) return true;
		}
		return false;
	}

	function matchHasPartySize(m, size) {
		for (var j = 0; j < m.rosterPlayers.length; j++) {
			if (m.rosterPlayers[j].partySize === size) return true;
		}
		return false;
	}

	function getRosterTeamId(m) {
		for (var t in m.teams) {
			for (var j = 0; j < m.teams[t].length; j++) {
				if (m.teams[t][j].isRoster) return t;
			}
		}
		return null;
	}

	function teamHasHeroes(teamPlayers, includeList, excludeList) {
		for (var h = 0; h < includeList.length; h++) {
			var found = false;
			for (var j = 0; j < teamPlayers.length; j++) {
				if (teamPlayers[j].hero === includeList[h]) { found = true; break; }
			}
			if (!found) return false;
		}
		for (var h = 0; h < excludeList.length; h++) {
			for (var j = 0; j < teamPlayers.length; j++) {
				if (teamPlayers[j].hero === excludeList[h]) return false;
			}
		}
		return true;
	}

	function applyFilters() {
		filtered = [];
		for (var i = 0; i < allMatches.length; i++) {
			var m = allMatches[i];

			// Player include: ALL must be present
			if (filters.players.include.length > 0) {
				var allPresent = true;
				for (var p = 0; p < filters.players.include.length; p++) {
					if (!matchHasPlayer(m, filters.players.include[p])) { allPresent = false; break; }
				}
				if (!allPresent) continue;
			}

			// Player exclude: NONE can be present
			if (filters.players.exclude.length > 0) {
				var anyPresent = false;
				for (var p = 0; p < filters.players.exclude.length; p++) {
					if (matchHasPlayer(m, filters.players.exclude[p])) { anyPresent = true; break; }
				}
				if (anyPresent) continue;
			}

			// Hero filters (team/opponent)
			var hasTeamHeroFilter = filters.heroesTeam.include.length > 0 || filters.heroesTeam.exclude.length > 0;
			var hasOpponentHeroFilter = filters.heroesOpponent.include.length > 0 || filters.heroesOpponent.exclude.length > 0;
			if (hasTeamHeroFilter || hasOpponentHeroFilter) {
				var rosterTeamId = getRosterTeamId(m);
				if (rosterTeamId === null) continue;
				var opponentTeamId = rosterTeamId === "0" ? "1" : "0";

				if (hasTeamHeroFilter) {
					if (!teamHasHeroes(m.teams[rosterTeamId] || [], filters.heroesTeam.include, filters.heroesTeam.exclude)) continue;
				}
				if (hasOpponentHeroFilter) {
					if (!teamHasHeroes(m.teams[opponentTeamId] || [], filters.heroesOpponent.include, filters.heroesOpponent.exclude)) continue;
				}
			}

			// Map include/exclude
			if (filters.maps.include.length > 0 && filters.maps.include.indexOf(m.map) === -1) continue;
			if (filters.maps.exclude.length > 0 && filters.maps.exclude.indexOf(m.map) !== -1) continue;

			// Mode (single value)
			if (filters.mode && m.gameMode !== filters.mode) continue;

			// Result
			if (filters.result && m.result !== filters.result) continue;

			// Party size
			if (filters.partySize && !matchHasPartySize(m, Number(filters.partySize))) continue;

			// Date range
			if (filters.dateFrom || filters.dateTo) {
				var matchDate = m.timestamp.substring(0, 10);
				if (filters.dateFrom && matchDate < filters.dateFrom) continue;
				if (filters.dateTo && matchDate > filters.dateTo) continue;
			}

			filtered.push(m);
		}
		sortFiltered();
		currentPage = 0;
	}

	// --- Sorting ---

	function sortFiltered() {
		filtered.sort(function(a, b) {
			var va = getSortValue(a, sortKey);
			var vb = getSortValue(b, sortKey);
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

	function getSortValue(m, key) {
		if (key === "timestamp") return m.timestamp;
		if (key === "map") return m.map;
		if (key === "gameMode") return displayModeName(m.gameMode);
		if (key === "duration") return m.durationSeconds;
		if (key === "result") return m.result;
		if (key === "partySize") {
			var max = 0;
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				if (m.rosterPlayers[j].partySize > max) max = m.rosterPlayers[j].partySize;
			}
			return max;
		}
		if (key === "players") {
			return m.rosterPlayers.length > 0 ? m.rosterPlayers[0].name : "";
		}
		return "";
	}

	// --- Filter bar builders ---

	function buildSelect(id, label, options, selectedValue) {
		var html = '<div class="filter-field">' +
			'<label for="' + id + '">' + label + '</label>' +
			'<select id="' + id + '">' +
			'<option value="">All</option>';
		for (var i = 0; i < options.length; i++) {
			var opt = options[i];
			var val = typeof opt === "object" ? opt.value : opt;
			var text = typeof opt === "object" ? opt.text : opt;
			var selected = val === selectedValue ? ' selected' : '';
			html += '<option value="' + escapeHtml(val) + '"' + selected + '>' + escapeHtml(text) + '</option>';
		}
		html += '</select></div>';
		return html;
	}

	function buildPlayerToggles(roster) {
		var html = '<div class="filter-section">' +
			'<div class="filter-section-label">Players</div>' +
			'<div class="player-toggles">';
		for (var i = 0; i < roster.players.length; i++) {
			var name = roster.players[i].name;
			var state = "neutral";
			if (filters.players.include.indexOf(name) !== -1) state = "include";
			else if (filters.players.exclude.indexOf(name) !== -1) state = "exclude";
			html += '<button class="player-toggle" data-player="' + escapeHtml(name) +
				'" data-state="' + state + '">' + escapeHtml(name) + '</button>';
		}
		html += '</div></div>';
		return html;
	}

	function buildTagSelector(id, label, allOptions, includeList, excludeList, displayFn) {
		if (!displayFn) displayFn = escapeHtml;

		// Filter out already-selected options from the dropdown
		var available = [];
		for (var i = 0; i < allOptions.length; i++) {
			var opt = allOptions[i];
			if (includeList.indexOf(opt) === -1 && excludeList.indexOf(opt) === -1) {
				available.push(opt);
			}
		}

		var html = '<div class="filter-tag-selector" id="' + id + '">' +
			'<label>' + label + '</label>' +
			'<div class="tag-selector-controls">' +
			'<select class="tag-selector-dropdown">' +
			'<option value="">Select...</option>';
		for (var i = 0; i < available.length; i++) {
			html += '<option value="' + escapeHtml(available[i]) + '">' + displayFn(available[i]) + '</option>';
		}
		html += '</select>' +
			'<button class="tag-btn-include" title="Include">+</button>' +
			'<button class="tag-btn-exclude" title="Exclude">&minus;</button>' +
			'</div><div class="tag-list">';

		for (var i = 0; i < includeList.length; i++) {
			html += '<span class="tag tag-include" data-value="' + escapeHtml(includeList[i]) +
				'" data-type="include">' + displayFn(includeList[i]) +
				' <button class="tag-remove">x</button></span>';
		}
		for (var i = 0; i < excludeList.length; i++) {
			html += '<span class="tag tag-exclude" data-value="' + escapeHtml(excludeList[i]) +
				'" data-type="exclude">' + displayFn(excludeList[i]) +
				' <button class="tag-remove">x</button></span>';
		}

		html += '</div></div>';
		return html;
	}

	function getAvailableMaps() {
		if (filters.mode === "ARAM") {
			return filterOptions.maps.filter(function(m) { return aramMaps.indexOf(m) !== -1; });
		}
		if (filters.mode === "StormLeague") {
			return filterOptions.maps.filter(function(m) { return aramMaps.indexOf(m) === -1; });
		}
		return filterOptions.maps;
	}

	function getPartyRange() {
		var min = Math.max(1, filters.players.include.length);
		var max = Math.min(5, TOTAL_ROSTER - filters.players.exclude.length);
		return { min: min, max: max };
	}

	function buildPartySelect() {
		if (filters.mode === "Custom") {
			filters.partySize = "5";
			return '<div class="filter-field">' +
				'<label>Party Size</label>' +
				'<select id="filter-party" disabled title="Custom games only support 5-stacks"><option value="5" selected>5-stack</option></select></div>';
		}
		var range = getPartyRange();
		var options = [];
		for (var s = range.min; s <= range.max; s++) {
			options.push({ value: String(s), text: PARTY_LABELS[s] || s + "-stack" });
		}
		if (range.max < range.min) {
			return '<div class="filter-field">' +
				'<label>Party Size</label>' +
				'<select disabled><option>N/A</option></select></div>';
		}
		return buildSelect("filter-party", "Party Size", options, filters.partySize || "");
	}

	function buildFilterBar(roster) {
		var html = '<div class="filter-bar">';

		// Reset button (top-right corner)
		html += '<button id="filter-reset" class="btn btn-reset">Reset filters</button>';

		// GENERAL section
		html += '<div class="filter-bar-section">' +
			'<div class="filter-bar-heading">General</div>';

		var modeOptions = [];
		for (var i = 0; i < filterOptions.modes.length; i++) {
			var raw = filterOptions.modes[i];
			modeOptions.push({ value: raw, text: displayModeName(raw) });
		}

		html += '<div class="filter-row">';
		html += buildSelect("filter-mode", "Mode", modeOptions, filters.mode || "");
		html += buildSelect("filter-result", "Result", [
			{ value: "win", text: "Win" },
			{ value: "loss", text: "Loss" }
		], filters.result || "");
		html += buildPartySelect();
		html += '<div class="filter-field">' +
			'<label for="filter-date-from">From</label>' +
			'<input type="date" id="filter-date-from" value="' + (filters.dateFrom || "") + '">' +
			'</div>';
		html += '<div class="filter-field">' +
			'<label for="filter-date-to">To</label>' +
			'<input type="date" id="filter-date-to" value="' + (filters.dateTo || "") + '">' +
			'</div>';
		html += '</div>';

		var mapDisplayFn = function(v) { return escapeHtml(displayMapName(v)); };
		html += '<div class="filter-section">' +
			buildTagSelector("filter-maps", "Maps", getAvailableMaps(),
				filters.maps.include, filters.maps.exclude, mapDisplayFn) +
			'</div>';

		html += '</div>';

		// Divider
		html += '<hr class="filter-bar-divider">';

		// TEAM COMPOSITIONS section
		html += '<div class="filter-bar-section">' +
			'<div class="filter-bar-heading">Team Compositions</div>';

		html += buildPlayerToggles(roster);

		html += '<div class="filter-section-label">Heroes</div>';

		html += '<div class="filter-section">' +
			buildTagSelector("filter-heroes-team", "Your Team", filterOptions.heroes,
				filters.heroesTeam.include, filters.heroesTeam.exclude) +
			'</div>';

		html += '<div class="filter-section">' +
			buildTagSelector("filter-heroes-opponent", "Opposing Team", filterOptions.heroes,
				filters.heroesOpponent.include, filters.heroesOpponent.exclude) +
			'</div>';

		html += '</div>';

		html += '</div>';
		return html;
	}

	// --- Table ---

	function buildTable() {
		var start = currentPage * PAGE_SIZE;
		var end = Math.min(start + PAGE_SIZE, filtered.length);
		var page = filtered.slice(start, end);

		var columns = [
			{ key: "timestamp", label: "Date" },
			{ key: "matchId", label: "Match ID", noSort: true },
			{ key: "map", label: "Map" },
			{ key: "gameMode", label: "Mode" },
			{ key: "players", label: "Players" },
			{ key: "duration", label: "Duration" },
			{ key: "partySize", label: "Party" },
			{ key: "result", label: "Result" }
		];

		var html = '<div class="table-wrap"><table id="matches-table"><thead><tr>';
		for (var c = 0; c < columns.length; c++) {
			var col = columns[c];
			var cls = col.noSort ? "no-sort" : "";
			if (!col.noSort && col.key === sortKey) {
				cls = sortDesc ? "sort-desc" : "sort-asc";
			}
			html += '<th data-sort-key="' + col.key + '" class="' + cls + '">' + col.label + '</th>';
		}
		html += '</tr></thead><tbody>';

		for (var i = 0; i < page.length; i++) {
			var m = page[i];
			var resultClass = m.result === "win" ? "win" : (m.result === "loss" ? "loss" : "");
			var maxParty = 0;
			var playerParts = [];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				var playerHref = appLink('/player/' + slugify(rp.name));
				var heroHref = appLink('/hero/' + slugify(rp.hero));
				playerParts.push('<a href="' + playerHref + '">' + escapeHtml(rp.name) + '</a>' +
					' <a href="' + heroHref + '" class="hero-name">' + heroIconHtml(rp.hero) + escapeHtml(rp.hero) + '</a>');
				if (rp.partySize > maxParty) maxParty = rp.partySize;
			}

			var partyText = m.rosterPlayers.length > 0 ? (PARTY_LABELS[maxParty] || maxParty + "-stack") : "-";
			var playersCell = m.rosterPlayers.length > 0 ? playerParts.join(", ") : '<span class="text-muted">No roster players</span>';
			var mapHref = appLink('/map/' + slugify(m.map));

			html += '<tr class="match-row" data-match-id="' + m.matchId + '">' +
				'<td>' + formatDateFinnish(m.timestamp) + '</td>' +
				'<td class="match-id-cell"><a href="' + appLink('/match/' + m.matchId) + '">' + m.matchId.substring(0, 8) + '</a></td>' +
				'<td><a href="' + mapHref + '">' + escapeHtml(displayMapName(m.map)) + '</a></td>' +
				'<td>' + escapeHtml(displayModeName(m.gameMode)) + '</td>' +
				'<td class="players-cell">' + playersCell + '</td>' +
				'<td class="num">' + formatDuration(m.durationSeconds) + '</td>' +
				'<td class="num">' + escapeHtml(partyText) + '</td>' +
				'<td class="' + resultClass + '">' + escapeHtml(m.result) + '</td>' +
				'</tr>';
		}

		if (page.length === 0) {
			html += '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem;">No matches found</td></tr>';
		}

		html += '</tbody></table></div>';
		return html;
	}

	// --- Pagination ---

	function buildPagination() {
		var totalPages = Math.ceil(filtered.length / PAGE_SIZE);
		if (totalPages <= 1) return "";

		var html = '<div class="pagination">';

		if (currentPage > 0) {
			html += '<button class="btn btn-secondary page-btn" data-page="' + (currentPage - 1) + '">Prev</button>';
		}

		var startPage = Math.max(0, currentPage - 2);
		var endPage = Math.min(totalPages - 1, currentPage + 2);

		if (startPage > 0) {
			html += '<button class="btn btn-secondary page-btn" data-page="0">1</button>';
			if (startPage > 1) html += '<span class="page-ellipsis">...</span>';
		}

		for (var p = startPage; p <= endPage; p++) {
			var activeClass = p === currentPage ? " btn-active" : "";
			html += '<button class="btn btn-secondary page-btn' + activeClass + '" data-page="' + p + '">' + (p + 1) + '</button>';
		}

		if (endPage < totalPages - 1) {
			if (endPage < totalPages - 2) html += '<span class="page-ellipsis">...</span>';
			html += '<button class="btn btn-secondary page-btn" data-page="' + (totalPages - 1) + '">' + totalPages + '</button>';
		}

		if (currentPage < totalPages - 1) {
			html += '<button class="btn btn-secondary page-btn" data-page="' + (currentPage + 1) + '">Next</button>';
		}

		html += '</div>';
		return html;
	}

	// --- URL sync ---

	function writeMatchFiltersToURL() {
		var params = new URLSearchParams();
		if (filters.mode) params.set("m", filters.mode);
		if (filters.result) params.set("r", filters.result);
		if (filters.partySize) params.set("ps", filters.partySize);
		if (filters.dateFrom) params.set("df", filters.dateFrom);
		if (filters.dateTo) params.set("dt", filters.dateTo);
		if (filters.players.include.length) params.set("pi", filters.players.include.join(","));
		if (filters.players.exclude.length) params.set("pe", filters.players.exclude.join(","));
		if (filters.heroesTeam.include.length) params.set("hti", filters.heroesTeam.include.join(","));
		if (filters.heroesTeam.exclude.length) params.set("hte", filters.heroesTeam.exclude.join(","));
		if (filters.heroesOpponent.include.length) params.set("hoi", filters.heroesOpponent.include.join(","));
		if (filters.heroesOpponent.exclude.length) params.set("hoe", filters.heroesOpponent.exclude.join(","));
		if (filters.maps.include.length) params.set("mi", filters.maps.include.join(","));
		if (filters.maps.exclude.length) params.set("me", filters.maps.exclude.join(","));
		var qs = params.toString();
		history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
	}

	function readMatchFiltersFromURL() {
		var params = new URLSearchParams(window.location.search);
		if (!params.toString()) return;
		var splitNonEmpty = function(val) {
			return val ? val.split(",") : [];
		};
		if (params.has("m")) filters.mode = params.get("m");
		if (params.has("r")) filters.result = params.get("r");
		if (params.has("ps")) filters.partySize = params.get("ps");
		if (params.has("df")) filters.dateFrom = params.get("df");
		if (params.has("dt")) filters.dateTo = params.get("dt");
		if (params.has("pi")) filters.players.include = splitNonEmpty(params.get("pi"));
		if (params.has("pe")) filters.players.exclude = splitNonEmpty(params.get("pe"));
		if (params.has("hti")) filters.heroesTeam.include = splitNonEmpty(params.get("hti"));
		if (params.has("hte")) filters.heroesTeam.exclude = splitNonEmpty(params.get("hte"));
		if (params.has("hoi")) filters.heroesOpponent.include = splitNonEmpty(params.get("hoi"));
		if (params.has("hoe")) filters.heroesOpponent.exclude = splitNonEmpty(params.get("hoe"));
		if (params.has("mi")) filters.maps.include = splitNonEmpty(params.get("mi"));
		if (params.has("me")) filters.maps.exclude = splitNonEmpty(params.get("me"));
	}

	// --- Render ---

	function renderContent(roster) {
		writeMatchFiltersToURL();
		var app = document.getElementById("app");

		var html =
			'<div class="page-header"><h1>Match History</h1>' +
			'<div class="subtitle">' + filtered.length.toLocaleString() + ' out of ' +
			allMatches.length.toLocaleString() + ' matches</div></div>';

		html += buildFilterBar(roster);
		html += buildTable();
		html += buildPagination();

		app.innerHTML = html;
		attachListeners(roster);
	}

	// --- Event listeners ---

	function attachTagSelectorListeners(selectorId, filterObj, roster) {
		var container = document.getElementById(selectorId);
		if (!container) return;

		var dropdown = container.querySelector(".tag-selector-dropdown");
		var btnInclude = container.querySelector(".tag-btn-include");
		var btnExclude = container.querySelector(".tag-btn-exclude");

		function addTag(type) {
			var val = dropdown.value;
			if (!val) return;
			if (filterObj.include.indexOf(val) !== -1 || filterObj.exclude.indexOf(val) !== -1) return;
			filterObj[type].push(val);
			onFilterChange(roster);
		}

		btnInclude.addEventListener("click", function() { addTag("include"); });
		btnExclude.addEventListener("click", function() { addTag("exclude"); });

		var tags = container.querySelectorAll(".tag");
		for (var i = 0; i < tags.length; i++) {
			tags[i].addEventListener("click", function() {
				var val = this.getAttribute("data-value");
				var type = this.getAttribute("data-type");
				var idx = filterObj[type].indexOf(val);
				if (idx !== -1) filterObj[type].splice(idx, 1);
				onFilterChange(roster);
			});
		}
	}

	function onFilterChange(roster) {
		// Custom mode requires 5-stack
		if (filters.mode === "Custom") {
			filters.partySize = "5";
		} else if (filters.partySize) {
			// Clamp party size if outside valid range
			var range = getPartyRange();
			var ps = Number(filters.partySize);
			if (ps < range.min || ps > range.max) {
				filters.partySize = "";
			}
		}

		// Remove map tags that are no longer valid for the selected mode
		var validMaps = getAvailableMaps();
		filters.maps.include = filters.maps.include.filter(function(m) { return validMaps.indexOf(m) !== -1; });
		filters.maps.exclude = filters.maps.exclude.filter(function(m) { return validMaps.indexOf(m) !== -1; });

		applyFilters();
		renderContent(roster);
	}

	function attachListeners(roster) {
		var app = document.getElementById("app");

		// Sort headers
		var headers = app.querySelectorAll("#matches-table thead th:not(.no-sort)");
		for (var i = 0; i < headers.length; i++) {
			headers[i].addEventListener("click", function() {
				var key = this.getAttribute("data-sort-key");
				if (sortKey === key) {
					sortDesc = !sortDesc;
				} else {
					sortKey = key;
					sortDesc = key !== "map" && key !== "gameMode" && key !== "players";
				}
				sortFiltered();
				currentPage = 0;
				renderContent(roster);
			});
		}

		// Match row clicks
		var rows = app.querySelectorAll(".match-row");
		for (var i = 0; i < rows.length; i++) {
			rows[i].addEventListener("click", function(e) {
				if (e.target.tagName === "A" || e.target.closest("a")) return;
				if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
				var id = this.getAttribute("data-match-id");
				Router.navigate("/match/" + id);
			});
			rows[i].style.cursor = "pointer";
		}

		// Player toggle buttons
		var toggles = app.querySelectorAll(".player-toggle");
		for (var i = 0; i < toggles.length; i++) {
			toggles[i].addEventListener("click", function() {
				var name = this.getAttribute("data-player");
				var state = this.getAttribute("data-state");
				var incIdx = filters.players.include.indexOf(name);
				var excIdx = filters.players.exclude.indexOf(name);

				// Cycle: neutral -> include -> exclude -> neutral
				if (state === "neutral") {
					filters.players.include.push(name);
				} else if (state === "include") {
					if (incIdx !== -1) filters.players.include.splice(incIdx, 1);
					filters.players.exclude.push(name);
				} else {
					if (excIdx !== -1) filters.players.exclude.splice(excIdx, 1);
				}
				onFilterChange(roster);
			});
		}

		// Simple select filters
		var modeEl = document.getElementById("filter-mode");
		if (modeEl) {
			modeEl.addEventListener("change", function() {
				filters.mode = this.value;
				onFilterChange(roster);
			});
		}

		var resultEl = document.getElementById("filter-result");
		if (resultEl) {
			resultEl.addEventListener("change", function() {
				filters.result = this.value;
				applyFilters();
				renderContent(roster);
			});
		}

		var partyEl = document.getElementById("filter-party");
		if (partyEl) {
			partyEl.addEventListener("change", function() {
				filters.partySize = this.value;
				applyFilters();
				renderContent(roster);
			});
		}

		// Date filters
		var dateFrom = document.getElementById("filter-date-from");
		var dateTo = document.getElementById("filter-date-to");
		if (dateFrom) {
			dateFrom.addEventListener("change", function() {
				filters.dateFrom = this.value;
				applyFilters();
				renderContent(roster);
			});
		}
		if (dateTo) {
			dateTo.addEventListener("change", function() {
				filters.dateTo = this.value;
				applyFilters();
				renderContent(roster);
			});
		}

		// Tag selector listeners
		attachTagSelectorListeners("filter-heroes-team", filters.heroesTeam, roster);
		attachTagSelectorListeners("filter-heroes-opponent", filters.heroesOpponent, roster);
		attachTagSelectorListeners("filter-maps", filters.maps, roster);

		// Reset button
		var resetBtn = document.getElementById("filter-reset");
		if (resetBtn) {
			resetBtn.addEventListener("click", function() {
				filters = defaultFilters();
				applyFilters();
				renderContent(roster);
			});
		}

		// Pagination
		var pageButtons = app.querySelectorAll(".page-btn");
		for (var i = 0; i < pageButtons.length; i++) {
			pageButtons[i].addEventListener("click", function() {
				currentPage = Number(this.getAttribute("data-page"));
				renderContent(roster);
			});
		}
	}

	// --- Entry point ---

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML =
			'<div class="page-header"><h1>Match History</h1>' +
			'<div class="subtitle">Loading match data...</div></div>' +
			'<div class="loading">Loading match index (this may take a moment)...</div>';

		filters = defaultFilters();
		sortKey = "timestamp";
		sortDesc = true;

		try {
			var results = await Promise.all([Data.matchIndex(), Data.roster(), Data.summary(), Data.settings()]);
			allMatches = results[0];
			var roster = results[1];
			var summary = results[2];
			PAGE_SIZE = AppSettings.matches.pageSize;
			TOTAL_ROSTER = AppSettings.rosterSize;

			aramMaps = summary.aramMaps || [];
			collectFilterOptions(allMatches);
			readMatchFiltersFromURL();
			applyFilters();
			renderContent(roster);
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load match data: ' + escapeHtml(err.message) + '</div>';
		}
	}

	return { render: render };
})();
