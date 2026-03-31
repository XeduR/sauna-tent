// Unified table builder for all standard stat tables.
// Wraps sortableTable() from app.js and adds visual filter toggles.

var StandardTable = (function() {
	// Format function registry (centralizes duplicated fmtWr, fmtNum, etc.)
	var FORMAT = {
		num: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : v.toLocaleString();
		},
		dec: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : v.toFixed(1);
		},
		wr: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : winrateSpan(v);
		},
		pct: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : (v * 100).toFixed(1) + "%";
		},
		partyWr: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : winrateSpan(v);
		},
		kda: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : v.toFixed(2);
		},
		dmg: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : formatNumber(Math.round(v));
		},
		dur: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : formatDuration(v);
		},
		date: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : formatDateFinnish(v);
		},
		text: function(v) {
			return v == null ? '<span class="text-muted">-</span>' : escapeHtml(String(v));
		},
		heroLink: function(v) {
			return '<a href="' + appLink('/hero/' + slugify(v)) + '">' + escapeHtml(v) + '</a>';
		},
		mapLink: function(v) {
			return '<a href="' + appLink('/map/' + slugify(v)) + '">' + escapeHtml(displayMapName(v)) + '</a>';
		},
		playerLink: function(v) {
			return '<a href="' + appLink('/player/' + slugify(v)) + '">' + escapeHtml(v) + '</a>';
		}
	};

	function resolveFormat(key) {
		return FORMAT[key] || FORMAT.text;
	}

	// Check if a segment bit is set in a mask
	function isVisible(mask, bit) {
		return (mask >>> bit) & 1;
	}

	// Build columns and header groups from layout + current mask + party context.
	// partyContext: { showAll: bool, filterLabel: string|null }
	//   showAll = true: show Avg + all party sub-columns
	//   filterLabel: show only matching party column (replaces Avg label)
	//   neither: show Avg only
	function buildColumnsAndGroups(layout, mask, partyContext) {
		var identity = TableConfig.IDENTITY[layout.identity];
		var columns = [];
		var headerGroups = [];

		// Identity columns (always visible)
		for (var i = 0; i < identity.columns.length; i++) {
			var ic = identity.columns[i];
			columns.push({
				key: ic.key,
				label: ic.label,
				format: resolveFormat(ic.format),
				className: ic.className || ""
			});
		}
		headerGroups.push({ label: identity.topLabel, span: identity.columns.length });

		// Data segments
		var segments = TableConfig.SEGMENTS;
		for (var s = 0; s < segments.length; s++) {
			var seg = segments[s];
			if (!isVisible(mask, seg.bit)) continue;

			var segCols = [];

			if (seg.id === "winrate" && layout.hasPartyData && partyContext) {
				// Win rate segment with party data handling
				if (partyContext.filterLabel) {
					// Single party filter active: show one column with party label
					segCols.push({
						key: "winrate",
						label: partyContext.filterLabel,
						format: resolveFormat("wr"),
						className: "num"
					});
				} else {
					// Avg column always present
					segCols.push({
						key: "winrate",
						label: "Avg",
						format: resolveFormat("wr"),
						className: "num"
					});
					if (partyContext.showAll && seg.partyColumns) {
						for (var p = 0; p < seg.partyColumns.length; p++) {
							var pc = seg.partyColumns[p];
							segCols.push({
								key: pc.key,
								label: pc.label,
								format: resolveFormat(pc.format),
								className: pc.className || ""
							});
						}
					}
				}
			} else {
				// Standard columns
				for (var c = 0; c < seg.columns.length; c++) {
					var col = seg.columns[c];
					segCols.push({
						key: col.key,
						label: col.label,
						format: resolveFormat(col.format),
						className: col.className || ""
					});
				}
			}

			for (var c = 0; c < segCols.length; c++) {
				columns.push(segCols[c]);
			}
			headerGroups.push({ label: seg.label, span: segCols.length });
		}

		return { columns: columns, headerGroups: headerGroups };
	}

	// Build toggle bar HTML
	function buildToggles(mask, layoutKey, defaultMask) {
		var segments = TableConfig.SEGMENTS;
		var html = '<div class="vf-toggle-bar" data-layout="' + layoutKey + '">';
		for (var i = 0; i < segments.length; i++) {
			var seg = segments[i];
			var active = isVisible(mask, seg.bit);
			html += '<button class="vf-toggle' + (active ? ' vf-active' : '') +
				'" data-bit="' + seg.bit + '">' + escapeHtml(seg.label) + '</button>';
		}
		if (mask !== defaultMask) {
			html += '<button class="vf-reset">Reset columns</button>';
		}
		html += '</div>';
		return html;
	}

	// Main entry point.
	// layoutKey: string matching TableConfig.LAYOUTS
	// rows: data array
	// options: { mask, partyContext, onMaskChange }
	function standardTable(layoutKey, rows, options) {
		options = options || {};
		var layout = TableConfig.LAYOUTS[layoutKey];
		var mask = options.mask != null ? options.mask : layout.defaultMask;
		var partyContext = options.partyContext || null;

		var built = buildColumnsAndGroups(layout, mask, partyContext);

		// Check if current sort key is still visible
		var sortKey = layout.defaultSortKey;
		var sortKeyValid = false;
		for (var i = 0; i < built.columns.length; i++) {
			if (built.columns[i].key === sortKey) {
				sortKeyValid = true;
				break;
			}
		}
		if (!sortKeyValid) sortKey = built.columns[0].key;

		var table = sortableTable(
			layout.tableId,
			built.columns,
			rows,
			sortKey,
			true,
			built.headerGroups
		);

		return {
			buildHTML: table.buildHTML,
			buildToggles: function() {
				return buildToggles(mask, layoutKey, layout.defaultMask);
			},
			attachListeners: function(container, onMaskChange) {
				table.attachListeners(container);

				if (!onMaskChange) return;

				var toggleBar = container.querySelector('.vf-toggle-bar[data-layout="' + layoutKey + '"]');
				if (!toggleBar) return;

				var buttons = toggleBar.querySelectorAll('.vf-toggle');
				for (var i = 0; i < buttons.length; i++) {
					buttons[i].addEventListener('click', function() {
						var bit = Number(this.getAttribute('data-bit'));
						var newMask = mask ^ (1 << bit);
						if (newMask === 0) return;
						var scrollY = window.scrollY;
						onMaskChange(newMask);
						window.scrollTo(0, scrollY);
					});
				}

				var resetBtn = toggleBar.querySelector('.vf-reset');
				if (resetBtn) {
					resetBtn.addEventListener('click', function() {
						var scrollY = window.scrollY;
						onMaskChange(layout.defaultMask);
						window.scrollTo(0, scrollY);
					});
				}
			}
		};
	}

	// Read vf param from URL, returning null if absent
	function readMaskFromURL() {
		var params = new URLSearchParams(window.location.search);
		if (params.has("vf")) {
			var val = parseInt(params.get("vf"), 10);
			return isNaN(val) ? null : val;
		}
		return null;
	}

	// Write vf param to URL (removes if equal to default)
	function writeMaskToURL(mask, defaultMask) {
		var params = new URLSearchParams(window.location.search);
		if (mask === defaultMask) {
			params.delete("vf");
		} else {
			params.set("vf", String(mask));
		}
		var qs = params.toString();
		history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
	}

	return {
		create: standardTable,
		FORMAT: FORMAT,
		readMaskFromURL: readMaskFromURL,
		writeMaskToURL: writeMaskToURL
	};
})();
