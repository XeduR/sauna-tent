// Hero Info main page: wiki-style reference table of all heroes' base stats,
// scalable by user-selected level. Distinct from /heroes (team match stats).
var HeroInfoView = (function() {
	var filters = { role: "", franchise: "", search: "", scaleLevel: "0" };
	var defaults = { role: "", franchise: "", search: "", scaleLevel: "0" };
	var heroInfo = null;

	// Form-switching / multi-character heroes that need extra rows on the main page.
	// All synthesised rows route to the canonical hero's subpage.
	var HERO_ROW_EXPANSIONS = {
		greymane: [
			{ suffix: "(human)", weaponIndex: 1, useHeroUnit: null },
			{ suffix: "(worgen)", weaponIndex: 0, useHeroUnit: null }
		],
		dva: [
			{ suffix: "(mech)", weaponIndex: 0, useHeroUnit: null },
			{ suffix: "(pilot)", weaponIndex: 0, useHeroUnit: "HeroDVaPilot" }
		],
		rexxar: [
			{ suffix: "", weaponIndex: 1, useHeroUnit: null },
			{ suffix: "", weaponIndex: 0, useHeroUnit: "RexxarMisha", overrideName: "Misha" }
		],
		"the-lost-vikings": [
			{ suffix: "", weaponIndex: 0, useHeroUnit: "HeroErik", overrideName: "Erik (TLV)", aliases: ["TLV"] },
			{ suffix: "", weaponIndex: 0, useHeroUnit: "HeroBaleog", overrideName: "Baleog (TLV)", aliases: ["TLV"] },
			{ suffix: "", weaponIndex: 0, useHeroUnit: "HeroOlaf", overrideName: "Olaf (TLV)", aliases: ["TLV"] }
		],
		chen: [
			{ suffix: "", weaponIndex: 0, useHeroUnit: null },
			{ suffix: "", weaponIndex: 0, useHeroUnit: "HeroChenStorm", overrideName: "Storm (Chen)" },
			{ suffix: "", weaponIndex: 0, useHeroUnit: "HeroChenEarth", overrideName: "Earth (Chen)" },
			{ suffix: "", weaponIndex: 0, useHeroUnit: "HeroChenFire", overrideName: "Fire (Chen)" }
		]
	};

	function findHeroUnit(hero, unitId) {
		var units = hero.heroUnits || [];
		for (var i = 0; i < units.length; i++) {
			if (units[i][unitId]) return units[i][unitId];
		}
		return null;
	}

	// Build one synthetic row from a hero record and an optional expansion descriptor.
	// Without a descriptor, the row reflects the top-level hero record.
	function buildRow(slug, hero, descriptor) {
		var displayName;
		var weaponSource;
		var lifeSource;

		if (descriptor) {
			if (descriptor.overrideName) {
				displayName = descriptor.overrideName;
			} else if (descriptor.suffix) {
				displayName = hero.name + " " + descriptor.suffix;
			} else {
				displayName = hero.name;
			}

			if (descriptor.useHeroUnit) {
				var unit = findHeroUnit(hero, descriptor.useHeroUnit);
				if (unit) {
					lifeSource = unit.life || {};
					weaponSource = (unit.weapons || [])[descriptor.weaponIndex] || null;
				}
			}

			// Fallback to top-level when the heroUnit lookup missed or wasn't requested.
			if (!lifeSource) {
				lifeSource = {
					amount: hero.health,
					scale: hero.healthScale,
					regenRate: hero.healthRegen,
					regenScale: hero.healthRegenScale
				};
			}
			if (weaponSource === undefined) {
				weaponSource = (hero.weapons || [])[descriptor.weaponIndex] || null;
			}
		} else {
			displayName = hero.name;
			lifeSource = {
				amount: hero.health,
				scale: hero.healthScale,
				regenRate: hero.healthRegen,
				regenScale: hero.healthRegenScale
			};
			weaponSource = (hero.weapons || [])[0] || null;
		}

		// Prefer the per-form unit radius (TLV Vikings have their own); fall back to top-level.
		// Zero radius means data-missing or no-body (e.g. Gall): render as "-" via null.
		var rawRadius = null;
		if (descriptor && descriptor.useHeroUnit) {
			var unitForRadius = findHeroUnit(hero, descriptor.useHeroUnit);
			if (unitForRadius && typeof unitForRadius.radius === "number") {
				rawRadius = unitForRadius.radius;
			}
		}
		if (rawRadius == null && typeof hero.radius === "number") {
			rawRadius = hero.radius;
		}
		if (rawRadius === 0) rawRadius = null;

		return {
			slug: slug,
			canonicalName: hero.name,
			name: displayName,
			aliases: (descriptor && descriptor.aliases) ? descriptor.aliases : [],
			role: hero.expandedRole || "",
			franchise: hero.franchise || "",
			health: lifeSource.amount || 0,
			healthScale: lifeSource.scale || 0,
			healthRegen: lifeSource.regenRate || 0,
			healthRegenScale: lifeSource.regenScale || 0,
			radius: rawRadius,
			attackRange: weaponSource ? weaponSource.range : null,
			attackSpeed: weaponSource ? weaponSource.period : null,
			attackDamage: weaponSource ? weaponSource.damage : null,
			attackDamageScale: weaponSource ? (weaponSource.damageScale || 0) : 0
		};
	}

	function buildAllRows(heroInfoData) {
		var rows = [];
		var slugs = Object.keys(heroInfoData);
		for (var i = 0; i < slugs.length; i++) {
			var slug = slugs[i];
			var hero = heroInfoData[slug];
			var expansion = HERO_ROW_EXPANSIONS[slug];
			if (expansion) {
				for (var j = 0; j < expansion.length; j++) {
					rows.push(buildRow(slug, hero, expansion[j]));
				}
			} else {
				rows.push(buildRow(slug, hero, null));
			}
		}
		return rows;
	}

	function scaled(base, scale, level) {
		if (base == null) return null;
		return base * (1 + (scale || 0) * level);
	}

	function fmt1(val) {
		if (val == null) return '<span class="text-muted">-</span>';
		return val.toFixed(1);
	}

	function fmt2(val) {
		if (val == null) return '<span class="text-muted">-</span>';
		return val.toFixed(2);
	}

	function getRoleOptions(rows) {
		var set = {};
		for (var i = 0; i < rows.length; i++) {
			if (rows[i].role) set[rows[i].role] = true;
		}
		return Object.keys(set).sort();
	}

	function getFranchiseOptions(rows) {
		var set = {};
		for (var i = 0; i < rows.length; i++) {
			if (rows[i].franchise) set[rows[i].franchise] = true;
		}
		return Object.keys(set).sort();
	}

	// Snapshot current sort state from the live table so re-render (e.g. level change)
	// doesn't snap back to the default sort. sortableTable writes data-sort-key plus
	// .sort-asc/.sort-desc on the active header.
	function readCurrentSort() {
		var existing = document.getElementById("hero-info-table");
		if (!existing) return null;
		var th = existing.querySelector("thead th.sort-asc, thead th.sort-desc");
		if (!th) return null;
		var key = th.getAttribute("data-sort-key");
		if (!key) return null;
		return { key: key, desc: th.classList.contains("sort-desc") };
	}

	function renderContent() {
		var app = document.getElementById("app");
		var level = Number(filters.scaleLevel) || 0;
		var prevSort = readCurrentSort();

		var allRows = buildAllRows(heroInfo);
		var roleOptions = getRoleOptions(allRows);
		var franchiseOptions = getFranchiseOptions(allRows);
		var searchTerm = (filters.search || "").toLowerCase();

		var filteredRows = [];
		for (var i = 0; i < allRows.length; i++) {
			var row = allRows[i];
			if (filters.role && row.role !== filters.role) continue;
			if (filters.franchise && row.franchise !== filters.franchise) continue;
			if (searchTerm) {
				var hay = (row.name + " " + row.role + " " + row.franchise + " " +
					row.canonicalName + " " + row.aliases.join(" ")).toLowerCase();
				if (hay.indexOf(searchTerm) === -1) continue;
			}
			filteredRows.push(row);
		}

		var html = '<div class="page-header"><h1>Hero Info</h1>' +
			'<div class="subtitle">' + filteredRows.length + ' out of ' + allRows.length + ' entries</div></div>';

		var filterBarHtml = buildPageFilterBar(filters, {
			roleOptions: roleOptions,
			franchiseOptions: franchiseOptions,
			search: true,
			searchPlaceholder: "e.g. Tychus"
		});

		var levelValue = escapeHtml(String(filters.scaleLevel || "0"));
		html += '<div class="hero-info-controls-row">' +
			'<div class="hero-info-filters-pane">' + filterBarHtml + '</div>' +
			'<div class="hero-info-level-pane">' +
			'<h3>Level</h3>' +
			'<p>Scale hero stats to a specific in-game level (0-30). Most stats scale at 4% per level; some heroes have unique scaling (see Notes below the table).</p>' +
			'<input type="text" id="pf-scale-level" class="filter-min-games" inputmode="numeric" aria-label="Level (0-30)" value="' + levelValue + '">' +
			'</div></div>';

		var columns = [
			{
				key: "name",
				label: "Name",
				format: function(val, row) {
					return heroIconHtml(row.canonicalName) +
						'<a href="' + appLink('/hero-info/' + row.slug) + '">' +
						escapeHtml(row.name) + '</a>';
				},
				sortValue: function(row) { return row.name.toLowerCase(); }
			},
			{
				key: "role",
				label: "Role",
				format: function(val, row) {
					if (!row.role) return '<span class="text-muted">-</span>';
					return roleIconHtml(row.role) + escapeHtml(row.role);
				},
				sortValue: function(row) { return row.role.toLowerCase(); }
			},
			{
				key: "franchise",
				label: "Franchise",
				format: function(val) { return escapeHtml(val); },
				sortValue: function(row) { return row.franchise.toLowerCase(); }
			},
			{
				key: "health",
				label: "Health",
				className: "num",
				format: function(val, row) { return fmt1(scaled(row.health, row.healthScale, level)); },
				sortValue: function(row) { return scaled(row.health, row.healthScale, level); }
			},
			{
				key: "healthRegen",
				label: "Health Regen",
				className: "num",
				format: function(val, row) { return fmt1(scaled(row.healthRegen, row.healthRegenScale, level)); },
				sortValue: function(row) { return scaled(row.healthRegen, row.healthRegenScale, level); }
			},
			{
				key: "radius",
				label: "Unit Radius",
				className: "num",
				format: function(val, row) { return fmt2(row.radius); },
				sortValue: function(row) { return row.radius; }
			},
			{
				key: "attackRange",
				label: "Attack Range",
				className: "num",
				format: function(val, row) { return fmt2(row.attackRange); },
				sortValue: function(row) { return row.attackRange == null ? -1 : row.attackRange; }
			},
			{
				key: "attackSpeed",
				label: "Attack Speed",
				className: "num",
				format: function(val, row) { return fmt2(row.attackSpeed); },
				sortValue: function(row) { return row.attackSpeed == null ? -1 : row.attackSpeed; }
			},
			{
				key: "attackDamage",
				label: "Attack Damage",
				className: "num",
				format: function(val, row) { return fmt1(scaled(row.attackDamage, row.attackDamageScale, level)); },
				sortValue: function(row) { return scaled(row.attackDamage, row.attackDamageScale, level); }
			},
			{
				key: "dps",
				label: "DPS",
				className: "num",
				format: function(val, row) {
					if (row.attackDamage == null || row.attackSpeed == null || row.attackSpeed === 0) {
						return '<span class="text-muted">-</span>';
					}
					var dmg = scaled(row.attackDamage, row.attackDamageScale, level);
					return fmt1(dmg / row.attackSpeed);
				},
				sortValue: function(row) {
					if (row.attackDamage == null || row.attackSpeed == null || row.attackSpeed === 0) return -1;
					return scaled(row.attackDamage, row.attackDamageScale, level) / row.attackSpeed;
				}
			}
		];

		var sortKey = prevSort ? prevSort.key : "name";
		var sortDesc = prevSort ? prevSort.desc : false;
		var table = sortableTable("hero-info-table", columns, filteredRows, sortKey, sortDesc);
		html += '<div class="table-search">' +
			buildSearchInputHtml({
				id: "table-search-hero-info",
				value: filters.search || "",
				placeholder: "e.g. Tychus",
				ariaLabel: "Search hero info"
			}) +
			'</div>';
		html += table.buildHTML();

		html += '<div class="hero-info-notes">' +
			'<div class="hero-info-notes-title">Notes</div>' +
			'<h4>Scaling exceptions</h4>' +
			'<ul>' +
			'<li><strong>Cho</strong>: 4.5% scaling on health, health regen, and auto attack damage.</li>' +
			'<li><strong>Greymane, Medivh, The Butcher</strong>: health and health regen scale at 4.5%; auto attack damage stays at the standard 4%.</li>' +
			'<li><strong>Rexxar\'s Misha</strong>: health and health regen scale at 4.75%.</li>' +
			'<li><strong>Chen\'s Storm, Earth, and Fire forms</strong>: health regen does not scale per level. Base health still scales at 4%.</li>' +
			'<li><strong>Abathur\'s Symbiote</strong>: inherits its host\'s stats; no per-level scaling on its own row.</li>' +
			'</ul>' +
			'<h4>Spell power scaling deviations</h4>' +
			'<ul>' +
			'<li><strong>Gall</strong>: Shadowflame, Dread Orb, and Twisting Nether scale at 5% per level.</li>' +
			'<li><strong>Kael\'thas</strong>: Pyroblast scales at 5% per level.</li>' +
			'<li><strong>Tracer</strong>: Pulse Bomb scales at 6% per level.</li>' +
			'<li><strong>Li-Ming</strong>: Arcane Orb 3%, Magic Missiles 3.5%, Disintegrate and Wave of Force 5% per level.</li>' +
			'<li><strong>Kel\'Thuzad</strong>: most damage abilities scale at 2.5% per level.</li>' +
			'<li><strong>Murky</strong>: Pufferfish scales at 5.5% per level.</li>' +
			'<li><strong>Probius</strong>: Disruption Pulse and Warp Rift scale at 5% per level.</li>' +
			'<li><strong>Falstad</strong>: Hinterland Blast scales at 4.75% per level.</li>' +
			'<li><strong>Gul\'dan</strong>: Fel Flame and Corruption scale at 4.5% per level.</li>' +
			'<li><strong>Cho</strong>: Hammer of Twilight scales at 4.5% per level.</li>' +
			'<li><strong>Zagara</strong>: Hunter Killer scales at 4.5%-5% per level.</li>' +
			'<li><strong>Sgt. Hammer</strong>: Blunt Force Gun scales at 3% per level.</li>' +
			'</ul></div>';

		app.innerHTML = html;
		table.attachListeners(app);
		attachPageFilterListeners(app, filters, defaults, function() { renderContent(); });
		wireSearchInput(document.getElementById("table-search-hero-info"), app, filters, function() {
			renderContent();
		});
		attachLevelListener(app);
	}

	function attachLevelListener(container) {
		var input = container.querySelector("#pf-scale-level");
		if (!input) return;
		function commitLevel() {
			var raw = (input.value || "").trim();
			var next = "0";
			if (/^\d+$/.test(raw)) {
				var n = parseInt(raw, 10);
				if (n < 0) n = 0;
				if (n > 30) n = 30;
				next = String(n);
			}
			input.value = next;
			if (filters.scaleLevel !== next) {
				filters.scaleLevel = next;
				if (typeof writeFiltersToURL === "function") {
					writeFiltersToURL(filters, defaults);
				}
				renderContent();
			}
		}
		input.addEventListener("blur", commitLevel);
		input.addEventListener("keydown", function(e) {
			if (e.key === "Enter") {
				e.preventDefault();
				input.blur();
			}
		});
	}

	function setNoAltsToggleDisabled(disabled) {
		var toggle = document.getElementById("global-no-alts-toggle");
		if (!toggle) return;
		toggle.disabled = disabled;
		var label = toggle.parentElement;
		if (disabled) {
			label.classList.add("disabled");
			label.title = "Alts are not tracked on the Hero Info page.";
		} else {
			label.classList.remove("disabled");
			label.title = "Hide matches containing alt accounts";
		}
	}

	async function render() {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading hero info...</div>';

		setNoAltsToggleDisabled(true);
		GlobalFilters.stripNoAltsFromURL();

		try {
			heroInfo = await Data.heroInfo();
			readFiltersFromURL(filters, defaults);
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load hero info data.</div>';
		}
	}

	// Called by the router before dispatching any view so this page's
	// overrides don't leak into the next page.
	function restoreNoAltsToggle() {
		setNoAltsToggleDisabled(false);
		GlobalFilters.writeNoAltsToURL();
	}

	return { render: render, restoreNoAltsToggle: restoreNoAltsToggle };
})();
