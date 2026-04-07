// Combo analysis: hero + talent combination win rates from match history
var CombosView = (function() {
	var filters = { mode: "", map: "", partySize: "", dateFrom: "", dateTo: "", seasons: "" };
	var defaults = { mode: "", map: "", partySize: "", dateFrom: "", dateTo: "", seasons: "" };
	var matchIndex = null;
	var talentData = null;
	var allHeroes = [];
	var allyPicks = ["", "", "", "", ""];
	// Per-slot talent selections: 5 arrays of 7 ints (0 = any, 1-4 = specific talent)
	var allyTalents = [null, null, null, null, null];

	function initTalents() {
		for (var i = 0; i < 5; i++) {
			if (!allyTalents[i]) allyTalents[i] = [0, 0, 0, 0, 0, 0, 0];
		}
	}

	function getAvailableMaps() {
		var mapSet = {};
		for (var i = 0; i < matchIndex.length; i++) {
			mapSet[matchIndex[i].map] = true;
		}
		return Object.keys(mapSet).sort();
	}

	function prepareHeroList(filtered) {
		var heroSet = {};
		for (var i = 0; i < filtered.length; i++) {
			var rps = filtered[i].rosterPlayers;
			for (var j = 0; j < rps.length; j++) {
				heroSet[rps[j].hero] = true;
			}
		}
		allHeroes = Object.keys(heroSet).sort();
	}

	function availableHeroes(currentValue) {
		var picked = {};
		for (var i = 0; i < allyPicks.length; i++) {
			if (allyPicks[i] && allyPicks[i] !== currentValue) picked[allyPicks[i]] = true;
		}
		var result = [];
		for (var i = 0; i < allHeroes.length; i++) {
			if (!picked[allHeroes[i]]) result.push(allHeroes[i]);
		}
		return result;
	}

	// Count games per hero when combined with picks in other slots (respects talent constraints)
	function computeHeroComboCounts(filtered, excludeSlot) {
		var otherPicks = [];
		for (var i = 0; i < 5; i++) {
			if (i === excludeSlot || !allyPicks[i]) continue;
			otherPicks.push({ hero: allyPicks[i], talents: allyTalents[i] });
		}
		if (otherPicks.length === 0) return null;

		var baseMatches = [];
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			var rps = m.rosterPlayers;
			var allMatch = true;
			for (var h = 0; h < otherPicks.length; h++) {
				var sel = otherPicks[h];
				var found = false;
				for (var j = 0; j < rps.length; j++) {
					if (rps[j].hero !== sel.hero) continue;
					var tc = rps[j].talentChoices;
					var ok = true;
					for (var t = 0; t < 7; t++) {
						if (sel.talents[t] > 0 && (!tc || tc.length <= t || tc[t] !== sel.talents[t])) {
							ok = false;
							break;
						}
					}
					if (ok) { found = true; break; }
				}
				if (!found) { allMatch = false; break; }
			}
			if (allMatch) baseMatches.push(m);
		}

		var counts = {};
		for (var i = 0; i < baseMatches.length; i++) {
			var rps = baseMatches[i].rosterPlayers;
			for (var j = 0; j < rps.length; j++) {
				counts[rps[j].hero] = (counts[rps[j].hero] || 0) + 1;
			}
		}
		return counts;
	}

	function renderHeroSelect(id, value, comboCounts) {
		var options = availableHeroes(value);

		var hasAnyGames = false;
		if (comboCounts) {
			for (var i = 0; i < options.length; i++) {
				if (comboCounts[options[i]] > 0) { hasAnyGames = true; break; }
			}
		}

		var disabled = comboCounts && !hasAnyGames && !value;
		var html = '<select id="' + id + '" class="draft-hero-select"' +
			(disabled ? ' disabled' : '') + '>' +
			'<option value="">-- Select Hero --</option>';

		if (comboCounts) {
			var withGames = [];
			var noGames = [];
			for (var i = 0; i < options.length; i++) {
				if ((comboCounts[options[i]] || 0) > 0) {
					withGames.push(options[i]);
				} else {
					noGames.push(options[i]);
				}
			}

			for (var i = 0; i < withGames.length; i++) {
				var h = withGames[i];
				html += '<option value="' + escapeHtml(h) + '"' +
					(h === value ? ' selected' : '') + '>' +
					escapeHtml(h) + ' (' + comboCounts[h] + ' games)</option>';
			}
			if (withGames.length > 0 && noGames.length > 0) {
				html += '<option disabled>---</option>';
			}
			for (var i = 0; i < noGames.length; i++) {
				var h = noGames[i];
				html += '<option value="' + escapeHtml(h) + '" disabled>' +
					escapeHtml(h) + ' (0 games)</option>';
			}
		} else {
			for (var i = 0; i < options.length; i++) {
				var h = options[i];
				html += '<option value="' + escapeHtml(h) + '"' +
					(h === value ? ' selected' : '') + '>' + escapeHtml(h) + '</option>';
			}
		}

		html += '</select>';
		return html;
	}

	// Count games per talent choice for a slot's hero, per tier.
	// For each tier, constraints include all other slots + this slot's other tier selections.
	// Returns array of 7 objects: [{choiceNum: gameCount, ...}, ...]
	function computeTalentCounts(filtered, slotIndex) {
		var heroName = allyPicks[slotIndex];
		if (!heroName) return null;

		// Constraints from other slots
		var otherPicks = [];
		for (var i = 0; i < 5; i++) {
			if (i === slotIndex || !allyPicks[i]) continue;
			otherPicks.push({ hero: allyPicks[i], talents: allyTalents[i] });
		}

		// Find base roster player entries: other heroes match + this hero present
		var baseEntries = [];
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			var rps = m.rosterPlayers;

			var othersMatch = true;
			for (var h = 0; h < otherPicks.length; h++) {
				var sel = otherPicks[h];
				var found = false;
				for (var j = 0; j < rps.length; j++) {
					if (rps[j].hero !== sel.hero) continue;
					var tc = rps[j].talentChoices;
					var ok = true;
					for (var t = 0; t < 7; t++) {
						if (sel.talents[t] > 0 && (!tc || tc.length <= t || tc[t] !== sel.talents[t])) {
							ok = false;
							break;
						}
					}
					if (ok) { found = true; break; }
				}
				if (!found) { othersMatch = false; break; }
			}
			if (!othersMatch) continue;

			for (var j = 0; j < rps.length; j++) {
				if (rps[j].hero === heroName) {
					baseEntries.push(rps[j]);
					break;
				}
			}
		}

		// For each tier, filter by this slot's OTHER tier selections, count choices
		var result = [];
		for (var tier = 0; tier < 7; tier++) {
			var counts = {};
			for (var i = 0; i < baseEntries.length; i++) {
				var tc = baseEntries[i].talentChoices;
				if (!tc) continue;

				var otherTiersOk = true;
				for (var ot = 0; ot < 7; ot++) {
					if (ot === tier) continue;
					if (allyTalents[slotIndex][ot] > 0 && (tc.length <= ot || tc[ot] !== allyTalents[slotIndex][ot])) {
						otherTiersOk = false;
						break;
					}
				}
				if (!otherTiersOk) continue;

				var choice = tier < tc.length ? tc[tier] : 0;
				if (choice > 0) {
					counts[choice] = (counts[choice] || 0) + 1;
				}
			}
			result.push(counts);
		}
		return result;
	}

	// Get available talents for a hero at a given tier index
	function getHeroTalents(heroName, tierIndex) {
		var slug = slugify(heroName);
		var level = TALENT_TIERS[tierIndex];
		var names = talentData && talentData.names ? talentData.names[slug] : null;
		if (!names) return [];
		var talents = [];
		for (var choice = 1; choice <= 5; choice++) {
			var key = level + "_" + choice;
			if (names[key]) {
				talents.push(choice);
			}
		}
		return talents;
	}

	function renderTalentRow(slotIndex, tierIndex, tierCounts) {
		var heroName = allyPicks[slotIndex];
		var talents = getHeroTalents(heroName, tierIndex);
		var selectedChoice = allyTalents[slotIndex][tierIndex];
		var level = TALENT_TIERS[tierIndex];

		var html = '<div class="combo-talent-row">' +
			'<span class="combo-tier-label">L' + level + '</span>' +
			'<div class="combo-talent-options">';
		for (var i = 0; i < talents.length; i++) {
			var choice = talents[i];
			var isSelected = selectedChoice === choice;
			var available = !tierCounts || (tierCounts[choice] || 0) > 0;
			var cls = 'combo-talent-btn' + (isSelected ? ' selected' : '') + (available ? '' : ' unavailable');
			html += '<button class="' + cls +
				'" data-slot="' + slotIndex + '" data-tier="' + tierIndex +
				'" data-choice="' + choice + '">' +
				talentIconHtml(heroName, tierIndex, choice, talentData) +
				'</button>';
		}
		html += '</div></div>';
		return html;
	}

	function renderHeroTalentCard(slotIndex, talentCounts) {
		var heroName = allyPicks[slotIndex];
		if (!heroName) return '';

		var hasTalents = false;
		for (var t = 0; t < 7; t++) {
			if (allyTalents[slotIndex][t] > 0) { hasTalents = true; break; }
		}

		var html = '<div class="combo-hero-card card">' +
			'<div class="combo-hero-card-header">' +
			heroIconHtml(heroName, "lg") + '<span>' + escapeHtml(heroName) + '</span>';
		if (hasTalents) {
			html += '<button class="btn btn-reset combo-clear-talents" data-slot="' + slotIndex + '">Clear Talents</button>';
		}
		html += '</div><div class="combo-talent-grid">';
		for (var t = 0; t < 7; t++) {
			html += renderTalentRow(slotIndex, t, talentCounts ? talentCounts[t] : null);
		}
		html += '</div></div>';
		return html;
	}

	// Find all filtered matches where every selected hero is on the roster team
	// with matching talent constraints
	function findMatchingGames(filtered) {
		var selectedHeroes = [];
		for (var i = 0; i < 5; i++) {
			if (allyPicks[i]) {
				selectedHeroes.push({ hero: allyPicks[i], talents: allyTalents[i] });
			}
		}
		if (selectedHeroes.length === 0) return [];

		var matches = [];
		for (var i = 0; i < filtered.length; i++) {
			var m = filtered[i];
			var rps = m.rosterPlayers;
			var allMatch = true;

			for (var h = 0; h < selectedHeroes.length; h++) {
				var sel = selectedHeroes[h];
				var found = false;
				for (var j = 0; j < rps.length; j++) {
					if (rps[j].hero !== sel.hero) continue;
					var tc = rps[j].talentChoices;
					var talentsOk = true;
					for (var t = 0; t < 7; t++) {
						if (sel.talents[t] > 0) {
							if (!tc || tc.length <= t || tc[t] !== sel.talents[t]) {
								talentsOk = false;
								break;
							}
						}
					}
					if (talentsOk) { found = true; break; }
				}
				if (!found) { allMatch = false; break; }
			}
			if (allMatch) matches.push(m);
		}
		return matches;
	}

	function renderResults(filtered) {
		var selectedCount = 0;
		for (var i = 0; i < 5; i++) {
			if (allyPicks[i]) selectedCount++;
		}
		if (selectedCount === 0) {
			return '<div class="combo-results">' +
				'<p class="text-muted combo-prompt">Select heroes and talents to see combo win rates.</p></div>';
		}

		var matches = findMatchingGames(filtered);
		var wins = 0;
		for (var i = 0; i < matches.length; i++) {
			if (matches[i].result === "win") wins++;
		}
		var losses = matches.length - wins;
		var winrate = matches.length > 0 ? wins / matches.length : 0;

		var html = '<div class="combo-results">' +
			'<h3 class="section-title">Results</h3>' +
			'<div class="stat-row">' +
			statBoxHtml("Games", '<span>' + matches.length.toLocaleString() + '</span>') +
			statBoxHtml("Win Rate", matches.length > 0 ? winrateSpan(winrate) : '<span class="text-muted">-</span>') +
			statBoxHtml("Wins", '<span>' + wins + '</span>') +
			statBoxHtml("Losses", '<span>' + losses + '</span>') +
			'</div>';

		if (matches.length > 0) {
			var sorted = matches.slice().sort(function(a, b) {
				return b.timestamp.localeCompare(a.timestamp);
			});
			var latest = sorted.slice(0, 5);

			html += '<h3 class="section-title">Latest Games</h3>' +
				'<div class="table-wrap"><table class="combo-matches-table">' +
				'<thead><tr>' +
				'<th>Date</th>' +
				'<th>Map</th>' +
				'<th>Result</th>' +
				'<th>Duration</th>' +
				'<th></th>' +
				'</tr></thead><tbody>';
			for (var i = 0; i < latest.length; i++) {
				var m = latest[i];
				var resultClass = m.result === "win" ? "win" : "loss";
				html += '<tr>' +
					'<td>' + formatDateFinnish(m.timestamp) + '</td>' +
					'<td>' + escapeHtml(displayMapName(m.map)) + '</td>' +
					'<td class="' + resultClass + '">' + (m.result === "win" ? "Win" : "Loss") + '</td>' +
					'<td>' + formatDuration(m.durationSeconds) + '</td>' +
					'<td><a href="' + appLink('/match/' + m.matchId) + '">Details</a></td>' +
					'</tr>';
			}
			html += '</tbody></table></div>';
		}

		html += '</div>';
		return html;
	}

	function readPicksFromURL() {
		var params = new URLSearchParams(window.location.search);
		if (params.has("ap")) {
			var parts = params.get("ap").split(",");
			for (var i = 0; i < 5; i++) {
				allyPicks[i] = (i < parts.length) ? parts[i] : "";
			}
		}
		if (params.has("t")) {
			var tParts = params.get("t").split(",");
			for (var i = 0; i < 5; i++) {
				var s = (i < tParts.length) ? tParts[i] : "0000000";
				for (var t = 0; t < 7; t++) {
					allyTalents[i][t] = t < s.length ? parseInt(s[t], 10) || 0 : 0;
				}
			}
		}
	}

	function writePicksToURL() {
		var params = new URLSearchParams(window.location.search);
		var hasAlly = false;
		for (var i = 0; i < 5; i++) {
			if (allyPicks[i]) { hasAlly = true; break; }
		}
		if (hasAlly) {
			params.set("ap", allyPicks.join(","));
			var tParts = [];
			var hasTalents = false;
			for (var i = 0; i < 5; i++) {
				var s = "";
				for (var t = 0; t < 7; t++) {
					s += allyTalents[i][t];
					if (allyTalents[i][t] > 0) hasTalents = true;
				}
				tParts.push(s);
			}
			if (hasTalents) params.set("t", tParts.join(","));
			else params.delete("t");
		} else {
			params.delete("ap");
			params.delete("t");
		}
		var qs = params.toString();
		history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
	}

	function renderContent() {
		var app = document.getElementById("app");
		var filtered = MatchIndexUtils.filter(matchIndex, filters);
		prepareHeroList(filtered);

		// Compute talent counts and auto-deselect talents with no matching games
		var talentCountsPerSlot = [];
		var changed = false;
		for (var i = 0; i < 5; i++) {
			var counts = computeTalentCounts(filtered, i);
			talentCountsPerSlot.push(counts);
			if (!counts) continue;
			for (var t = 0; t < 7; t++) {
				if (allyTalents[i][t] > 0 && !(counts[t][allyTalents[i][t]])) {
					allyTalents[i][t] = 0;
					changed = true;
				}
			}
		}
		// Deselecting loosens constraints, so one recompute is enough
		if (changed) {
			for (var i = 0; i < 5; i++) {
				talentCountsPerSlot[i] = computeTalentCounts(filtered, i);
			}
		}

		var html = '<div class="combos-page">' +
			'<div class="page-header"><h1>Combos</h1>' +
			'<div class="subtitle">' + filtered.length.toLocaleString() + ' out of ' +
			matchIndex.length.toLocaleString() + ' matches</div></div>';

		html += buildPageFilterBar(filters, {
			mode: true,
			mapOptions: getAvailableMaps(),
			partySize: true,
			dateFrom: true,
			dateTo: true
		});

		html += '<div class="combo-layout">';

		// Your Team
		html += '<div class="combo-team-section">' +
			'<div class="draft-column-header">' +
			'<h2 class="draft-column-title win">Your Team</h2>' +
			'<button class="btn btn-reset combo-clear-all">Clear</button>' +
			'</div>' +
			'<div class="draft-picks">';
		for (var i = 0; i < 5; i++) {
			var comboCounts = computeHeroComboCounts(filtered, i);
			html += renderHeroSelect('ally-' + i, allyPicks[i], comboCounts);
		}
		html += '</div>';

		// Talent cards for selected heroes
		var hasCards = false;
		for (var i = 0; i < 5; i++) {
			if (allyPicks[i]) { hasCards = true; break; }
		}
		if (hasCards) {
			html += '<div class="combo-talent-cards">';
			for (var i = 0; i < 5; i++) {
				html += renderHeroTalentCard(i, talentCountsPerSlot[i]);
			}
			html += '</div>';
		}
		html += '</div>'; // .combo-team-section

		html += renderResults(filtered);
		html += '</div>'; // .combo-layout
		html += '</div>'; // .combos-page

		app.innerHTML = html;
		attachListeners();
		attachPageFilterListeners(app, filters, defaults, function() {
			writeFiltersToURL(filters, defaults);
			renderContent();
		});
		writePicksToURL();
	}

	function attachListeners() {
		var app = document.getElementById("app");

		for (var i = 0; i < 5; i++) {
			(function(idx) {
				var select = app.querySelector('#ally-' + idx);
				if (select) {
					select.addEventListener('change', function() {
						allyPicks[idx] = this.value;
						allyTalents[idx] = [0, 0, 0, 0, 0, 0, 0];
						renderContent();
					});
				}
			})(i);
		}

		var talentBtns = app.querySelectorAll('.combo-talent-btn:not(.unavailable)');
		for (var i = 0; i < talentBtns.length; i++) {
			talentBtns[i].addEventListener('click', function() {
				var slot = parseInt(this.getAttribute('data-slot'), 10);
				var tier = parseInt(this.getAttribute('data-tier'), 10);
				var choice = parseInt(this.getAttribute('data-choice'), 10);
				if (allyTalents[slot][tier] === choice) {
					allyTalents[slot][tier] = 0;
				} else {
					allyTalents[slot][tier] = choice;
				}
				renderContent();
			});
		}

		var clearAll = app.querySelector('.combo-clear-all');
		if (clearAll) {
			clearAll.addEventListener('click', function() {
				allyPicks = ["", "", "", "", ""];
				for (var i = 0; i < 5; i++) {
					allyTalents[i] = [0, 0, 0, 0, 0, 0, 0];
				}
				renderContent();
			});
		}

		var clearTalentBtns = app.querySelectorAll('.combo-clear-talents');
		for (var i = 0; i < clearTalentBtns.length; i++) {
			clearTalentBtns[i].addEventListener('click', function() {
				var slot = parseInt(this.getAttribute('data-slot'), 10);
				allyTalents[slot] = [0, 0, 0, 0, 0, 0, 0];
				renderContent();
			});
		}

		var resetBtn = app.querySelector('.page-filter-reset');
		if (resetBtn) {
			resetBtn.addEventListener('click', function() {
				allyPicks = ["", "", "", "", ""];
				for (var i = 0; i < 5; i++) {
					allyTalents[i] = [0, 0, 0, 0, 0, 0, 0];
				}
			});
		}
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading combos...</div>';

		allyPicks = ["", "", "", "", ""];
		allyTalents = [null, null, null, null, null];
		initTalents();

		var keys = Object.keys(defaults);
		for (var i = 0; i < keys.length; i++) {
			filters[keys[i]] = defaults[keys[i]];
		}

		try {
			var results = await Promise.all([
				Data.matchIndex(),
				Data.summary(),
				Data.settings(),
				Data.talentNames(),
				Data.talentDescriptions()
			]);
			matchIndex = results[0];
			talentData = { names: results[3], descriptions: results[4] };

			readFiltersFromURL(filters, defaults);
			readPicksFromURL();
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load combo data.</div>';
		}
	}

	return { render: render };
})();
