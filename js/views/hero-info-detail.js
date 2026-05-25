// Per-hero subpage: full game reference (base stats, abilities, talents).
// Distinct from /hero/:slug which shows team match statistics.
var HeroInfoDetailView = (function() {
	// The Lost Vikings ship as one HDP entry; each Viking gets its own URL alias.
	var SLUG_ALIASES = {
		erik: "the-lost-vikings",
		baleog: "the-lost-vikings",
		olaf: "the-lost-vikings"
	};

	// Form/unit variants shown as separate stat blocks. Same data the main page
	// uses to synthesise table rows, restructured for vertical stat-block layout.
	var HERO_FORMS = {
		greymane: [
			{ label: "Human", weaponIndex: 1, useHeroUnit: null },
			{ label: "Worgen", weaponIndex: 0, useHeroUnit: null }
		],
		dva: [
			{ label: "Mech", weaponIndex: 0, useHeroUnit: null },
			{ label: "Pilot", weaponIndex: 0, useHeroUnit: "HeroDVaPilot" }
		],
		rexxar: [
			{ label: "Rexxar", weaponIndex: 1, useHeroUnit: null },
			{ label: "Misha", weaponIndex: 0, useHeroUnit: "RexxarMisha" }
		],
		"the-lost-vikings": [
			{ label: "Erik", weaponIndex: 0, useHeroUnit: "HeroErik" },
			{ label: "Baleog", weaponIndex: 0, useHeroUnit: "HeroBaleog" },
			{ label: "Olaf", weaponIndex: 0, useHeroUnit: "HeroOlaf" }
		]
	};

	var TALENT_TIERS = [1, 4, 7, 10, 13, 16, 20];
	var ABILITY_CATEGORIES = [
		{ key: "basic", label: "Basic Abilities" },
		{ key: "heroic", label: "Heroic Abilities" },
		{ key: "trait", label: "Trait" }
	];

	var heroInfo = null;
	var actualSlug = null;
	var hero = null;
	var level = 0;

	function findHeroUnit(unitId) {
		var units = hero.heroUnits || [];
		for (var i = 0; i < units.length; i++) {
			if (units[i][unitId]) return units[i][unitId];
		}
		return null;
	}

	function buildForm(descriptor) {
		var lifeSource;
		var weaponSource;
		var unit = null;

		if (descriptor && descriptor.useHeroUnit) {
			unit = findHeroUnit(descriptor.useHeroUnit);
			if (unit) {
				lifeSource = unit.life || {};
				weaponSource = (unit.weapons || [])[descriptor.weaponIndex] || null;
			}
		}

		if (!lifeSource) {
			lifeSource = {
				amount: hero.health,
				scale: hero.healthScale,
				regenRate: hero.healthRegen,
				regenScale: hero.healthRegenScale
			};
		}
		if (weaponSource === undefined) {
			var idx = descriptor ? descriptor.weaponIndex : 0;
			weaponSource = (hero.weapons || [])[idx] || null;
		}

		// Per-form radius (Vikings etc.) falls back to top-level. Zero means missing/no-body.
		var radius = null;
		if (unit && typeof unit.radius === "number") radius = unit.radius;
		if (radius == null && typeof hero.radius === "number") radius = hero.radius;
		if (radius === 0) radius = null;

		return {
			label: descriptor ? descriptor.label : null,
			health: lifeSource.amount || 0,
			healthScale: lifeSource.scale || 0,
			healthRegen: lifeSource.regenRate || 0,
			healthRegenScale: lifeSource.regenScale || 0,
			radius: radius,
			attackRange: weaponSource ? weaponSource.range : null,
			attackSpeed: weaponSource ? weaponSource.period : null,
			attackDamage: weaponSource ? weaponSource.damage : null,
			attackDamageScale: weaponSource ? (weaponSource.damageScale || 0) : 0
		};
	}

	function getForms() {
		var spec = HERO_FORMS[actualSlug];
		if (spec) {
			var forms = [];
			for (var i = 0; i < spec.length; i++) forms.push(buildForm(spec[i]));
			return forms;
		}
		return [buildForm(null)];
	}

	function scaled(base, scale) {
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

	function statBlockHtml(form) {
		var heading = form.label
			? '<div class="hero-info-form-label">' + escapeHtml(form.label) + '</div>'
			: '';

		var rows = [];
		rows.push({ label: "Health", value: fmt1(scaled(form.health, form.healthScale)) });
		rows.push({ label: "Health Regen", value: fmt1(scaled(form.healthRegen, form.healthRegenScale)) });
		rows.push({ label: "Unit Radius", value: fmt2(form.radius) });
		rows.push({ label: "Attack Range", value: fmt2(form.attackRange) });
		rows.push({ label: "Attack Speed", value: fmt2(form.attackSpeed) });
		rows.push({ label: "Attack Damage", value: fmt1(scaled(form.attackDamage, form.attackDamageScale)) });

		var dps = '<span class="text-muted">-</span>';
		if (form.attackDamage != null && form.attackSpeed && form.attackSpeed > 0) {
			dps = fmt1(scaled(form.attackDamage, form.attackDamageScale) / form.attackSpeed);
		}
		rows.push({ label: "DPS", value: dps });

		var rowsHtml = "";
		for (var i = 0; i < rows.length; i++) {
			rowsHtml += '<div class="hero-info-stat-row">' +
				'<span class="hero-info-stat-label">' + escapeHtml(rows[i].label) + '</span>' +
				'<span class="hero-info-stat-value">' + rows[i].value + '</span>' +
				'</div>';
		}

		return '<div class="hero-info-stat-block">' + heading + rowsHtml + '</div>';
	}

	function abilityCardHtml(ability) {
		var iconSrc = "img/hero/" + actualSlug + "/abilities/" + ability.icon;
		var typeBadge = ability.abilityType
			? '<span class="hero-info-ability-type">' + escapeHtml(ability.abilityType) + '</span>'
			: '';

		var meta = "";
		if (ability.cooldown) meta += '<div class="hero-info-ability-meta">' + cleanHotsText(ability.cooldown, level) + '</div>';
		if (ability.manaCost) meta += '<div class="hero-info-ability-meta">' + cleanHotsText(ability.manaCost, level) + '</div>';

		return '<div class="hero-info-ability-card">' +
			'<img class="hero-info-ability-icon" src="' + iconSrc + '" alt="">' +
			'<div class="hero-info-ability-body">' +
			'<div class="hero-info-ability-head">' +
			typeBadge +
			'<span class="hero-info-ability-name">' + escapeHtml(ability.name || "") + '</span>' +
			'</div>' +
			meta +
			'<div class="hero-info-ability-desc">' + cleanHotsText(ability.description, level) + '</div>' +
			'</div></div>';
	}

	function renderAbilities() {
		var html = '<h2 class="hero-info-section-title">Abilities</h2>';
		var abilities = hero.abilities || {};
		var any = false;
		for (var c = 0; c < ABILITY_CATEGORIES.length; c++) {
			var cat = ABILITY_CATEGORIES[c];
			var list = abilities[cat.key] || [];
			if (list.length === 0) continue;
			any = true;
			html += '<h3 class="hero-info-ability-group">' + escapeHtml(cat.label) + '</h3>';
			html += '<div class="hero-info-ability-grid">';
			for (var i = 0; i < list.length; i++) {
				html += abilityCardHtml(list[i]);
			}
			html += '</div>';
		}
		if (!any) html += '<p class="text-muted">No ability data available.</p>';
		return html;
	}

	function talentCardHtml(tier, choice, talent) {
		var iconSrc = "img/hero/" + actualSlug + "/talent" + tier + "_" + choice + ".png";
		var meta = "";
		if (talent.abilityType) meta += '<span class="hero-info-talent-type">' + escapeHtml(talent.abilityType) + '</span>';
		if (talent.isQuest) meta += '<span class="hero-info-talent-quest">Quest</span>';

		return '<div class="hero-info-talent-card">' +
			'<img class="hero-info-talent-icon" src="' + iconSrc + '" alt="">' +
			'<div class="hero-info-talent-body">' +
			'<div class="hero-info-talent-head">' +
			'<span class="hero-info-talent-name">' + escapeHtml(talent.name || "") + '</span>' +
			meta +
			'</div>' +
			'<div class="hero-info-talent-desc">' + cleanHotsText(talent.description, level) + '</div>' +
			'</div></div>';
	}

	function renderTalents() {
		var talents = hero.talents || {};
		var html = '<div class="hero-info-talents-section">';
		html += '<h2 class="hero-info-section-title">Talents</h2>';
		var any = false;

		for (var t = 0; t < TALENT_TIERS.length; t++) {
			var tier = TALENT_TIERS[t];
			var choices = [];
			for (var c = 1; c <= 6; c++) {
				var key = tier + "_" + c;
				if (talents[key]) choices.push({ choice: c, talent: talents[key] });
			}
			if (choices.length === 0) continue;
			any = true;

			html += '<div class="hero-info-talent-tier">' +
				'<div class="hero-info-talent-tier-label">Level ' + tier + '</div>' +
				'<div class="hero-info-talent-tier-grid">';
			for (var i = 0; i < choices.length; i++) {
				html += talentCardHtml(tier, choices[i].choice, choices[i].talent);
			}
			html += '</div></div>';
		}

		if (!any) html += '<p class="text-muted">No talent data available.</p>';
		html += '</div>';
		return html;
	}

	function renderContent() {
		var app = document.getElementById("app");

		var forms = getForms();
		var subtitleParts = [];
		if (hero.expandedRole) subtitleParts.push(roleIconHtml(hero.expandedRole) + escapeHtml(hero.expandedRole));
		if (hero.franchise) subtitleParts.push(escapeHtml(hero.franchise));
		if (hero.releaseDate) subtitleParts.push("Released " + escapeHtml(hero.releaseDate));

		var html = '<div class="page-header hero-info-detail-header">' +
			'<h1>' + heroIconHtml(hero.name, "lg") + escapeHtml(hero.name) + '</h1>' +
			'<div class="subtitle">' + subtitleParts.join(' &middot; ') + '</div>' +
			'<div class="hero-info-cross-link">' +
			'<a href="' + appLink('/hero/' + actualSlug) + '">View match stats for ' + escapeHtml(hero.name) + '</a>' +
			'</div></div>';

		html += '<div class="hero-info-detail-controls">' +
			'<label for="hid-scale-level" class="filter-label">Level</label>' +
			'<input type="text" id="hid-scale-level" value="' + level + '" inputmode="numeric" class="filter-min-games">' +
			'<span class="text-muted hero-info-detail-hint">0 - 30. Stats use <code>base &times; (1 + scale &times; level)</code>.</span>' +
			'</div>';

		html += '<div class="hero-info-stat-grid">';
		for (var i = 0; i < forms.length; i++) html += statBlockHtml(forms[i]);
		html += '</div>';

		html += renderAbilities();
		html += renderTalents();

		app.innerHTML = html;

		var input = document.getElementById("hid-scale-level");
		var commit = function() {
			var val = input.value.trim();
			var newLevel = level;
			if (val === "" || /^\d+$/.test(val)) {
				newLevel = Math.max(0, Math.min(30, Number(val) || 0));
			}
			if (newLevel !== level) {
				level = newLevel;
				renderContent();
			} else {
				input.value = String(level);
			}
		};
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", function(e) {
			if (e.key === "Enter") { e.preventDefault(); input.blur(); }
			else if (e.key === "Escape") { input.value = String(level); input.blur(); }
		});
	}

	async function render(slug) {
		var app = document.getElementById("app");
		app.innerHTML = '<div class="loading">Loading hero info...</div>';
		level = 0;

		try {
			heroInfo = await Data.heroInfo();
			actualSlug = SLUG_ALIASES[slug] || slug;
			hero = heroInfo[actualSlug];
			if (!hero) {
				app.innerHTML = '<div class="error">Hero not found.</div>';
				return;
			}
			renderContent();
		} catch (err) {
			app.innerHTML = '<div class="error">Failed to load hero info data.</div>';
		}
	}

	return { render: render };
})();
