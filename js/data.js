// Data loader with caching. All fetches go through here.
var Data = (function() {
	var cache = {};
	var pending = {};
	var BASE = "data";

	async function fetchJSON(path) {
		if (cache[path]) return cache[path];

		if (pending[path]) return pending[path];

		pending[path] = fetch(`${BASE}/${path}`)
			.then(function(res) {
				if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
				return res.json();
			})
			.then(function(data) {
				cache[path] = data;
				delete pending[path];
				return data;
			})
			.catch(function(err) {
				delete pending[path];
				throw err;
			});

		return pending[path];
	}

	function summary() {
		return fetchJSON("summary.json");
	}

	function roster() {
		return fetchJSON("roster.json");
	}

	function player(slug) {
		return fetchJSON(`players/${slug}.json`);
	}

	function hero(slug) {
		return fetchJSON(`heroes/${slug}.json`);
	}

	function map(slug) {
		return fetchJSON(`maps/${slug}.json`);
	}

	// Lazy-loaded, large file (~10 MB)
	function matchIndex() {
		return fetchJSON("matches/index.json");
	}

	function match(id) {
		return fetchJSON(`matches/${id}.json`);
	}

	function hallOfFame() {
		return fetchJSON("hall-of-fame.json");
	}

	function heroColors() {
		return fetchJSON("hero-colors.json");
	}

	function talentNames() {
		return fetchJSON("talent-names.json");
	}

	function talentDescriptions() {
		return fetchJSON("talent-descriptions.json");
	}

	function settings() {
		return fetchJSON("settings.json").then(function(data) {
			window.AppSettings = data;
			return data;
		});
	}

	return {
		summary: summary,
		roster: roster,
		player: player,
		hero: hero,
		map: map,
		matchIndex: matchIndex,
		match: match,
		hallOfFame: hallOfFame,
		heroColors: heroColors,
		talentNames: talentNames,
		talentDescriptions: talentDescriptions,
		settings: settings
	};
})();
