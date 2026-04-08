// Searchable dropdown replacement for native <select> elements.
// Renders a text input that filters a dropdown list as the user types.
var SearchSelect = (function() {
	var _cache = {};

	// Returns HTML string for a searchable select.
	// config: { id, value, placeholder, items, className?, disabled? }
	// items: [{ value, text, suffix?, disabled?, separator? }]
	//   value: internal value string
	//   text: display text (used in input when selected, and for search matching)
	//   suffix: optional text shown after the main text in the dropdown (e.g. game counts)
	//   disabled: option cannot be selected
	//   separator: visual divider (no value/text needed)
	function renderHtml(config) {
		var items = config.items || [];
		_cache[config.id] = items;

		var value = config.value || '';
		var displayText = '';
		if (value) {
			for (var i = 0; i < items.length; i++) {
				if (!items[i].separator && items[i].value === value) {
					displayText = items[i].text;
					break;
				}
			}
		}

		var cls = 'search-select';
		if (config.className) cls += ' ' + config.className;
		if (config.disabled) cls += ' disabled';

		return '<div class="' + cls + '" id="' + config.id + '"' +
			' data-value="' + escapeHtml(value) + '">' +
			'<input type="text" class="search-select-input"' +
			' placeholder="' + escapeHtml(config.placeholder || 'Search...') + '"' +
			' value="' + escapeHtml(displayText) + '"' +
			' autocomplete="off"' +
			(config.disabled ? ' disabled' : '') + '>' +
			'</div>';
	}

	// Attach behavior to a rendered search select.
	// onSelect: optional callback(value) when user picks an option
	function attach(id, onSelect) {
		var container = document.getElementById(id);
		if (!container) return;

		var input = container.querySelector('.search-select-input');
		if (!input || input.disabled) return;

		var items = _cache[id] || [];
		var currentValue = container.getAttribute('data-value') || '';
		var dropdown = null;
		var highlighted = -1;
		var visibleItems = [];
		var isOpen = false;
		var closeHandler = null;

		function filterItems(query) {
			if (!query) return items.slice();
			var q = query.toLowerCase();
			var result = [];
			for (var i = 0; i < items.length; i++) {
				if (items[i].separator) continue;
				if (items[i].text.toLowerCase().indexOf(q) !== -1) {
					result.push(items[i]);
				}
			}
			return result;
		}

		function renderOptions(filteredItems) {
			visibleItems = filteredItems;
			highlighted = -1;

			if (!dropdown) {
				dropdown = document.createElement('div');
				dropdown.className = 'search-select-dropdown';
				container.appendChild(dropdown);
			}

			var html = '';
			for (var i = 0; i < filteredItems.length; i++) {
				var item = filteredItems[i];
				if (item.separator) {
					html += '<div class="search-select-separator"></div>';
					continue;
				}
				var cls = 'search-select-option';
				if (item.disabled) cls += ' disabled';
				if (item.value && item.value === currentValue) cls += ' selected';
				var label = escapeHtml(item.text);
				if (item.suffix) label += ' <span class="search-select-suffix">' + escapeHtml(item.suffix) + '</span>';
				html += '<div class="' + cls + '" data-index="' + i + '" data-value="' + escapeHtml(item.value) + '">' +
					label + '</div>';
			}

			if (filteredItems.length === 0) {
				html = '<div class="search-select-empty">No matches</div>';
			}

			dropdown.innerHTML = html;
		}

		function open() {
			if (isOpen) return;
			isOpen = true;

			var query = input.value;
			if (currentValue) {
				for (var i = 0; i < items.length; i++) {
					if (!items[i].separator && items[i].value === currentValue && items[i].text === query) {
						query = '';
						break;
					}
				}
			}
			renderOptions(filterItems(query));
			container.classList.add('open');

			closeHandler = function(e) {
				if (!container.contains(e.target)) {
					close();
				}
			};
			document.addEventListener('mousedown', closeHandler);
		}

		function close() {
			if (!isOpen) return;
			isOpen = false;

			if (dropdown) {
				dropdown.remove();
				dropdown = null;
			}
			container.classList.remove('open');

			if (closeHandler) {
				document.removeEventListener('mousedown', closeHandler);
				closeHandler = null;
			}

			var displayText = '';
			if (currentValue) {
				for (var i = 0; i < items.length; i++) {
					if (!items[i].separator && items[i].value === currentValue) {
						displayText = items[i].text;
						break;
					}
				}
			}
			input.value = displayText;
		}

		function selectItem(value) {
			currentValue = value;
			container.setAttribute('data-value', value);

			var displayText = '';
			if (value) {
				for (var i = 0; i < items.length; i++) {
					if (!items[i].separator && items[i].value === value) {
						displayText = items[i].text;
						break;
					}
				}
			}
			input.value = displayText;
			close();
			input.blur();
			if (onSelect) onSelect(value);
		}

		function highlightIndex(idx) {
			if (!dropdown || visibleItems.length === 0) return;
			var dir = idx > highlighted ? 1 : -1;
			while (idx >= 0 && idx < visibleItems.length &&
				(visibleItems[idx].disabled || visibleItems[idx].separator)) {
				idx += dir;
			}
			if (idx < 0 || idx >= visibleItems.length) return;

			var prev = dropdown.querySelector('.highlighted');
			if (prev) prev.classList.remove('highlighted');

			highlighted = idx;
			var target = dropdown.querySelector('[data-index="' + idx + '"]');
			if (target) {
				target.classList.add('highlighted');
				target.scrollIntoView({ block: 'nearest' });
			}
		}

		input.addEventListener('focus', function() {
			this.select();
			open();
		});

		input.addEventListener('input', function() {
			if (!isOpen) open();
			renderOptions(filterItems(this.value));
		});

		input.addEventListener('keydown', function(e) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				if (!isOpen) {
					open();
					return;
				}
				highlightIndex(e.key === 'ArrowDown' ? highlighted + 1 : highlighted - 1);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				if (isOpen && highlighted >= 0 && highlighted < visibleItems.length && !visibleItems[highlighted].disabled) {
					selectItem(visibleItems[highlighted].value);
				}
			} else if (e.key === 'Escape') {
				if (isOpen) {
					e.preventDefault();
					close();
					input.blur();
				}
			}
		});

		container.addEventListener('mousedown', function(e) {
			var option = e.target.closest('.search-select-option');
			if (option && !option.classList.contains('disabled')) {
				e.preventDefault();
				selectItem(option.getAttribute('data-value'));
			}
		});
	}

	function getValue(id) {
		var el = document.getElementById(id);
		return el ? el.getAttribute('data-value') || '' : '';
	}

	return {
		renderHtml: renderHtml,
		attach: attach,
		getValue: getValue
	};
})();
