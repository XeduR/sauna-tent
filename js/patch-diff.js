// Structural diff of two game-data versions for the Patch Changes page; plain data in, plain data out.
var PatchDiff = (function() {
	// Fields that identify an item in a list, tried in order; weapons carry nameId instead of id.
	var ID_KEYS = ["id", "nameId"];

	function isPlainObject(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}

	function has(object, key) {
		return Object.prototype.hasOwnProperty.call(object, key);
	}

	function deepEqual(left, right) {
		if (left === right) return true;

		if (Array.isArray(left)) {
			if (!Array.isArray(right) || left.length !== right.length) return false;

			for (var i = 0; i < left.length; i++) {
				if (!deepEqual(left[i], right[i])) return false;
			}

			return true;
		}

		if (isPlainObject(left) && isPlainObject(right)) {
			var leftKeys = Object.keys(left);
			if (leftKeys.length !== Object.keys(right).length) return false;

			for (var index = 0; index < leftKeys.length; index++) {
				var key = leftKeys[index];
				if (!has(right, key) || !deepEqual(left[key], right[key])) return false;
			}

			return true;
		}

		return false;
	}

	// Union of both key lists in after order, with before-only keys placed after their before-side neighbour.
	function orderedKeys(before, after) {
		var beforeKeys = Object.keys(before);
		var keys = [];
		var nextBefore = 0;

		function flushBeforeOnly(limit) {
			while (nextBefore < limit) {
				if (!has(after, beforeKeys[nextBefore])) keys.push(beforeKeys[nextBefore]);
				nextBefore++;
			}
		}

		Object.keys(after).forEach(function(key) {
			if (has(before, key)) flushBeforeOnly(beforeKeys.indexOf(key) + 1);
			keys.push(key);
		});

		flushBeforeOnly(beforeKeys.length);
		return keys;
	}

	// Whitespace runs are tokens of their own, so "153~~0.04~~" and "\n\n" each stay whole.
	function tokenize(text) {
		return text.match(/\s+|\S+/g) || [];
	}

	function lcsOps(oldTokens, newTokens) {
		var rows = oldTokens.length;
		var columns = newTokens.length;
		var width = columns + 1;
		var table = new Uint32Array((rows + 1) * width);

		for (var row = rows - 1; row >= 0; row--) {
			for (var column = columns - 1; column >= 0; column--) {
				var cell = row * width + column;

				if (oldTokens[row] === newTokens[column]) {
					table[cell] = table[cell + width + 1] + 1;
				} else {
					table[cell] = Math.max(table[cell + width], table[cell + 1]);
				}
			}
		}

		var ops = [];
		var oldIndex = 0;
		var newIndex = 0;

		while (oldIndex < rows && newIndex < columns) {
			if (oldTokens[oldIndex] === newTokens[newIndex]) {
				ops.push({ type: "same", text: oldTokens[oldIndex] });
				oldIndex++;
				newIndex++;
			} else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
				ops.push({ type: "removed", text: oldTokens[oldIndex] });
				oldIndex++;
			} else {
				ops.push({ type: "added", text: newTokens[newIndex] });
				newIndex++;
			}
		}

		for (; oldIndex < rows; oldIndex++) ops.push({ type: "removed", text: oldTokens[oldIndex] });
		for (; newIndex < columns; newIndex++) ops.push({ type: "added", text: newTokens[newIndex] });

		return ops;
	}

	// Collects each changed stretch into one removed and one added segment; a lone space between two
	// replacements joins the stretch so "a b" -> "x y" reads as one replacement, not two.
	function buildSegments(ops) {
		var segments = [];
		var removed = "";
		var added = "";
		var heldSpace = "";

		function push(type, text) {
			if (!text) return;

			var last = segments[segments.length - 1];
			if (last && last.type === type) {
				last.text += text;
			} else {
				segments.push({ type: type, text: text });
			}
		}

		function flush() {
			push("removed", removed);
			push("added", added);
			push("same", heldSpace);
			removed = "";
			added = "";
			heldSpace = "";
		}

		ops.forEach(function(op) {
			if (op.type === "same") {
				if (removed && added && /^\s+$/.test(op.text)) {
					heldSpace += op.text;
					return;
				}

				flush();
				push("same", op.text);
				return;
			}

			if (heldSpace) {
				removed += heldSpace;
				added += heldSpace;
				heldSpace = "";
			}

			if (op.type === "removed") {
				removed += op.text;
			} else {
				added += op.text;
			}
		});

		flush();
		return segments;
	}

	function diffWords(before, after) {
		var oldTokens = tokenize(before);
		var newTokens = tokenize(after);

		var start = 0;
		while (start < oldTokens.length && start < newTokens.length && oldTokens[start] === newTokens[start]) start++;

		var oldEnd = oldTokens.length;
		var newEnd = newTokens.length;
		while (oldEnd > start && newEnd > start && oldTokens[oldEnd - 1] === newTokens[newEnd - 1]) {
			oldEnd--;
			newEnd--;
		}

		var ops = [];
		if (start > 0) ops.push({ type: "same", text: oldTokens.slice(0, start).join("") });
		ops = ops.concat(lcsOps(oldTokens.slice(start, oldEnd), newTokens.slice(start, newEnd)));
		if (oldEnd < oldTokens.length) ops.push({ type: "same", text: oldTokens.slice(oldEnd).join("") });

		return buildSegments(ops);
	}

	function valueChange(key, kind, before, after) {
		var change = { key: key, kind: kind, type: "value" };
		if (kind !== "added") change.before = before;
		if (kind !== "removed") change.after = after;

		var prose = typeof before === "string" && typeof after === "string" && (/\s/.test(before) || /\s/.test(after));
		if (kind === "changed" && prose) change.words = diffWords(before, after);

		return change;
	}

	function identityKey(items) {
		if (items.length === 0) return null;

		for (var i = 0; i < ID_KEYS.length; i++) {
			var idKey = ID_KEYS[i];
			var identified = items.every(function(item) {
				return isPlainObject(item) && item[idKey] != null && typeof item[idKey] !== "object";
			});

			if (identified) return idKey;
		}

		return null;
	}

	function listEntries(list, group) {
		return list.map(function(item) {
			return { item: item, group: group };
		});
	}

	// Entries of an object whose every value is a list of identified items, or null for any other object.
	function groupedEntries(object) {
		var entries = [];
		var keys = Object.keys(object);

		for (var i = 0; i < keys.length; i++) {
			if (!Array.isArray(object[keys[i]])) return null;
			entries = entries.concat(listEntries(object[keys[i]], keys[i]));
		}

		return entries;
	}

	function labelOf(record, idKey) {
		if (isPlainObject(record) && record.name != null) return record.name;
		if (isPlainObject(record) && idKey && record[idKey] != null) return String(record[idKey]);
		return null;
	}

	function pushQueue(queues, key, index) {
		if (!queues[key]) queues[key] = [];
		queues[key].push(index);
	}

	// Pairs items by identity, then pairs the leftovers by equal name so an id rename is one change.
	function pairItems(before, after, idKey) {
		var pairOfAfter = after.map(function() { return -1; });
		var pairedBefore = before.map(function() { return false; });

		function pairBy(field, keyOf) {
			var queues = Object.create(null);

			before.forEach(function(entry, index) {
				var value = keyOf(entry.item);
				if (!pairedBefore[index] && value != null) pushQueue(queues, field + ":" + value, index);
			});

			after.forEach(function(entry, index) {
				var value = keyOf(entry.item);
				if (pairOfAfter[index] !== -1 || value == null) return;

				var queue = queues[field + ":" + value];
				if (!queue || queue.length === 0) return;

				var beforeIndex = queue.shift();
				pairOfAfter[index] = beforeIndex;
				pairedBefore[beforeIndex] = true;
			});
		}

		pairBy("id", function(item) { return String(item[idKey]); });
		pairBy("name", function(item) { return typeof item.name === "string" ? item.name : null; });

		return { pairOfAfter: pairOfAfter, pairedBefore: pairedBefore };
	}

	function diffItems(before, after, idKey, grouped) {
		var pairs = pairItems(before, after, idKey);
		var items = [];
		var nextBefore = 0;

		function itemEntry(kind, source, changes) {
			var entry = { kind: kind, id: source.item[idKey], name: labelOf(source.item, idKey) };
			if (grouped) entry.group = source.group;

			if (kind === "added" || kind === "removed") {
				entry.record = source.item;
			} else {
				entry.changes = changes;
			}

			return entry;
		}

		function flushRemoved(limit) {
			while (nextBefore < limit) {
				if (!pairs.pairedBefore[nextBefore]) items.push(itemEntry("removed", before[nextBefore]));
				nextBefore++;
			}
		}

		after.forEach(function(entry, index) {
			var beforeIndex = pairs.pairOfAfter[index];

			if (beforeIndex === -1) {
				items.push(itemEntry("added", entry));
				return;
			}

			flushRemoved(beforeIndex + 1);

			var beforeEntry = before[beforeIndex];
			var changes = diffRecord(beforeEntry.item, entry.item);
			var moved = grouped && beforeEntry.group !== entry.group;
			if (changes.length === 0 && !moved) return;

			var item = itemEntry(moved ? "moved" : "changed", entry, changes);
			if (moved) item.fromGroup = beforeEntry.group;
			items.push(item);
		});

		flushRemoved(before.length);
		return items;
	}

	function itemsChange(key, items, grouped) {
		if (items.length === 0) return null;
		return { key: key, kind: "changed", type: "items", grouped: grouped, items: items };
	}

	function diffValue(key, before, after) {
		if (deepEqual(before, after)) return null;

		if (isPlainObject(before) && isPlainObject(after)) {
			var beforeEntries = groupedEntries(before);
			var afterEntries = groupedEntries(after);
			var groupKey = beforeEntries && afterEntries ? identityKey(beforeEntries.concat(afterEntries).map(function(entry) { return entry.item; })) : null;

			if (groupKey) return itemsChange(key, diffItems(beforeEntries, afterEntries, groupKey, true), true);

			return { key: key, kind: "changed", type: "object", changes: diffRecord(before, after) };
		}

		if (Array.isArray(before) && Array.isArray(after)) {
			var listKey = identityKey(before.concat(after));
			if (listKey) return itemsChange(key, diffItems(listEntries(before, null), listEntries(after, null), listKey, false), false);
		}

		return valueChange(key, "changed", before, after);
	}

	// Changes between two records, in file order; an empty list when they are equal.
	function diffRecord(before, after) {
		if (!isPlainObject(before) || !isPlainObject(after)) {
			var change = diffValue(null, before, after);
			return change ? [change] : [];
		}

		var changes = [];

		orderedKeys(before, after).forEach(function(key) {
			var change;

			if (!has(before, key)) {
				change = valueChange(key, "added", undefined, after[key]);
			} else if (!has(after, key)) {
				change = valueChange(key, "removed", before[key], undefined);
			} else {
				change = diffValue(key, before[key], after[key]);
			}

			if (change) changes.push(change);
		});

		return changes;
	}

	function diffCollections(beforeMap, afterMap) {
		var before = beforeMap || {};
		var after = afterMap || {};
		var result = { added: [], removed: [], changed: [] };

		Object.keys(after).forEach(function(key) {
			if (!has(before, key)) {
				result.added.push({ kind: "added", key: key, name: labelOf(after[key]), record: after[key] });
				return;
			}

			var changes = diffRecord(before[key], after[key]);
			if (changes.length > 0) {
				result.changed.push({ kind: "changed", key: key, name: labelOf(after[key]), changes: changes });
			}
		});

		Object.keys(before).forEach(function(key) {
			if (!has(after, key)) {
				result.removed.push({ kind: "removed", key: key, name: labelOf(before[key]), record: before[key] });
			}
		});

		return result;
	}

	function isEmpty(collectionDiff) {
		return collectionDiff.added.length === 0 && collectionDiff.removed.length === 0 && collectionDiff.changed.length === 0;
	}

	return {
		diffCollections: diffCollections,
		diffRecord: diffRecord,
		diffWords: diffWords,
		isEmpty: isEmpty
	};
})();

if (typeof module !== "undefined") module.exports = PatchDiff;
