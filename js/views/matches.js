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
	var loungeRegistry = null;
	var loungeRegistryFailed = false;
	var loungeRegistryById = {};
	var loungeIndexedGames = {};

	var TOTAL_ROSTER = 6;

	var SERIES_PATH_ROWS = [
		{ label: "Game 1", game: 1, prior: [] },
		{ label: "Game 2 after winning game 1", game: 2, prior: ["win"] },
		{ label: "Game 2 after losing game 1", game: 2, prior: ["loss"] },
		{ label: "Game 3 after win-loss", game: 3, prior: ["win", "loss"] },
		{ label: "Game 3 after loss-win", game: 3, prior: ["loss", "win"] }
	];

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
			dateTo: "",
			seasons: ""
		};
	}

	var filters = defaultFilters();

	function collectFilterOptions(matches) {
		var heroSet = {};
		var mapSet = {};
		var modeSet = {};
		var hasLounge = false;
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			mapSet[m.map] = true;
			// Custom games surface only as the Lounge option.
			if (m.gameMode !== "Custom") modeSet[m.gameMode] = true;
			if (m.lounge) hasLounge = true;
			for (var t in m.teams) {
				for (var j = 0; j < m.teams[t].length; j++) {
					heroSet[m.teams[t][j].hero] = true;
				}
			}
		}
		filterOptions.heroes = Object.keys(heroSet).sort();
		filterOptions.maps = Object.keys(mapSet).sort();
		filterOptions.modes = Object.keys(modeSet).sort();
		if (hasLounge) filterOptions.modes = withLoungeMode(filterOptions.modes);
	}

	function withLoungeMode(modes) {
		if (modes.indexOf("Lounge") !== -1) return modes;
		return modes.concat(["Lounge"]);
	}

	function indexLoungeData(matches, registry) {
		loungeRegistry = registry;
		loungeRegistryById = {};
		loungeIndexedGames = {};
		if (registry && registry.matches) {
			for (var i = 0; i < registry.matches.length; i++) {
				loungeRegistryById[registry.matches[i].id] = registry.matches[i];
			}
		}

		for (var j = 0; j < matches.length; j++) {
			var stamp = matches[j].lounge;
			if (!stamp) continue;
			if (!loungeIndexedGames[stamp.id]) loungeIndexedGames[stamp.id] = {};
			loungeIndexedGames[stamp.id][stamp.game] = true;
		}
	}

	function displayEntryMode(m) {
		return m.lounge ? "Lounge" : displayModeName(m.gameMode);
	}

	// --- Filter logic ---

	function matchHasPlayer(m, playerName) {
		for (var j = 0; j < m.rosterPlayers.length; j++) {
			if (m.rosterPlayers[j].name === playerName) return true;
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
		var base = MatchIndexUtils.filter(allMatches, filters);

		filtered = [];
		for (var i = 0; i < base.length; i++) {
			var m = base[i];

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

			// Result
			if (filters.result && m.result !== filters.result) continue;

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
		if (key === "gameMode") return displayEntryMode(m);
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
		var showAlts = window.GlobalFilters && !window.GlobalFilters.getNoAlts();
		if (showAlts && roster.alts) {
			for (var ai = 0; ai < roster.alts.length; ai++) {
				var altName = roster.alts[ai].name;
				var altState = "neutral";
				if (filters.players.include.indexOf(altName) !== -1) altState = "include";
				else if (filters.players.exclude.indexOf(altName) !== -1) altState = "exclude";
				html += '<button class="player-toggle player-toggle-alt" data-player="' + escapeHtml(altName) +
					'" data-state="' + altState + '">' + escapeHtml(altName) +
					' <span class="nav-alt-tag">alt</span></button>';
			}
		}
		html += '</div></div>';
		return html;
	}

	function buildTagSelector(id, label, allOptions, includeList, excludeList, displayFn) {
		if (!displayFn) displayFn = function(v) { return v; };

		// Filter out already-selected options from the dropdown
		var available = [];
		for (var i = 0; i < allOptions.length; i++) {
			var opt = allOptions[i];
			if (includeList.indexOf(opt) === -1 && excludeList.indexOf(opt) === -1) {
				available.push(opt);
			}
		}

		var searchItems = [];
		for (var i = 0; i < available.length; i++) {
			searchItems.push({ value: available[i], text: displayFn(available[i]) });
		}

		var searchId = id + '-search';
		var html = '<div class="filter-tag-selector" id="' + id + '">' +
			'<label>' + label + '</label>' +
			'<div class="tag-selector-controls">' +
			SearchSelect.renderHtml({
				id: searchId,
				value: '',
				placeholder: 'Select...',
				items: searchItems
			}) +
			'<button class="tag-btn-include" title="Include">+</button>' +
			'<button class="tag-btn-exclude" title="Exclude">&minus;</button>' +
			'</div><div class="tag-list">';

		for (var i = 0; i < includeList.length; i++) {
			html += '<span class="tag tag-include" data-value="' + escapeHtml(includeList[i]) +
				'" data-type="include">' + escapeHtml(displayFn(includeList[i])) +
				' <button class="tag-remove">x</button></span>';
		}
		for (var i = 0; i < excludeList.length; i++) {
			html += '<span class="tag tag-exclude" data-value="' + escapeHtml(excludeList[i]) +
				'" data-type="exclude">' + escapeHtml(displayFn(excludeList[i])) +
				' <button class="tag-remove">x</button></span>';
		}

		html += '</div></div>';
		return html;
	}

	function getAvailableMaps() {
		if (filters.mode === "ARAM") {
			return filterOptions.maps.filter(function(m) { return aramMaps.indexOf(m) !== -1; });
		}
		if (filters.mode === "StormLeague" || filters.mode === "Lounge") {
			return filterOptions.maps.filter(function(m) { return aramMaps.indexOf(m) === -1; });
		}
		return filterOptions.maps;
	}

	function getPartyRange() {
		var min = Math.max(isCustomMode(filters.mode) ? CUSTOM_MIN_PARTY_SIZE : 1, filters.players.include.length);
		var max = Math.min(5, TOTAL_ROSTER - filters.players.exclude.length);
		return { min: min, max: max };
	}

	function buildPartySelect() {
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

		// Before the first intake no entry is stamped, yet m=Lounge must still show as selected.
		var modes = filters.mode === "Lounge" ? withLoungeMode(filterOptions.modes) : filterOptions.modes;
		var modeOptions = [];
		for (var i = 0; i < modes.length; i++) {
			var raw = modes[i];
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

		// Matches builds its own season dropdown instead of using the shared
		// buildPageFilterBar because it combines season/date/result/party into
		// a single filter bar with custom layout and match-specific logic.
		// _seasonDropdownOpen is a global declared in app.js, shared by design
		// so the dropdown state persists across view re-renders.
		if (window.AppSeasons) {
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
				'<button type="button" class="season-select-btn" id="filter-season-btn">' + escapeHtml(btnText) + '</button>' +
				'<div class="' + dropdownCls + '" id="filter-season-dropdown">';
			for (var si = seasons.length - 1; si >= 0; si--) {
				var s = seasons[si];
				var checked = selectedSeasons.indexOf(String(s.number)) !== -1 ? " checked" : "";
				html += '<label class="season-option">' +
					'<input type="checkbox" value="' + s.number + '"' + checked + '> ' +
					escapeHtml(s.name) + '</label>';
			}
			html += '</div></div></div>';
		}

		html += '</div>';

		html += '<div class="filter-section">' +
			buildTagSelector("filter-maps", "Maps", getAvailableMaps(),
				filters.maps.include, filters.maps.exclude, displayMapName) +
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

	var MATCH_COLUMNS = [
		{ key: "timestamp", label: "Date" },
		{ key: "matchId", label: "Match ID", noSort: true },
		{ key: "map", label: "Map" },
		{ key: "gameMode", label: "Mode" },
		{ key: "players", label: "Players" },
		{ key: "duration", label: "Duration" },
		{ key: "partySize", label: "Party" },
		{ key: "result", label: "Result" }
	];

	function buildTableHead(sortable) {
		var html = '<thead><tr>';
		for (var c = 0; c < MATCH_COLUMNS.length; c++) {
			var col = MATCH_COLUMNS[c];
			var cls = "no-sort";
			if (sortable && !col.noSort) {
				cls = col.key === sortKey ? (sortDesc ? "sort-desc" : "sort-asc") : "";
			}
			html += '<th data-sort-key="' + col.key + '" class="' + cls + '">' + col.label + '</th>';
		}
		return html + '</tr></thead>';
	}

	function resultCellClass(result) {
		return result === "win" ? "win" : (result === "loss" ? "loss" : "");
	}

	function buildMatchRow(m) {
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

		return '<tr class="match-row" data-match-id="' + m.matchId + '">' +
			'<td>' + formatDateFinnish(m.timestamp) + '</td>' +
			'<td class="match-id-cell"><a href="' + appLink('/match/' + m.matchId) + '">' + m.matchId.substring(0, 8) + '</a></td>' +
			'<td><a href="' + mapHref + '">' + escapeHtml(displayMapName(m.map)) + '</a></td>' +
			'<td>' + escapeHtml(displayEntryMode(m)) + '</td>' +
			'<td class="players-cell">' + playersCell + '</td>' +
			'<td class="num">' + formatDuration(m.durationSeconds) + '</td>' +
			'<td class="num">' + escapeHtml(partyText) + '</td>' +
			'<td class="' + resultCellClass(m.result) + '">' + escapeHtml(m.result) + '</td>' +
			'</tr>';
	}

	function buildTable() {
		var start = currentPage * PAGE_SIZE;
		var end = Math.min(start + PAGE_SIZE, filtered.length);
		var page = filtered.slice(start, end);

		var html = '<div class="table-wrap"><table id="matches-table">' + buildTableHead(true) + '<tbody>';
		for (var i = 0; i < page.length; i++) {
			html += buildMatchRow(page[i]);
		}

		if (page.length === 0) {
			html += '<tr><td colspan="8" class="text-muted table-empty">No matches found</td></tr>';
		}

		html += '</tbody></table></div>';
		return html;
	}

	// --- Lounge mode ---

	function buildMissingGameRow(stamp, gameNumber) {
		var registryMatch = loungeRegistryById[stamp.id];
		var registryGame = null;
		if (registryMatch && registryMatch.games) {
			for (var g = 0; g < registryMatch.games.length; g++) {
				if (registryMatch.games[g].game === gameNumber) registryGame = registryMatch.games[g];
			}
		}

		// A rejected or removed replay exists upstream, so only no-replay may claim the upload is missing.
		var reason = registryGame && registryGame.status === "no-replay" ? "No replay uploaded" : "Not in the dataset";
		var mapName = registryGame && registryGame.map ? displayMapName(registryGame.map) : "-";
		var result = stamp.results[gameNumber - 1] || "";

		return '<tr class="match-row-missing">' +
			'<td>' + (stamp.scheduled ? escapeHtml(formatDateFinnish(stamp.scheduled)) : "-") + '</td>' +
			'<td>-</td>' +
			'<td>' + escapeHtml(mapName) + '</td>' +
			'<td>Lounge</td>' +
			'<td class="players-cell">' + reason + '</td>' +
			'<td class="num">-</td>' +
			'<td class="num">-</td>' +
			'<td class="' + resultCellClass(result) + '">' + escapeHtml(result || "-") + '</td>' +
			'</tr>';
	}

	function loungeSeriesHeading(series, forfeit) {
		var text = (series.stage === "bracket" ? "Playoffs: " : "") + (series.round || "") +
			" vs " + (series.opponent ? series.opponent.name : "");
		if (series.scheduled) text += " - " + formatDateFinnish(series.scheduled);

		var score = series.score ? series.score[0] + "-" + series.score[1] : "";
		if (forfeit) text += " (forfeit" + (score ? ", " + score : "") + ")";
		else if (score) text += " (" + score + ")";
		return escapeHtml(text);
	}

	function forfeitsVisible() {
		var defaults = defaultFilters();
		for (var key in defaults) {
			if (key === "mode" || key === "dateFrom" || key === "dateTo") continue;
			if (JSON.stringify(filters[key]) !== JSON.stringify(defaults[key])) return false;
		}
		return true;
	}

	function scheduledPassesDates(scheduled) {
		if (!filters.dateFrom && !filters.dateTo) return true;
		if (!scheduled) return false;
		var day = scheduled.substring(0, 10);
		if (filters.dateFrom && day < filters.dateFrom) return false;
		if (filters.dateTo && day > filters.dateTo) return false;
		return true;
	}

	function collectLoungeSeries() {
		var byId = {};
		var list = [];
		for (var i = 0; i < filtered.length; i++) {
			var stamp = filtered[i].lounge;
			if (!stamp) continue;
			if (!byId[stamp.id]) {
				byId[stamp.id] = { info: stamp, games: [], forfeit: false, sortTime: 0 };
				list.push(byId[stamp.id]);
			}
			byId[stamp.id].games.push(filtered[i]);
		}

		if (loungeRegistry && loungeRegistry.matches && forfeitsVisible()) {
			for (var f = 0; f < loungeRegistry.matches.length; f++) {
				var match = loungeRegistry.matches[f];
				if (match.status !== "forfeit" || !scheduledPassesDates(match.scheduled)) continue;
				list.push({ info: match, games: [], forfeit: true, sortTime: 0 });
			}
		}

		for (var s = 0; s < list.length; s++) {
			var series = list[s];
			series.games.sort(function(a, b) { return a.lounge.game - b.lounge.game; });
			if (series.info.scheduled) {
				series.sortTime = Date.parse(series.info.scheduled);
			} else {
				for (var g = 0; g < series.games.length; g++) {
					series.sortTime = Math.max(series.sortTime, Date.parse(series.games[g].timestamp));
				}
			}
		}
		list.sort(function(a, b) { return b.sortTime - a.sortTime; });
		return list;
	}

	function buildLoungeSeries(series) {
		if (series.forfeit) {
			return '<div class="lounge-series"><h3 class="lounge-series-heading text-muted">' +
				loungeSeriesHeading(series.info, true) + '</h3></div>';
		}

		var stamp = series.info;
		var indexed = loungeIndexedGames[stamp.id] || {};
		var html = '<div class="lounge-series"><h3 class="lounge-series-heading">' + loungeSeriesHeading(stamp, false) + '</h3>' +
			'<div class="table-wrap"><table>' + buildTableHead(false) + '<tbody>';

		var next = 0;
		var played = stamp.results ? stamp.results.length : 0;
		for (var n = 1; n <= played; n++) {
			if (!indexed[n]) {
				html += buildMissingGameRow(stamp, n);
				continue;
			}
			while (next < series.games.length && series.games[next].lounge.game <= n) {
				if (series.games[next].lounge.game === n) html += buildMatchRow(series.games[next]);
				next++;
			}
		}

		// Games beyond the stamped results list still render rather than vanish.
		for (; next < series.games.length; next++) {
			html += buildMatchRow(series.games[next]);
		}
		return html + '</tbody></table></div></div>';
	}

	function buildLoungeSeasons() {
		var seriesList = collectLoungeSeries();
		if (seriesList.length === 0) {
			return '<div class="text-muted table-empty">No matches found</div>';
		}

		// The series list is newest first, so first appearance orders seasons by their latest series.
		var seasons = [];
		var bySeason = {};
		for (var i = 0; i < seriesList.length; i++) {
			var label = seriesList[i].info.season || "Unknown season";
			if (!bySeason[label]) {
				bySeason[label] = [];
				seasons.push(label);
			}
			bySeason[label].push(seriesList[i]);
		}

		var html = "";
		for (var s = 0; s < seasons.length; s++) {
			html += '<section class="lounge-season"><h2 class="section-title">' + escapeHtml(seasons[s]) + '</h2>';
			for (var j = 0; j < bySeason[seasons[s]].length; j++) {
				html += buildLoungeSeries(bySeason[seasons[s]][j]);
			}
			html += '</section>';
		}
		return html;
	}

	function buildSeriesPathTable() {
		var counts = [];
		for (var c = 0; c < SERIES_PATH_ROWS.length; c++) counts.push({ games: 0, wins: 0 });

		for (var i = 0; i < filtered.length; i++) {
			var stamp = filtered[i].lounge;
			if (!stamp || stamp.stage !== "regular" || typeof stamp.seasonNumber !== "number" || stamp.bestOf !== 3) continue;
			var results = stamp.results || [];
			for (var r = 0; r < SERIES_PATH_ROWS.length; r++) {
				var row = SERIES_PATH_ROWS[r];
				if (stamp.game !== row.game) continue;
				var pathMatches = true;
				for (var p = 0; p < row.prior.length; p++) {
					if (results[p] !== row.prior[p]) { pathMatches = false; break; }
				}
				if (!pathMatches) continue;
				counts[r].games++;
				if (filtered[i].result === "win") counts[r].wins++;
			}
		}

		var rows = [];
		var rowOrder = [];
		for (var k = 0; k < SERIES_PATH_ROWS.length; k++) {
			rowOrder.push(SERIES_PATH_ROWS[k].label);
			if (counts[k].games === 0) continue;
			counts[k].winrate = counts[k].wins / counts[k].games;
			rows.push([SERIES_PATH_ROWS[k].label, counts[k]]);
		}
		if (rows.length === 0) return "";

		var description = '<p class="text-muted section-description">' +
			'Win rate of each game in main-season best-of-3 series, split by the results of the earlier games in the same series. ' +
			'Playoffs, cups, offseason and special events are excluded. ' +
			'Every counted game must also match the current filters.' +
			'</p>';
		var conditionSortFn = function(condition) { return rowOrder.indexOf(condition); };
		return renderMetaFactorTable("Win Rate by Series Path", rows, conditionSortFn, description);
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
		if (params.has("m")) filters.mode = canonicalMode(params.get("m"));
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
		if (filters.mode === "Lounge") {
			html += buildSeriesPathTable();
			if (loungeRegistryFailed) {
				html += '<p class="text-muted">Heroes Lounge registry failed to load; forfeits and missing-game details are not shown.</p>';
			}
			html += buildLoungeSeasons();
		} else {
			html += buildTable();
			html += buildPagination();
		}

		app.innerHTML = html;
		attachAllSortableListeners(app);
		attachListeners(roster);
	}

	// --- Event listeners ---

	function attachTagSelectorListeners(selectorId, filterObj, roster) {
		var container = document.getElementById(selectorId);
		if (!container) return;

		var searchId = selectorId + '-search';
		SearchSelect.attach(searchId);

		var btnInclude = container.querySelector(".tag-btn-include");
		var btnExclude = container.querySelector(".tag-btn-exclude");

		function addTag(type) {
			var val = SearchSelect.getValue(searchId);
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
		if (filters.partySize) {
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
				if (this.value !== "StormLeague") {
					filters.seasons = "";
					_seasonDropdownOpen = false;
				}
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
				if (this.value) {
					filters.seasons = "";
					_seasonDropdownOpen = false;
				}
				applyFilters();
				renderContent(roster);
			});
		}
		if (dateTo) {
			dateTo.addEventListener("change", function() {
				filters.dateTo = this.value;
				if (this.value) {
					filters.seasons = "";
					_seasonDropdownOpen = false;
				}
				applyFilters();
				renderContent(roster);
			});
		}

		// Season multi-select dropdown
		var seasonBtn = document.getElementById("filter-season-btn");
		var seasonDropdown = document.getElementById("filter-season-dropdown");
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
					onFilterChange(roster);
				});
			}
		}

		// Tag selector listeners
		attachTagSelectorListeners("filter-heroes-team", filters.heroesTeam, roster);
		attachTagSelectorListeners("filter-heroes-opponent", filters.heroesOpponent, roster);
		attachTagSelectorListeners("filter-maps", filters.maps, roster);

		// Reset button
		var resetBtn = document.getElementById("filter-reset");
		if (resetBtn) {
			resetBtn.addEventListener("click", function() {
				_seasonDropdownOpen = false;
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

			// The registry only adds Lounge detail, so its failure must not take down the match list.
			var registry = null;
			loungeRegistryFailed = false;
			if (allMatches.some(function(m) { return !!m.lounge; })) {
				try {
					registry = await Data.lounge();
				} catch (registryErr) {
					console.error("Heroes Lounge registry failed to load:", registryErr);
					loungeRegistryFailed = true;
				}
			}
			indexLoungeData(allMatches, registry);

			aramMaps = summary.aramMaps || [];
			collectFilterOptions(allMatches);
			readMatchFiltersFromURL();
			clampPartySizeForMode(filters, defaultFilters());
			applyFilters();
			renderContent(roster);
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load match data: ' + escapeHtml(err.message) + '</div>';
		}
	}

	return { render: render };
})();
