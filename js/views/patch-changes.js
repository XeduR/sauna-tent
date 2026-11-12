// Patch Changes: what changed in the game data between two stored versions.
var PatchChangesView = (function() {
	var SECTIONS = [
		{ key: "heroes", label: "Heroes", singular: "hero", plural: "heroes" },
		{ key: "units", label: "Units", singular: "unit", plural: "units" },
		{ key: "maps", label: "Maps", singular: "map", plural: "maps" }
	];

	var DEFAULT_SECTION = "heroes";
	var NO_ALTS_REASON = "Alts are not tracked on the Patch Changes page.";

	// Top-level record fields with a fixed heading and position; any other field follows in file order.
	var RECORD_GROUPS = [
		{ key: "stats", label: "Stats" },
		{ key: "weapons", label: "Weapons" },
		{ key: "abilities", label: "Abilities" },
		{ key: "talents", label: "Talents" },
		{ key: "units", label: "Forms" }
	];

	// Item identifiers the engine pairs on; a change to one alone means nothing to a player.
	var INTERNAL_ID_KEYS = ["id", "nameId"];

	// Changes to these internal fields are never shown: the identifiers above and a talent's ability reference.
	var HIDDEN_KEYS = INTERNAL_ID_KEYS.concat(["ability"]);

	var WEAPON_TITLE = "Basic Attack";

	var FIELD_LABELS = {
		id: "ID",
		nameId: "ID",
		unitId: "Unit ID",
		expandedRole: "Role",
		isMelee: "Melee",
		life: "Health",
		speed: "Movement Speed",
		scale: "Scaling",
		regenRate: "Regen",
		regenScale: "Regen Scaling",
		period: "Attack Speed",
		damageScale: "Damage Scaling",
		parent: "Owner",
		isQuest: "Quest",
		countMax: "Max Charges",
		countStart: "Starting Charges",
		countUse: "Charges Used",
		isCountHidden: "Charges Hidden",
		isDisabled: "Disabled",
		lifeCost: "Health Cost",
		prerequisites: "Requires",
		summonedUnitIds: "Summoned Units",
		killXP: "Kill XP",
		commonAbilities: "Common Abilities"
	};

	// Game text for these fields already starts with its own label ("Cooldown: 8 seconds", "Mana: 60").
	var SELF_LABELLED_KEYS = ["cooldown", "cost"];

	var GROUP_LABELS = {
		activable: "Active"
	};

	var MAP_PARTS = [
		{ key: "units", label: "Units", heroes: false },
		{ key: "heroes", label: "Heroes", heroes: true }
	];

	var ARROW_ICON = '<svg class="patch-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

	var versions = [];
	var state = { from: null, to: null, section: DEFAULT_SECTION };
	var renderToken = 0;
	var sectionToken = 0;
	var comparisonCache = {};
	var loadedComparison = null;

	var SUMMARY_KINDS = [
		{ kind: "changed", label: "Changed" },
		{ kind: "added", label: "Added" },
		{ kind: "removed", label: "Removed" }
	];

	function sectionInfo(key) {
		for (var i = 0; i < SECTIONS.length; i++) {
			if (SECTIONS[i].key === key) return SECTIONS[i];
		}
		return null;
	}

	function findVersion(id) {
		for (var i = 0; i < versions.length; i++) {
			if (versions[i].id === id) return versions[i];
		}
		return null;
	}

	function versionLabel(id) {
		var version = findVersion(id);
		if (!version) return id;

		var suffix = "_" + version.channel;
		var shownId = version.id.slice(-suffix.length) === suffix ? version.id.slice(0, -suffix.length) : version.id;
		return String(version.channel).toUpperCase() + " " + shownId;
	}

	// Versions are ordered oldest to newest in versions.json, so the list index is the version's age.
	function versionIndex(id) {
		for (var i = 0; i < versions.length; i++) {
			if (versions[i].id === id) return i;
		}
		return -1;
	}

	// From is the floor: a To that is not newer moves to the version right after From, or to From itself at the newest.
	function pickFrom(id) {
		var fromIndex = versionIndex(id);
		state.from = id;

		if (versionIndex(state.to) <= fromIndex) {
			state.to = versions[Math.min(fromIndex + 1, versions.length - 1)].id;
		}
	}

	// To is the ceiling: a From that is not older moves to the version right before To, or to To itself at the oldest.
	function pickTo(id) {
		var toIndex = versionIndex(id);
		state.to = id;

		if (versionIndex(state.from) >= toIndex) {
			state.from = versions[Math.max(toIndex - 1, 0)].id;
		}
	}

	function hasNextPatch() {
		return versionIndex(state.from) < versions.length - 1;
	}

	function readStateFromURL() {
		var params = new URLSearchParams(window.location.search);
		var newest = versions[versions.length - 1].id;
		var previous = versions[versions.length - 2].id;

		state.to = findVersion(params.get("to")) ? params.get("to") : newest;
		state.from = findVersion(params.get("from")) ? params.get("from") : previous;
		state.section = sectionInfo(params.get("section")) ? params.get("section") : DEFAULT_SECTION;

		if (versionIndex(state.from) > versionIndex(state.to)) {
			var newer = state.from;
			state.from = state.to;
			state.to = newer;
		}
	}

	function writeStateToURL() {
		var params = new URLSearchParams(window.location.search);
		params.set("from", state.from);
		params.set("to", state.to);

		if (state.section === DEFAULT_SECTION) {
			params.delete("section");
		} else {
			params.set("section", state.section);
		}

		var qs = params.toString();
		history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
	}

	// Labels

	function fieldLabel(key) {
		if (FIELD_LABELS[key]) return FIELD_LABELS[key];

		var words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
		return words.charAt(0).toUpperCase() + words.slice(1);
	}

	function groupLabel(group) {
		var level = /^level(\d+)$/.exec(group);
		if (level) return "Level " + level[1];
		return GROUP_LABELS[group] || fieldLabel(group);
	}

	// Path segments are field keys, or { text } for a list entry's own name.
	function pathLabel(path) {
		return path.filter(function(segment, index) {
			return !(segment === "amount" && index > 0);
		}).map(function(segment) {
			return typeof segment === "string" ? fieldLabel(segment) : segment.text;
		}).join(" ");
	}

	// Values

	function gameTextHtml(text) {
		return cleanHotsText(String(text).replace(/\r?\n/g, "<n/>"), 0);
	}

	function isPlainObject(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}

	function child(value, key) {
		if (key === null) return value;
		return value !== null && typeof value === "object" ? value[key] : undefined;
	}

	function valueHtml(value) {
		if (value === null || value === undefined) return '<span class="text-muted">None</span>';
		if (typeof value === "string") return value === "" ? '<span class="text-muted">Empty</span>' : gameTextHtml(value);
		if (typeof value === "boolean") return value ? "Yes" : "No";
		if (typeof value === "number") return String(value);

		if (Array.isArray(value)) {
			if (value.length === 0) return '<span class="text-muted">None</span>';

			var nested = value.some(function(entry) { return entry !== null && typeof entry === "object"; });
			if (!nested) return value.map(valueHtml).join(", ");

			return '<div class="patch-value-list">' + value.map(function(entry) {
				return '<div class="patch-value-entry">' + valueHtml(entry) + '</div>';
			}).join("") + '</div>';
		}

		return Object.keys(value).map(function(key) {
			return '<span class="patch-kv"><span class="patch-kv-key">' + escapeHtml(fieldLabel(key)) + '</span> ' + valueHtml(value[key]) + '</span>';
		}).join("");
	}

	function proseHtml(words) {
		return words.map(function(segment) {
			if (segment.type === "same") return gameTextHtml(segment.text);

			// Edge whitespace stays outside the mark so the highlight hugs the words.
			var parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text);
			var tag = segment.type === "removed" ? "del" : "ins";
			var mark = parts[2] ? '<' + tag + ' class="patch-' + tag + '">' + gameTextHtml(parts[2]) + '</' + tag + '>' : '';
			return gameTextHtml(parts[1]) + mark + gameTextHtml(parts[3]);
		}).join("");
	}

	function isComplex(value) {
		if (isPlainObject(value)) return true;
		return Array.isArray(value) && value.some(function(entry) { return entry !== null && typeof entry === "object"; });
	}

	function isRecordList(value) {
		return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
	}

	function entryLabel(record, index) {
		var label = record.name || record.title;
		return { text: label ? String(label) : String(index + 1) };
	}

	function badgeHtml(kind) {
		var labels = { added: "Added", removed: "Removed", moved: "Moved" };
		return '<span class="patch-badge patch-badge-' + kind + '">' + labels[kind] + '</span>';
	}

	function valueRowHtml(change, path) {
		var lastKey = path[path.length - 1];
		var selfLabelled = SELF_LABELLED_KEYS.indexOf(lastKey) !== -1 && typeof (change.after != null ? change.after : change.before) === "string";
		var cardDescription = path.length === 1 && lastKey === "description";
		var labelled = path.length > 0 && !selfLabelled && !cardDescription;
		var label = labelled
			? '<div class="patch-row-label">' + escapeHtml(pathLabel(path)) + '</div>'
			: '';
		var body;

		if (change.kind === "added") {
			body = badgeHtml("added") + '<span class="patch-after">' + valueHtml(change.after) + '</span>';
		} else if (change.kind === "removed") {
			body = badgeHtml("removed") + '<span class="patch-before">' + valueHtml(change.before) + '</span>';
		} else if (change.words) {
			body = '<div class="patch-prose">' + proseHtml(change.words) + '</div>';
		} else if (isComplex(change.before) || isComplex(change.after)) {
			body = '<div class="patch-stack">' +
				'<div class="patch-before">' + valueHtml(change.before) + '</div>' +
				ARROW_ICON +
				'<div class="patch-after">' + valueHtml(change.after) + '</div>' +
				'</div>';
		} else {
			body = '<span class="patch-before">' + valueHtml(change.before) + '</span>' +
				ARROW_ICON +
				'<span class="patch-after">' + valueHtml(change.after) + '</span>';
		}

		var rowClass = labelled ? "patch-row" : "patch-row patch-row-unlabelled";
		return '<div class="' + rowClass + '">' + label + '<div class="patch-row-value">' + body + '</div></div>';
	}

	// Change filtering

	function visibleChanges(changes) {
		var result = [];

		changes.forEach(function(change) {
			if (HIDDEN_KEYS.indexOf(change.key) !== -1) return;

			if (change.type === "object") {
				var nested = visibleChanges(change.changes);
				if (nested.length > 0) result.push(Object.assign({}, change, { changes: nested }));
				return;
			}

			if (change.type === "items") {
				var items = [];

				change.items.forEach(function(item) {
					if (item.kind !== "changed" && item.kind !== "moved") {
						items.push(item);
						return;
					}

					var itemChanges = visibleChanges(item.changes);
					if (item.kind === "changed" && itemChanges.length === 0) return;
					items.push(Object.assign({}, item, { changes: itemChanges }));
				});

				if (items.length > 0) result.push(Object.assign({}, change, { items: items }));
				return;
			}

			result.push(change);
		});

		return result;
	}

	// Items

	function findItem(container, group, item) {
		var list = Array.isArray(container) ? container : child(container, group);
		if (!Array.isArray(list)) return null;

		for (var i = 0; i < list.length; i++) {
			var record = list[i];
			if (!isPlainObject(record)) continue;

			for (var keyIndex = 0; keyIndex < INTERNAL_ID_KEYS.length; keyIndex++) {
				var idValue = record[INTERNAL_ID_KEYS[keyIndex]];
				if (idValue != null && String(idValue) === String(item.id)) return record;
			}
		}

		for (var index = 0; index < list.length; index++) {
			if (isPlainObject(list[index]) && item.name != null && list[index].name === item.name) return list[index];
		}

		return null;
	}

	function readableFieldsHtml(record) {
		if (!isPlainObject(record)) return "";

		var html = "";

		["cooldown", "cost"].forEach(function(key) {
			if (record[key] == null || record[key] === "") return;

			var text = typeof record[key] === "string" ? valueHtml(record[key]) : escapeHtml(fieldLabel(key)) + ": " + valueHtml(record[key]);
			html += '<div class="patch-item-meta">' + text + '</div>';
		});

		if (record.description) html += '<div class="patch-item-desc">' + gameTextHtml(record.description) + '</div>';
		return html;
	}

	// Weapons carry only an internal id, so they are titled by their place in the record's weapon list.
	function weaponTitle(record, list) {
		if (!Array.isArray(list) || list.length < 2) return WEAPON_TITLE;
		return WEAPON_TITLE + " " + (list.indexOf(record) + 1);
	}

	function itemCardHtml(item, grouped, beforeList, afterList, isWeapon) {
		var beforeGroup = item.fromGroup || item.group;
		var afterRecord = item.kind === "removed" ? item.record : findItem(afterList, item.group, item);
		var beforeRecord = item.kind === "removed" ? item.record : findItem(beforeList, beforeGroup, item);
		var record = item.record || afterRecord || beforeRecord || {};

		var title = item.name || String(item.id);
		if (isWeapon) title = item.kind === "removed" ? weaponTitle(item.record, beforeList) : weaponTitle(afterRecord, afterList);

		var typeBadge = record.type
			? '<span class="hero-info-ability-type">' + escapeHtml(String(record.type)) + '</span>'
			: '';
		var groupTag = grouped && item.kind !== "moved"
			? '<span class="patch-item-group">' + escapeHtml(groupLabel(item.group)) + '</span>'
			: '';

		var status = "";
		if (item.kind === "moved") {
			status = badgeHtml("moved") +
				'<span class="patch-item-group patch-item-move">' +
				escapeHtml(groupLabel(item.fromGroup)) + ARROW_ICON + escapeHtml(groupLabel(item.group)) +
				'</span>';
		} else if (item.kind === "added" || item.kind === "removed") {
			status = badgeHtml(item.kind);
		}

		var body = item.kind === "added" || item.kind === "removed"
			? readableFieldsHtml(item.record)
			: changesHtml(item.changes, beforeRecord, afterRecord, []);

		return '<article class="patch-item patch-item-' + item.kind + '">' +
			'<div class="patch-item-head">' +
			typeBadge +
			'<span class="patch-item-name">' + escapeHtml(title) + '</span>' +
			groupTag +
			status +
			'</div>' +
			(body ? '<div class="patch-item-body">' + body + '</div>' : '') +
			'</article>';
	}

	function itemsHtml(change, beforeList, afterList) {
		return '<div class="patch-items">' + change.items.map(function(item) {
			return itemCardHtml(item, change.grouped, beforeList, afterList, change.key === "weapons");
		}).join("") + '</div>';
	}

	// Change lists: value rows, nested objects flattened into labelled rows, item lists as cards.
	function changesHtml(changes, before, after, path) {
		var html = "";

		changes.forEach(function(change) {
			var childPath = change.key === null ? path : path.concat(change.key);
			var childBefore = child(before, change.key);
			var childAfter = child(after, change.key);

			if (change.type === "object") {
				html += changesHtml(change.changes, childBefore, childAfter, childPath);
			} else if (change.type === "items") {
				var subhead = childPath.length > 0
					? '<div class="patch-subhead">' + escapeHtml(pathLabel(childPath)) + '</div>'
					: '';
				html += subhead + itemsHtml(change, childBefore, childAfter);
			} else if (change.kind === "changed" && isRecordList(change.before) && isRecordList(change.after) && change.before.length === change.after.length) {
				html += recordListHtml(change.before, change.after, childPath);
			} else {
				html += valueRowHtml(change, childPath);
			}
		});

		return html;
	}

	// Lists of records without ids (map objectives) compare entry by entry when their length holds.
	function recordListHtml(beforeList, afterList, path) {
		var html = "";

		afterList.forEach(function(afterRecord, index) {
			var changes = visibleChanges(PatchDiff.diffRecord(beforeList[index], afterRecord));
			if (changes.length > 0) html += changesHtml(changes, beforeList[index], afterRecord, path.concat(entryLabel(afterRecord, index)));
		});

		return html;
	}

	function groupHtml(label, body) {
		return '<div class="patch-group">' +
			'<h3 class="patch-group-title">' + escapeHtml(label) + '</h3>' +
			'<div class="patch-group-body">' + body + '</div>' +
			'</div>';
	}

	// A group's heading already names its field, so the body starts one level down.
	function groupBodyHtml(change, before, after) {
		var childBefore = child(before, change.key);
		var childAfter = child(after, change.key);

		if (change.type === "object") return changesHtml(change.changes, childBefore, childAfter, []);
		if (change.type === "items") return itemsHtml(change, childBefore, childAfter);
		return valueRowHtml(change, []);
	}

	function recordGroupsHtml(changes, before, after) {
		var byKey = {};
		changes.forEach(function(change) { byKey[change.key] = change; });

		var known = {};
		var html = "";

		RECORD_GROUPS.forEach(function(group) {
			known[group.key] = true;
			if (byKey[group.key]) html += groupHtml(group.label, groupBodyHtml(byKey[group.key], before, after));
		});

		changes.forEach(function(change) {
			if (known[change.key]) return;
			html += groupHtml(fieldLabel(change.key), groupBodyHtml(change, before, after));
		});

		return html;
	}

	// Collections (heroes, units, and the units and heroes inside a map)

	function collectionEntries(diff, nameOf) {
		var entries = [];

		diff.changed.forEach(function(entry) {
			var changes = visibleChanges(entry.changes);
			if (changes.length > 0) entries.push({ kind: "changed", key: entry.key, name: nameOf(entry), changes: changes });
		});

		diff.added.concat(diff.removed).forEach(function(entry) {
			entries.push({ kind: entry.kind, key: entry.key, name: nameOf(entry) });
		});

		entries.sort(function(left, right) {
			return left.name.localeCompare(right.name);
		});

		return entries;
	}

	function recordName(entry) {
		return entry.name || entry.key;
	}

	function entryTitleHtml(entry, heroes) {
		if (heroes && entry.kind === "changed") {
			return '<a class="patch-entry-link" href="' + escapeHtml(appLink("/hero-info/" + entry.key)) + '">' +
				heroIconHtml(entry.name) + escapeHtml(entry.name) + '</a>';
		}

		return '<span class="patch-entry-name">' + escapeHtml(entry.name) + '</span>';
	}

	function entryHtml(entry, body, heroes, nested) {
		var classes = "patch-entry" + (nested ? " patch-entry-nested" : "") + (entry.kind !== "changed" ? " patch-entry-compact" : "");
		var badge = entry.kind !== "changed" ? badgeHtml(entry.kind) : "";

		return '<section class="' + classes + '">' +
			'<header class="patch-entry-head">' + entryTitleHtml(entry, heroes) + badge + '</header>' +
			(body ? '<div class="patch-entry-body">' + body + '</div>' : '') +
			'</section>';
	}

	function collectionHtml(entries, beforeMap, afterMap, heroes, nested) {
		return entries.map(function(entry) {
			var body = entry.kind === "changed"
				? recordGroupsHtml(entry.changes, beforeMap[entry.key], afterMap[entry.key])
				: "";
			return entryHtml(entry, body, heroes, nested);
		}).join("");
	}

	function summaryHtml(entries, info) {
		var counts = { changed: 0, added: 0, removed: 0 };
		entries.forEach(function(entry) { counts[entry.kind]++; });

		var noun = counts.changed === 1 ? info.singular : info.plural;

		return '<p class="patch-summary">' +
			'<span class="patch-count patch-count-changed"><strong>' + counts.changed + '</strong> ' + noun + ' changed</span>' +
			'<span class="patch-count patch-count-added"><strong>' + counts.added + '</strong> added</span>' +
			'<span class="patch-count patch-count-removed"><strong>' + counts.removed + '</strong> removed</span>' +
			'</p>';
	}

	function commonAbilitiesHtml(beforeList, afterList) {
		var changes = visibleChanges(PatchDiff.diffRecord(beforeList || [], afterList || []));
		if (changes.length === 0) return "";

		return changesHtml(changes, beforeList || [], afterList || [], []);
	}

	function messageHtml(text) {
		return '<div class="patch-message">' + escapeHtml(text) + '</div>';
	}

	function noChangesHtml(info) {
		return messageHtml("No changes to " + info.plural + " between these versions.");
	}

	// Sections: each returns the entries it lists, in display order, with its markup.

	function sectionResult(entries, html) {
		return { entries: entries, html: html };
	}

	function heroesSectionHtml(before, after, info) {
		var beforeMap = before.heroes || {};
		var afterMap = after.heroes || {};
		var entries = collectionEntries(PatchDiff.diffCollections(beforeMap, afterMap), recordName);
		var commonBody = commonAbilitiesHtml(before.commonAbilities, after.commonAbilities);
		var common = commonBody ? entryHtml({ kind: "changed", name: fieldLabel("commonAbilities") }, commonBody, false, false) : "";

		if (entries.length === 0 && !common) return sectionResult([], noChangesHtml(info));

		return sectionResult(entries, summaryHtml(entries, info) +
			'<div class="patch-entries">' + common + collectionHtml(entries, beforeMap, afterMap, true, false) + '</div>');
	}

	function unitsSectionHtml(before, after, info) {
		var beforeMap = before.units || {};
		var afterMap = after.units || {};
		var entries = collectionEntries(PatchDiff.diffCollections(beforeMap, afterMap), recordName);

		if (entries.length === 0) return sectionResult([], noChangesHtml(info));

		return sectionResult(entries, summaryHtml(entries, info) +
			'<div class="patch-entries">' + collectionHtml(entries, beforeMap, afterMap, false, false) + '</div>');
	}

	function mapName(entry) {
		return (entry.record && entry.record.map && entry.record.map.name) || entry.key;
	}

	function mapBodyHtml(beforeMap, afterMap) {
		var html = "";
		var beforeRecord = beforeMap.map || {};
		var afterRecord = afterMap.map || {};
		var recordChanges = visibleChanges(PatchDiff.diffRecord(beforeRecord, afterRecord));

		if (recordChanges.length > 0) html += groupHtml("Map", changesHtml(recordChanges, beforeRecord, afterRecord, []));

		MAP_PARTS.forEach(function(part) {
			var beforePart = beforeMap[part.key] || {};
			var afterPart = afterMap[part.key] || {};
			var entries = collectionEntries(PatchDiff.diffCollections(beforePart, afterPart), recordName);
			if (entries.length > 0) html += groupHtml(part.label, collectionHtml(entries, beforePart, afterPart, part.heroes, true));
		});

		var common = commonAbilitiesHtml(beforeMap.commonAbilities, afterMap.commonAbilities);
		if (common) html += groupHtml(fieldLabel("commonAbilities"), common);

		return html;
	}

	function mapsSectionHtml(before, after, info) {
		var beforeMaps = before.maps || {};
		var afterMaps = after.maps || {};
		var diff = PatchDiff.diffCollections(beforeMaps, afterMaps);
		var entries = [];
		var bodies = {};

		diff.changed.forEach(function(entry) {
			var body = mapBodyHtml(beforeMaps[entry.key] || {}, afterMaps[entry.key] || {});
			if (!body) return;

			bodies[entry.key] = body;
			entries.push({ kind: "changed", key: entry.key, name: mapName({ key: entry.key, record: afterMaps[entry.key] }) });
		});

		diff.added.concat(diff.removed).forEach(function(entry) {
			entries.push({ kind: entry.kind, key: entry.key, name: mapName(entry) });
		});

		if (entries.length === 0) return sectionResult([], noChangesHtml(info));

		entries.sort(function(left, right) {
			return left.name.localeCompare(right.name);
		});

		return sectionResult(entries, summaryHtml(entries, info) +
			'<div class="patch-entries">' + entries.map(function(entry) {
				return entryHtml(entry, bodies[entry.key] || "", false, false);
			}).join("") + '</div>');
	}

	var SECTION_RENDERERS = {
		heroes: heroesSectionHtml,
		units: unitsSectionHtml,
		maps: mapsSectionHtml
	};

	function missingSnapshotText(info, from, to, snapshots) {
		var missing = [];
		if (!snapshots[0]) missing.push(versionLabel(from));
		if (!snapshots[1]) missing.push(versionLabel(to));
		return "No " + info.singular + " data for " + missing.join(" or ") + ".";
	}

	// Loads and diffs one dataset for both sides; a failure stays with its own dataset.
	async function loadDataset(from, to, info) {
		try {
			var snapshots = await Promise.all([
				Data.gameSnapshot(from, info.key),
				Data.gameSnapshot(to, info.key)
			]);

			if (!snapshots[0] || !snapshots[1]) {
				var missing = missingSnapshotText(info, from, to, snapshots);
				return { unavailable: missing, html: messageHtml(missing) };
			}

			return SECTION_RENDERERS[info.key](snapshots[0], snapshots[1], info);
		} catch (err) {
			console.error(err);
			var failure = "Failed to load " + info.singular + " data.";
			return { unavailable: failure, failed: true, html: '<div class="error">' + escapeHtml(failure) + '</div>' };
		}
	}

	function comparisonKey() {
		return state.from + "|" + state.to;
	}

	// Summary table

	function summaryCellHtml(result, kind) {
		var names = result.entries.filter(function(entry) {
			return entry.kind === kind.kind;
		}).map(function(entry) {
			return escapeHtml(entry.name);
		});

		var content = names.length > 0
			? '<ul class="patch-table-list"><li>' + names.join('</li><li>') + '</li></ul>'
			: '<span class="text-muted">-</span>';
		return '<td class="patch-table-cell patch-table-' + kind.kind + '">' +
			'<span class="patch-table-label" aria-hidden="true">' + kind.label + '</span>' +
			'<span class="patch-table-names">' + content + '</span>' +
			'</td>';
	}

	function summaryRowHtml(info, result) {
		var cells;

		if (!result) {
			cells = SUMMARY_KINDS.map(function(kind) {
				return '<td class="patch-table-cell patch-table-' + kind.kind + '">' +
					'<span class="patch-table-label" aria-hidden="true">' + kind.label + '</span>' +
					'<span class="patch-table-skeleton"></span>' +
					'</td>';
			}).join("");
		} else if (result.unavailable) {
			cells = '<td class="patch-table-cell patch-table-unavailable' + (result.failed ? ' patch-table-failed' : '') + '" colspan="' + SUMMARY_KINDS.length + '">' +
				escapeHtml(result.unavailable) + '</td>';
		} else {
			cells = SUMMARY_KINDS.map(function(kind) { return summaryCellHtml(result, kind); }).join("");
		}

		return '<tr><th scope="row" class="patch-table-row-title">' + info.label + '</th>' + cells + '</tr>';
	}

	function summaryTableHtml(comparison) {
		var head = SUMMARY_KINDS.map(function(kind) {
			return '<th scope="col" class="patch-table-head patch-table-' + kind.kind + '">' + kind.label + '</th>';
		}).join("");

		var rows = SECTIONS.map(function(info) {
			return summaryRowHtml(info, comparison ? comparison[info.key] : null);
		}).join("");

		return '<table class="patch-table" aria-label="Changed, added and removed by data set"' + (comparison ? '' : ' aria-busy="true"') + '>' +
			'<thead><tr><td class="patch-table-corner"></td>' + head + '</tr></thead>' +
			'<tbody>' + rows + '</tbody>' +
			'</table>';
	}

	// Comparison loading: all three datasets at once, shared by the table and the sections.

	function renderSection() {
		var container = document.getElementById("patch-section");
		if (!container) return;

		if (state.from === state.to) {
			container.innerHTML = messageHtml("Both sides are the same version.");
			return;
		}

		if (!loadedComparison || loadedComparison.key !== comparisonKey()) {
			container.innerHTML = '<div class="loading">Loading changes...</div>';
			return;
		}

		container.innerHTML = loadedComparison.data[state.section].html;
	}

	function renderSummary(comparison) {
		var overview = document.getElementById("patch-overview");
		if (!overview) return;

		overview.hidden = state.from === state.to;
		overview.innerHTML = state.from === state.to ? "" : summaryTableHtml(comparison);
	}

	async function loadComparison() {
		var token = ++sectionToken;
		var key = comparisonKey();
		var comparison = comparisonCache[key];

		if (state.from === state.to) {
			renderSummary(null);
			renderSection();
			return;
		}

		if (!comparison) {
			renderSummary(null);
			renderSection();

			var from = state.from;
			var to = state.to;
			var results = await Promise.all(SECTIONS.map(function(info) {
				return loadDataset(from, to, info);
			}));

			comparison = {};
			var failed = false;

			SECTIONS.forEach(function(info, index) {
				comparison[info.key] = results[index];
				if (results[index].failed) failed = true;
			});

			// Failures stay uncached so the next comparison change tries again.
			if (!failed) comparisonCache[key] = comparison;
		}

		if (token !== sectionToken || !document.getElementById("patch-section")) return;

		loadedComparison = { key: key, data: comparison };
		renderSummary(comparison);
		renderSection();
	}

	// Page shell and controls

	function versionOptionsHtml(selected) {
		var html = "";

		for (var i = versions.length - 1; i >= 0; i--) {
			var id = versions[i].id;
			html += '<option value="' + escapeHtml(id) + '"' + (id === selected ? ' selected' : '') + '>' +
				escapeHtml(versionLabel(id)) + '</option>';
		}

		return html;
	}

	function tabsHtml() {
		return SECTIONS.map(function(section) {
			var selected = section.key === state.section;
			return '<button type="button" role="tab" class="patch-tab' + (selected ? ' active' : '') + '"' +
				' id="patch-tab-' + section.key + '" data-section="' + section.key + '"' +
				' aria-selected="' + (selected ? "true" : "false") + '" aria-controls="patch-section"' +
				' tabindex="' + (selected ? "0" : "-1") + '">' + section.label + '</button>';
		}).join("");
	}

	function headerHtml() {
		return '<div class="page-header"><h1>Patch Changes</h1></div>';
	}

	function updateControls() {
		var app = document.getElementById("app");
		app.querySelector("#patch-from").value = state.from;
		app.querySelector("#patch-to").value = state.to;
		app.querySelector(".patch-next").disabled = !hasNextPatch();

		var tabs = app.querySelectorAll(".patch-tab");
		for (var i = 0; i < tabs.length; i++) {
			var selected = tabs[i].getAttribute("data-section") === state.section;
			tabs[i].classList.toggle("active", selected);
			tabs[i].setAttribute("aria-selected", selected ? "true" : "false");
			tabs[i].tabIndex = selected ? 0 : -1;
		}

		app.querySelector("#patch-section").setAttribute("aria-labelledby", "patch-tab-" + state.section);
	}

	function applyComparison() {
		updateControls();
		writeStateToURL();
		loadComparison();
	}

	function applySection() {
		updateControls();
		writeStateToURL();
		renderSection();
	}

	function bindControls() {
		var app = document.getElementById("app");
		var fromSelect = app.querySelector("#patch-from");
		var toSelect = app.querySelector("#patch-to");
		var tabList = app.querySelector(".patch-tabs");

		fromSelect.addEventListener("change", function() {
			pickFrom(this.value);
			applyComparison();
		});

		toSelect.addEventListener("change", function() {
			pickTo(this.value);
			applyComparison();
		});

		app.querySelector(".patch-next").addEventListener("click", function() {
			if (!hasNextPatch()) return;

			state.to = versions[versionIndex(state.from) + 1].id;
			applyComparison();
		});

		tabList.addEventListener("click", function(event) {
			var tab = event.target.closest(".patch-tab");
			if (!tab || tab.getAttribute("data-section") === state.section) return;

			state.section = tab.getAttribute("data-section");
			applySection();
		});

		// Arrow keys move between tabs, as in the WAI-ARIA tabs pattern.
		tabList.addEventListener("keydown", function(event) {
			var step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
			if (step === 0) return;

			event.preventDefault();

			var index = SECTIONS.indexOf(sectionInfo(state.section));
			var next = SECTIONS[(index + step + SECTIONS.length) % SECTIONS.length];
			state.section = next.key;
			applySection();
			app.querySelector("#patch-tab-" + next.key).focus();
		});
	}

	function renderPage() {
		var app = document.getElementById("app");

		app.innerHTML = headerHtml() +
			'<div class="patch-controls">' +
			'<div class="filter-field patch-version-field">' +
			'<label for="patch-from">From</label>' +
			'<select id="patch-from">' + versionOptionsHtml(state.from) + '</select>' +
			'</div>' +
			'<div class="patch-to-group">' +
			'<div class="filter-field patch-version-field">' +
			'<label for="patch-to">To</label>' +
			'<select id="patch-to">' + versionOptionsHtml(state.to) + '</select>' +
			'</div>' +
			'<button type="button" class="patch-next">Next patch' + ARROW_ICON + '</button>' +
			'</div>' +
			'</div>' +
			'<div id="patch-overview" class="patch-overview"></div>' +
			'<div class="patch-tabs" role="tablist" aria-label="Data">' + tabsHtml() + '</div>' +
			'<div id="patch-section" class="patch-section" role="tabpanel" tabindex="0"></div>';

		updateControls();
		bindControls();
		loadComparison();
	}

	async function render() {
		var app = document.getElementById("app");
		var token = ++renderToken;

		app.innerHTML = '<div id="patch-root" class="loading">Loading game versions...</div>';
		GlobalFilters.lockNoAltsToggle(NO_ALTS_REASON);

		var loaded;
		try {
			loaded = await Data.gameVersions();
		} catch (err) {
			if (token === renderToken && document.getElementById("patch-root")) {
				app.innerHTML = headerHtml() + '<div class="error">Failed to load game versions.</div>';
			}
			return;
		}

		if (token !== renderToken || !document.getElementById("patch-root")) return;

		versions = Array.isArray(loaded) ? loaded : [];

		if (versions.length < 2) {
			app.innerHTML = headerHtml() + messageHtml("At least two game versions are needed for a comparison.");
			return;
		}

		readStateFromURL();
		writeStateToURL();
		renderPage();
	}

	return { render: render };
})();
