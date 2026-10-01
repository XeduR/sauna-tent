// Shared utilities for filtering and aggregating match index data on the frontend.
// All filterable pages (overview, players, heroes, maps) use these to compute
// stats from the cached match index rather than pre-computed aggregates.

var MatchIndexUtils = (function() {
	// Filter match index entries by criteria.
	// Supported keys: noAlts, mode, map, dateFrom, dateTo, seasons, partySize.
	// noAlts defaults to window.GlobalFilters.getNoAlts() when not explicitly set.
	function filter(matches, filters) {
		var noAlts;
		if (filters.noAlts !== undefined) {
			noAlts = filters.noAlts;
		} else if (window.GlobalFilters) {
			noAlts = window.GlobalFilters.getNoAlts();
		} else {
			noAlts = true;
		}

		// Pre-compute season date ranges if season filter is active
		var seasonRanges = null;
		if (filters.seasons) {
			var seasonNums = filters.seasons.split(",");
			var allSeasons = window.AppSeasons || [];
			seasonRanges = [];
			for (var si = 0; si < allSeasons.length; si++) {
				if (seasonNums.indexOf(String(allSeasons[si].number)) !== -1) {
					seasonRanges.push(allSeasons[si]);
				}
			}
		}

		var result = [];
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			if (noAlts && m.hasAlt) continue;
			if (filters.mode && m.gameMode !== filters.mode) continue;
			if (filters.map && m.map !== filters.map) continue;
			if (filters.dateFrom && m.timestamp.substring(0, 10) < filters.dateFrom) continue;
			if (filters.dateTo && m.timestamp.substring(0, 10) > filters.dateTo) continue;

			if (seasonRanges && seasonRanges.length > 0) {
				var matchDate = m.timestamp.substring(0, 10);
				var inSeason = false;
				for (var sr = 0; sr < seasonRanges.length; sr++) {
					// End date is exclusive (marks start of next season)
					if (matchDate >= seasonRanges[sr].start && matchDate < seasonRanges[sr].end) {
						inSeason = true;
						break;
					}
				}
				if (!inSeason) continue;
			}

			if (filters.partySize) {
				var ps = Number(filters.partySize);
				var hasParty = false;
				for (var j = 0; j < m.rosterPlayers.length; j++) {
					if (m.rosterPlayers[j].partySize === ps) {
						hasParty = true;
						break;
					}
				}
				if (!hasParty) continue;
			}

			result.push(m);
		}
		return result;
	}

	function _newGroup() {
		return {
			games: 0, wins: 0, losses: 0, totalDuration: 0,
			totalKills: 0, totalDeaths: 0, totalAssists: 0,
			totalHeroDamage: 0, totalSiegeDamage: 0,
			totalHealing: 0, totalSelfHealing: 0, totalDamageTaken: 0,
			totalXpContribution: 0, totalMercCaptures: 0, totalTimeSpentDead: 0,
			durationMin: null, durationMax: null, lastPlayed: null,
			byPartySize: {}
		};
	}

	function _addMatchDuration(g, m) {
		g.totalDuration += m.durationSeconds;
		if (g.durationMin === null || m.durationSeconds < g.durationMin) g.durationMin = m.durationSeconds;
		if (g.durationMax === null || m.durationSeconds > g.durationMax) g.durationMax = m.durationSeconds;
		if (g.lastPlayed === null || m.timestamp > g.lastPlayed) g.lastPlayed = m.timestamp;
	}

	function _addPlayerStats(g, rp) {
		g.totalKills += rp.kills || 0;
		g.totalDeaths += rp.deaths || 0;
		g.totalAssists += rp.assists || 0;
		g.totalHeroDamage += rp.heroDamage || 0;
		g.totalSiegeDamage += rp.siegeDamage || 0;
		g.totalHealing += rp.healing || 0;
		g.totalSelfHealing += rp.selfHealing || 0;
		g.totalDamageTaken += rp.damageTaken || 0;
		g.totalXpContribution += rp.xpContribution || 0;
		g.totalMercCaptures += rp.mercCaptures || 0;
		g.totalTimeSpentDead += rp.timeSpentDead || 0;
	}

	function _addParty(g, rp) {
		var ps = String(rp.partySize || 1);
		if (!g.byPartySize[ps]) g.byPartySize[ps] = { games: 0, wins: 0 };
		g.byPartySize[ps].games++;
		if (rp.result === "win") g.byPartySize[ps].wins++;
	}

	function _finalizeGroup(g) {
		g.winrate = g.games > 0 ? g.wins / g.games : 0;
		g.avgDuration = g.games > 0 ? g.totalDuration / g.games : 0;
		if (g.games > 0) {
			var n = g.games;
			var deaths = Math.max(g.totalDeaths, 1);
			g.averages = {
				kills: Math.round(g.totalKills / n * 10) / 10,
				deaths: Math.round(g.totalDeaths / n * 10) / 10,
				assists: Math.round(g.totalAssists / n * 10) / 10,
				kda: Math.round((g.totalKills + g.totalAssists) / deaths * 100) / 100,
				heroDamage: Math.round(g.totalHeroDamage / n),
				siegeDamage: Math.round(g.totalSiegeDamage / n),
				healing: Math.round(g.totalHealing / n),
				selfHealing: Math.round(g.totalSelfHealing / n),
				damageTaken: Math.round(g.totalDamageTaken / n),
				xpContribution: Math.round(g.totalXpContribution / n),
				mercCaptures: Math.round(g.totalMercCaptures / n * 10) / 10,
				timeSpentDead: Math.round(g.totalTimeSpentDead / n * 10) / 10
			};
		}
		for (var ps in g.byPartySize) {
			var pd = g.byPartySize[ps];
			pd.winrate = pd.games > 0 ? pd.wins / pd.games : 0;
		}
	}

	// Group filtered matches by player, returning stats per roster player
	function groupByPlayer(matches) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (!groups[rp.name]) groups[rp.name] = _newGroup();
				var g = groups[rp.name];
				g.games++;
				if (rp.result === "win") g.wins++;
				else g.losses++;
				_addMatchDuration(g, m);
				_addPlayerStats(g, rp);
				_addParty(g, rp);
			}
		}
		for (var name in groups) _finalizeGroup(groups[name]);
		return groups;
	}

	// Group filtered matches by hero (from roster player appearances)
	function groupByHero(matches) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (!groups[rp.hero]) groups[rp.hero] = _newGroup();
				var g = groups[rp.hero];
				g.games++;
				if (rp.result === "win") g.wins++;
				else g.losses++;
				_addMatchDuration(g, m);
				_addPlayerStats(g, rp);
				_addParty(g, rp);
			}
		}
		for (var hero in groups) _finalizeGroup(groups[hero]);
		return groups;
	}

	// Group filtered matches by map (per roster-player-appearance, matching pipeline)
	function groupByMap(matches) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			if (!groups[m.map]) groups[m.map] = _newGroup();
			var g = groups[m.map];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				g.games++;
				if (m.rosterPlayers[j].result === "win") g.wins++;
				else g.losses++;
				_addMatchDuration(g, m);
				_addPlayerStats(g, m.rosterPlayers[j]);
				_addParty(g, m.rosterPlayers[j]);
			}
		}
		for (var map in groups) _finalizeGroup(groups[map]);
		return groups;
	}

	// Group by game mode
	function groupByMode(matches) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			if (!groups[m.gameMode]) {
				groups[m.gameMode] = { games: 0, wins: 0, losses: 0, totalDuration: 0 };
			}
			var g = groups[m.gameMode];
			g.games++;
			if (m.result === "win") g.wins++;
			else g.losses++;
			g.totalDuration += m.durationSeconds;
		}
		for (var mode in groups) {
			var g = groups[mode];
			g.winrate = g.games > 0 ? g.wins / g.games : 0;
			g.avgDuration = g.games > 0 ? g.totalDuration / g.games : 0;
		}
		return groups;
	}

	// Group by party size
	function groupByParty(matches) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var ps = String(m.rosterPlayers[j].partySize);
				if (!groups[ps]) {
					groups[ps] = { games: 0, wins: 0, losses: 0, totalDuration: 0 };
				}
				var g = groups[ps];
				g.games++;
				if (m.rosterPlayers[j].result === "win") g.wins++;
				else g.losses++;
				g.totalDuration += m.durationSeconds;
			}
		}
		for (var ps in groups) {
			var g = groups[ps];
			g.winrate = g.games > 0 ? g.wins / g.games : 0;
			g.avgDuration = g.games > 0 ? g.totalDuration / g.games : 0;
		}
		return groups;
	}

	// Compute overall totals from filtered matches
	function totals(matches) {
		var t = { games: 0, wins: 0, losses: 0, totalDuration: 0 };
		for (var i = 0; i < matches.length; i++) {
			t.games++;
			if (matches[i].result === "win") t.wins++;
			else t.losses++;
			t.totalDuration += matches[i].durationSeconds;
		}
		t.winrate = t.games > 0 ? t.wins / t.games : 0;
		t.avgDuration = t.games > 0 ? t.totalDuration / t.games : 0;
		return t;
	}

	// Get unique stack compositions from matches with stats
	function groupByStack(matches) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			// Group roster players by team to identify stacks
			var teams = {};
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				if (rp.partySize < 2) continue;
				if (!teams[rp.result]) teams[rp.result] = [];
				teams[rp.result].push(rp.name);
			}
			// Each result group with 2+ players is a stack
			for (var result in teams) {
				var names = teams[result].sort();
				if (names.length < 2) continue;
				var key = names.join("+");
				if (!groups[key]) {
					groups[key] = { players: names, size: names.length, games: 0, wins: 0, losses: 0 };
				}
				groups[key].games++;
				if (result === "win") groups[key].wins++;
				else groups[key].losses++;
			}
		}
		for (var key in groups) {
			var g = groups[key];
			g.winrate = g.games > 0 ? g.wins / g.games : 0;
		}
		return groups;
	}

	// Compute meta stats from filtered matches (team side, first blood, first boss/merc, level lead)
	function computeMetaStats(matches) {
		var side = { left: { games: 0, wins: 0 }, right: { games: 0, wins: 0 } };
		var firstBlood = { got: { games: 0, wins: 0 }, gave: { games: 0, wins: 0 } };
		var counterKill = { gotClean: { games: 0, wins: 0 }, gaveClean: { games: 0, wins: 0 }, traded: { games: 0, wins: 0 } };
		var counterKillWindow = AppSettings.matchFactors.counterKillWindowSeconds;
		var firstBoss = { got: { games: 0, wins: 0 }, gave: { games: 0, wins: 0 } };
		var firstMerc = { got: { games: 0, wins: 0 }, gave: { games: 0, wins: 0 } };
		// Heroes Lounge: Custom games only - firstPick means roster drafted first, mapPick means roster chose the map instead
		var loungePick = { mapPick: { games: 0, wins: 0 }, firstPick: { games: 0, wins: 0 } };
		var tiers = ["4", "7", "10", "13", "16", "20"];
		var levelLead = {};
		for (var t = 0; t < tiers.length; t++) {
			levelLead[tiers[t]] = { got: { games: 0, wins: 0 }, gave: { games: 0, wins: 0 } };
		}

		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			var isWin = m.result === "win";

			if (m.rosterSide) {
				side[m.rosterSide].games++;
				if (isWin) side[m.rosterSide].wins++;
			}

			if (m.rosterFirstBlood != null) {
				var fbKey = m.rosterFirstBlood ? "got" : "gave";
				firstBlood[fbKey].games++;
				if (isWin) firstBlood[fbKey].wins++;

				var counterSeconds = m.firstBloodCounterKillSeconds;
				if (counterSeconds !== undefined) {
					var ckKey;
					if (counterSeconds !== null && counterSeconds <= counterKillWindow) ckKey = "traded";
					else ckKey = m.rosterFirstBlood ? "gotClean" : "gaveClean";
					counterKill[ckKey].games++;
					if (isWin) counterKill[ckKey].wins++;
				}
			}

			if (m.rosterFirstBoss != null) {
				var bKey = m.rosterFirstBoss ? "got" : "gave";
				firstBoss[bKey].games++;
				if (isWin) firstBoss[bKey].wins++;
			}

			if (m.rosterFirstMerc != null) {
				var mKey = m.rosterFirstMerc ? "got" : "gave";
				firstMerc[mKey].games++;
				if (isWin) firstMerc[mKey].wins++;
			}

			if (m.rosterFirstPick != null) {
				var lpKey = m.rosterFirstPick ? "firstPick" : "mapPick";
				loungePick[lpKey].games++;
				if (isWin) loungePick[lpKey].wins++;
			}

			if (m.rosterFirstToLevel) {
				for (var t = 0; t < tiers.length; t++) {
					var tier = tiers[t];
					if (m.rosterFirstToLevel[tier] != null) {
						var llKey = m.rosterFirstToLevel[tier] ? "got" : "gave";
						levelLead[tier][llKey].games++;
						if (isWin) levelLead[tier][llKey].wins++;
					}
				}
			}
		}

		// Finalize all accumulators
		function finalize(acc) {
			acc.losses = acc.games - acc.wins;
			acc.winrate = acc.games > 0 ? acc.wins / acc.games : 0;
		}
		for (var s in side) finalize(side[s]);
		for (var k in firstBlood) finalize(firstBlood[k]);
		for (var k in counterKill) finalize(counterKill[k]);
		for (var k in firstBoss) finalize(firstBoss[k]);
		for (var k in firstMerc) finalize(firstMerc[k]);
		for (var k in loungePick) finalize(loungePick[k]);
		for (var t = 0; t < tiers.length; t++) {
			finalize(levelLead[tiers[t]].got);
			finalize(levelLead[tiers[t]].gave);
		}

		return {
			teamSide: side,
			firstBlood: firstBlood,
			firstBloodCounterKill: counterKill,
			firstBoss: firstBoss,
			firstMerc: firstMerc,
			loungePick: loungePick,
			levelLead: levelLead
		};
	}

	// Compute chat statistics win rates from filtered matches.
	// Only Storm League and ARAM are included (Custom excluded for win rate correlation).
	function computeChatStats(matches) {
		var categories = {
			noChat: { games: 0, wins: 0 },
			anyChat: { games: 0, wins: 0 },
			cleanChat: { games: 0, wins: 0 },
			toxicRoster: { games: 0, wins: 0 },
			toxicOther: { games: 0, wins: 0 },
			toxicMixed: { games: 0, wins: 0 }
		};

		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			if (m.gameMode !== "StormLeague" && m.gameMode !== "ARAM") continue;
			if (m.hadTeamChat == null) continue;

			var isWin = m.result === "win";

			if (!m.hadTeamChat) {
				categories.noChat.games++;
				if (isWin) categories.noChat.wins++;
			} else {
				categories.anyChat.games++;
				if (isWin) categories.anyChat.wins++;

				var tox = m.chatToxicity;
				if (tox === "clean") {
					categories.cleanChat.games++;
					if (isWin) categories.cleanChat.wins++;
				} else if (tox === "toxic_roster") {
					categories.toxicRoster.games++;
					if (isWin) categories.toxicRoster.wins++;
				} else if (tox === "toxic_other") {
					categories.toxicOther.games++;
					if (isWin) categories.toxicOther.wins++;
				} else if (tox === "toxic_mixed") {
					categories.toxicMixed.games++;
					if (isWin) categories.toxicMixed.wins++;
				}
			}
		}

		function finalize(acc) {
			acc.losses = acc.games - acc.wins;
			acc.winrate = acc.games > 0 ? acc.wins / acc.games : 0;
		}
		for (var k in categories) finalize(categories[k]);

		return categories;
	}

	// Compute party-size win rate breakdowns keyed by a grouping function.
	// groupKeyFn(match, rosterPlayer) returns the group key, or null to skip.
	function computePartyBreakdowns(matches, groupKeyFn) {
		var groups = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				var rp = m.rosterPlayers[j];
				var key = groupKeyFn(m, rp);
				if (key == null) continue;
				if (!groups[key]) groups[key] = {};
				var ps = String(rp.partySize || 1);
				if (!groups[key][ps]) groups[key][ps] = { games: 0, wins: 0 };
				groups[key][ps].games++;
				if (rp.result === "win") groups[key][ps].wins++;
			}
		}
		for (var key in groups) {
			for (var ps in groups[key]) {
				var pd = groups[key][ps];
				pd.winrate = pd.games > 0 ? pd.wins / pd.games : 0;
			}
		}
		return groups;
	}

	// Bucket hero play counts by month (YYYY-MM) for chart use
	function computeMonthlyHeroStats(matches) {
		var months = {};
		for (var i = 0; i < matches.length; i++) {
			var m = matches[i];
			var month = m.timestamp.substring(0, 7);
			if (!months[month]) {
				months[month] = { total: 0, heroes: {} };
			}
			var md = months[month];
			for (var j = 0; j < m.rosterPlayers.length; j++) {
				md.total++;
				md.heroes[m.rosterPlayers[j].hero] = (md.heroes[m.rosterPlayers[j].hero] || 0) + 1;
			}
		}
		return { months: months, sortedMonths: Object.keys(months).sort() };
	}

	var hourFormatter = null;
	var hourFormatterZone = null;
	var hourCache = {};

	function matchStartMs(m) {
		return Date.parse(m.timestamp) - m.durationSeconds * 1000;
	}

	function matchEndMs(m) {
		return Date.parse(m.timestamp);
	}

	function startHour(m) {
		var zone = AppSettings.overview.timeOfDayTimeZone;
		if (!hourFormatter || hourFormatterZone !== zone) {
			hourFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" });
			hourFormatterZone = zone;
			hourCache = {};
		}

		var cached = hourCache[m.matchId];
		if (cached !== undefined) return cached;

		var parts = hourFormatter.formatToParts(new Date(matchStartMs(m)));
		var hour = 0;
		for (var pi = 0; pi < parts.length; pi++) {
			if (parts[pi].type === "hour") hour = parseInt(parts[pi].value, 10);
		}
		hourCache[m.matchId] = hour;
		return hour;
	}

	// 24 win/game buckets by the local hour the game started in
	function computeHourlyWinrates(matches) {
		var buckets = [];
		for (var hour = 0; hour < 24; hour++) {
			buckets.push({ games: 0, wins: 0 });
		}

		for (var i = 0; i < matches.length; i++) {
			var bucket = buckets[startHour(matches[i])];
			bucket.games++;
			if (matches[i].result === "win") bucket.wins++;
		}
		return buckets;
	}

	function playerNames(m) {
		var names = [];
		for (var j = 0; j < m.rosterPlayers.length; j++) {
			names.push(m.rosterPlayers[j].name);
		}
		return names;
	}

	// Index of the last entry whose end is <= limitMs in an end-sorted list, or -1
	function lastEndingAtOrBefore(list, limitMs) {
		var low = 0;
		var high = list.length - 1;
		var found = -1;
		while (low <= high) {
			var mid = (low + high) >> 1;
			if (list[mid].end <= limitMs) {
				found = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return found;
	}

	function byEnd(first, second) {
		return first.end - second.end;
	}

	// Map from each eligible game to the game it continues in the same session
	function buildPredecessorMap(allMatches) {
		var config = AppSettings.streaks;
		var maxGapMs = config.maxGapMinutes * 60000;
		var eligible = [];
		var timelines = {};

		for (var i = 0; i < allMatches.length; i++) {
			var m = allMatches[i];
			var record = { match: m, start: matchStartMs(m), end: matchEndMs(m), players: playerNames(m) };

			// Every game counts toward a player's timeline, so a continuing player's small-party game in between breaks the link
			for (var j = 0; j < record.players.length; j++) {
				var name = record.players[j];
				if (!timelines[name]) timelines[name] = [];
				timelines[name].push(record);
			}
			if (record.players.length >= config.minPlayers) eligible.push(record);
		}

		eligible.sort(byEnd);
		for (var name in timelines) timelines[name].sort(byEnd);

		var predecessors = new Map();
		for (var gi = 0; gi < eligible.length; gi++) {
			var game = eligible[gi];
			var previous = null;
			for (var ci = lastEndingAtOrBefore(eligible, game.start); ci >= 0; ci--) {
				var candidate = eligible[ci];
				if (game.start - candidate.end > maxGapMs) break;

				var dropped = 0;
				for (var pi = 0; pi < candidate.players.length; pi++) {
					if (game.players.indexOf(candidate.players[pi]) === -1) dropped++;
				}
				if (dropped <= config.maxDroppedPlayers) {
					previous = candidate;
					break;
				}
			}
			if (!previous || previous.match.gameMode !== game.match.gameMode) continue;

			var continuous = true;
			for (var pj = 0; pj < previous.players.length && continuous; pj++) {
				var player = previous.players[pj];
				if (game.players.indexOf(player) === -1) continue;

				var timeline = timelines[player];
				var latest = lastEndingAtOrBefore(timeline, game.start);
				if (latest === -1 || timeline[latest] !== previous) continuous = false;
			}
			if (continuous) predecessors.set(game.match, previous.match);
		}
		return predecessors;
	}

	var predecessorSource = null;
	var predecessorMap = null;

	function emptyStreakRows(lengths) {
		var rows = {};
		for (var li = 0; li < lengths.length; li++) {
			rows[lengths[li]] = { games: 0, wins: 0 };
		}
		return rows;
	}

	// Next-game results after N consecutive wins or losses within one session.
	// Sessions are linked over allMatches; samples count only when the whole chain is in filteredMatches.
	function computeStreakStats(allMatches, filteredMatches) {
		if (predecessorSource !== allMatches) {
			predecessorMap = buildPredecessorMap(allMatches);
			predecessorSource = allMatches;
		}

		var lengths = AppSettings.streaks.lengths;
		var maxLength = Math.max.apply(null, lengths);
		var afterWins = emptyStreakRows(lengths);
		var afterLosses = emptyStreakRows(lengths);
		var inFilter = new Set(filteredMatches);

		for (var i = 0; i < filteredMatches.length; i++) {
			var game = filteredMatches[i];
			var isWin = game.result === "win";
			var chain = [];
			var current = predecessorMap.get(game);
			while (current && inFilter.has(current) && chain.length < maxLength) {
				chain.push(current.result);
				current = predecessorMap.get(current);
			}

			for (var li = 0; li < lengths.length; li++) {
				var length = lengths[li];
				if (chain.length < length) continue;

				var allWins = true;
				var allLosses = true;
				for (var ci = 0; ci < length; ci++) {
					if (chain[ci] === "win") allLosses = false;
					else allWins = false;
				}

				var target = allWins ? afterWins[length] : (allLosses ? afterLosses[length] : null);
				if (target) {
					target.games++;
					if (isWin) target.wins++;
				}
			}
		}

		for (var key in afterWins) finalizeStreak(afterWins[key]);
		for (var key in afterLosses) finalizeStreak(afterLosses[key]);
		return { afterWins: afterWins, afterLosses: afterLosses };
	}

	function finalizeStreak(acc) {
		acc.losses = acc.games - acc.wins;
		acc.winrate = acc.games > 0 ? acc.wins / acc.games : 0;
	}

	return {
		filter: filter,
		groupByPlayer: groupByPlayer,
		groupByHero: groupByHero,
		groupByMap: groupByMap,
		groupByMode: groupByMode,
		groupByParty: groupByParty,
		groupByStack: groupByStack,
		computeMetaStats: computeMetaStats,
		computeChatStats: computeChatStats,
		computePartyBreakdowns: computePartyBreakdowns,
		computeMonthlyHeroStats: computeMonthlyHeroStats,
		computeHourlyWinrates: computeHourlyWinrates,
		computeStreakStats: computeStreakStats,
		totals: totals,
	};
})();
