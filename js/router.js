// History API SPA router
var Router = (function() {
	var routes = [];
	var base = document.querySelector('base');
	var basePath = base ? base.getAttribute('href').replace(/\/$/, '') : '';

	function add(pattern, handler) {
		var regexStr = "^" + pattern.replace(/:([^/]+)/g, "([^/]+)") + "$";
		routes.push({
			pattern: new RegExp(regexStr),
			handler: handler
		});
	}

	function getPath() {
		var path = decodeURIComponent(window.location.pathname);
		if (basePath && path.indexOf(basePath) === 0) {
			path = path.substring(basePath.length);
		}
		// Normalize: strip trailing slash except for root
		if (path.length > 1 && path.charAt(path.length - 1) === "/") {
			path = path.substring(0, path.length - 1);
		}
		return path || "/";
	}

	function resolve() {
		var path = getPath();

		for (var i = 0; i < routes.length; i++) {
			var match = path.match(routes[i].pattern);
			if (match) {
				var params = match.slice(1);
				routes[i].handler.apply(null, params);
				updateActiveNav(path);
				window.scrollTo(0, 0);
				return;
			}
		}

		// No route matched, navigate to root
		navigate("/");
	}

	function updateActiveNav(path) {
		var links = document.querySelectorAll(".nav-link");
		for (var i = 0; i < links.length; i++) {
			links[i].classList.remove("active");
		}

		var section = "";
		if (path === "/") section = "overview";
		else if (path === "/players" || path.indexOf("/player/") === 0) section = "players";
		else if (path === "/heroes" || path.indexOf("/hero/") === 0) section = "heroes";
		else if (path === "/maps" || path.indexOf("/map/") === 0) section = "maps";
		else if (path.indexOf("/match") === 0) section = "matches";
		else if (path === "/hall-of-fame") section = "hall-of-fame";
		else if (path === "/draft") section = "draft";

		var active = document.querySelector('.nav-link[data-route="' + section + '"]');
		if (active) active.classList.add("active");
	}

	function navigate(path) {
		history.pushState(null, '', basePath + path);
		resolve();
	}

	function start() {
		// Redirect legacy hash URLs to clean paths
		if (window.location.hash && window.location.hash.indexOf("#/") === 0) {
			var hashPath = window.location.hash.substring(1);
			history.replaceState(null, '', basePath + hashPath);
		}

		window.addEventListener("popstate", resolve);

		// Intercept internal link clicks
		document.addEventListener("click", function(e) {
			if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

			var link = e.target.closest ? e.target.closest("a") : null;
			if (!link || !link.href) return;
			if (link.hasAttribute("target")) return;

			var raw = link.getAttribute("href");
			if (!raw) return;

			// Legacy hash links
			if (raw.charAt(0) === "#" && raw.charAt(1) === "/") {
				e.preventDefault();
				navigate(raw.substring(1));
				return;
			}

			// Skip hash-only, external protocols, mailto, etc.
			if (raw.charAt(0) === "#") return;
			if (/^[a-z]+:/i.test(raw)) return;

			// Internal path link: check if resolved URL is within our app
			var resolved = new URL(link.href);
			if (resolved.origin !== location.origin) return;

			var decoded = decodeURIComponent(resolved.pathname);
			if (decoded.indexOf(basePath) === 0) {
				e.preventDefault();
				var path = decoded.substring(basePath.length) || "/";
				navigate(path);
			}
		});

		resolve();
	}

	return {
		add: add,
		start: start,
		navigate: navigate,
		basePath: basePath
	};
})();
