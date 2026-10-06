/*\
title: $:/plugins/breakzplatform/mastodon-comments/lib/thread.js
type: application/javascript
module-type: library

Parse links to Mastodon posts, sanitize status HTML, and turn a context
response into a reply tree ready to display

No network access here, and the sanitizer can run without a browser DOM, so
the tests can run it under plain Node

\*/
(function () {

	/*jslint node: true, browser: true */
	"use strict";

	var WEB_LINK_PATTERN = /^https?:\/\/([^\/?#]+)\/(.+?)(?:[?#].*)?$/i;
	var ALLOWED_TAGS = {
		p: true,
		br: true,
		a: true,
		span: true,
		strong: true,
		em: true,
		b: true,
		i: true,
		code: true,
		pre: true,
		blockquote: true,
		ul: true,
		ol: true,
		li: true
	};
	var VOID_TAGS = { br: true, img: true, hr: true, meta: true, link: true, input: true };
	var TEXT_ONLY_TAGS = { script: true, style: true, iframe: true, object: true, embed: true };

	function text(content) {
		return { type: "text", text: content };
	}

	function element(tag, children, attributes) {
		var node = { type: "element", tag: tag, attributes: {}, children: children || [] };
		Object.keys(attributes || {}).forEach(function (name) {
			node.attributes[name] = { type: "string", value: String(attributes[name]) };
		});
		return node;
	}

	exports.isWebUrl = function (url) {
		return /^https?:\/\/[^\s]+$/i.test(url || "");
	};

	function safeDecode(textValue) {
		try {
			return decodeURIComponent(textValue);
		} catch (error) {
			return null;
		}
	}

	function hostIsValid(host) {
		return !!host && host.indexOf("@") === -1 && host.indexOf("\\") === -1 && host.indexOf(":") === -1;
	}

	/*
	Returns {instance, id, url} or null when the link is not a Mastodon status.
	Accepted layouts:
	- https://instance/@user/ID
	- https://instance/@user@other.domain/ID
	- https://instance/users/user/statuses/ID
	*/
	exports.parsePostLink = function (link) {
		var textValue = (link || "").trim();
		var match = WEB_LINK_PATTERN.exec(textValue);
		var idMatch, instance, path;
		if (!match) return null;
		instance = (match[1] || "").toLowerCase();
		path = safeDecode(match[2] || "");
		if (!hostIsValid(instance) || !path) return null;
		if ((idMatch = /^@[^\/?#]+\/([0-9]+)\/?$/.exec(path)) ||
				(idMatch = /^users\/[^\/?#]+\/statuses\/([0-9]+)\/?$/.exec(path))) {
			return { instance: instance, id: idMatch[1], url: textValue.replace(/[?#].*$/, "") };
		}
		return null;
	};

	function arrayOrEmpty(value) {
		return Array.isArray(value) ? value : [];
	}

	function isPublic(status) {
		return status && (status.visibility === "public" || status.visibility === "unlisted");
	}

	function timestamp(status) {
		var date = Date.parse(status && status.created_at);
		return typeof date === "number" && !isNaN(date) ? date : Infinity;
	}

	var COMPARATORS = {
		oldest: function (a, b) {
			return timestamp(a.status) - timestamp(b.status);
		},
		newest: function (a, b) {
			return timestamp(b.status) - timestamp(a.status);
		},
		favourites: function (a, b) {
			var favA = (a.status && a.status.favourites_count) || 0;
			var favB = (b.status && b.status.favourites_count) || 0;
			return favB - favA || timestamp(a.status) - timestamp(b.status);
		}
	};

	function sortNodes(nodes, order) {
		var comparator = COMPARATORS[order] || COMPARATORS.oldest;
		return nodes.map(function (node, position) {
			return { node: node, position: position };
		}).sort(function (a, b) {
			var result = comparator(a.node, b.node);
			return (result === result && result !== 0) ? result : a.position - b.position;
		}).map(function (entry) {
			return entry.node;
		});
	}

	function countVisible(statuses, parentId) {
		var count = 0;
		statuses.forEach(function (status) {
			if (!status || String(status.in_reply_to_id) !== String(parentId)) return;
			if (isPublic(status)) count += 1;
			count += countVisible(statuses, status.id);
		});
		return count;
	}

	function buildChildren(statuses, parentId, depth, options) {
		var nodes = [];
		statuses.forEach(function (status) {
			if (!status || String(status.in_reply_to_id) !== String(parentId)) return;
			if (!isPublic(status)) {
				options.omitted += 1 + countVisible(statuses, status.id);
				return;
			}
			if (depth > options.maxDepth) {
				options.omitted += 1 + countVisible(statuses, status.id);
				return;
			}
			nodes.push({
				status: status,
				replies: buildChildren(statuses, status.id, depth + 1, options)
			});
		});
		return sortNodes(nodes, depth === 1 ? options.sort : "oldest");
	}

	/*
	Returns {kind, status, replies, omitted}. Only public and unlisted statuses
	are displayed. Direct replies follow options.sort ("oldest", "newest" or
	"favourites"); nested replies are chronological.
	*/
	exports.buildThread = function (rootStatus, context, options) {
		var settings;
		options = options || {};
		if (!rootStatus || !rootStatus.id) return { kind: "not-found", replies: [], omitted: 0 };
		if (!isPublic(rootStatus)) return { kind: "hidden", status: rootStatus, replies: [], omitted: 0 };
		settings = {
			maxDepth: Math.max(1, Math.min(options.maxDepth || 6, 20)),
			sort: options.sort || "oldest",
			omitted: 0
		};
		var replies = buildChildren(arrayOrEmpty(context && context.descendants), rootStatus.id, 1, settings);
		return {
			kind: "visible",
			status: rootStatus,
			replies: replies,
			omitted: settings.omitted
		};
	};

	function attrsToObject(raw) {
		var attrs = {};
		(raw || "").replace(/([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g, function (_, name, doubleQuoted, singleQuoted, bare) {
			attrs[name.toLowerCase()] = doubleQuoted !== undefined ? doubleQuoted : (singleQuoted !== undefined ? singleQuoted : (bare || ""));
		});
		return attrs;
	}

	function fallbackParse(html) {
		var root = { nodeType: 1, nodeName: "root", attributes: {}, childNodes: [] };
		var stack = [root];
		String(html || "").replace(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+|</g, function (token) {
			var parent = stack[stack.length - 1];
			var closeMatch = /^<\/\s*([a-zA-Z0-9:-]+)/.exec(token);
			var openMatch = /^<\s*([a-zA-Z0-9:-]+)([^>]*)>/.exec(token);
			if (closeMatch) {
				var closeName = closeMatch[1].toLowerCase();
				while (stack.length > 1) {
					var node = stack.pop();
					if (node.nodeName === closeName) break;
				}
			} else if (openMatch) {
				var name = openMatch[1].toLowerCase();
				var rawAttrs = openMatch[2] || "";
				var node = { nodeType: 1, nodeName: name, attributes: attrsToObject(rawAttrs), childNodes: [] };
				parent.childNodes.push(node);
				if (!VOID_TAGS[name] && !/\/\s*>$/.test(token)) stack.push(node);
			} else {
				parent.childNodes.push({ nodeType: 3, nodeValue: token });
			}
		});
		return root;
	}

	function attribute(node, name) {
		if (!node) return "";
		if (node.getAttribute) return node.getAttribute(name) || "";
		return (node.attributes && node.attributes[name]) || "";
	}

	function childNodes(node) {
		return Array.prototype.slice.call((node && (node.childNodes || node.children)) || []);
	}

	function nodeName(node) {
		return String(node && (node.nodeName || node.tagName) || "").toLowerCase();
	}

	function textContent(node) {
		if (!node) return "";
		if (node.nodeType === 3) return node.nodeValue || "";
		return childNodes(node).map(textContent).join("");
	}

	function customEmoji(shortcode, url) {
		return element("img", [], {
			"class": "mastodon-custom-emoji",
			src: url,
			alt: ":" + shortcode + ":",
			loading: "lazy"
		});
	}

	exports.replaceCustomEmojis = function (content, emojis) {
		var byShortcode = {};
		arrayOrEmpty(emojis).forEach(function (emoji) {
			if (emoji && emoji.shortcode && exports.isWebUrl(emoji.url)) byShortcode[emoji.shortcode] = emoji.url;
		});
		if (!Object.keys(byShortcode).length) return content ? [text(content)] : [];
		var parts = [];
		String(content || "").split(/(:[a-zA-Z0-9_+-]+:)/g).forEach(function (part) {
			var shortcode = /^:([a-zA-Z0-9_+-]+):$/.exec(part);
			if (shortcode && byShortcode[shortcode[1]]) {
				parts.push(customEmoji(shortcode[1], byShortcode[shortcode[1]]));
			} else if (part) {
				parts.push(text(part));
			}
		});
		return parts;
	};

	function sanitizeNode(node, emojis) {
		var children, className, href, tag;
		if (node.nodeType === 3) return exports.replaceCustomEmojis(node.nodeValue || "", emojis);
		tag = nodeName(node);
		if (TEXT_ONLY_TAGS[tag]) return [text(textContent(node))];
		className = attribute(node, "class");
		if (tag === "span" && /\binvisible\b/.test(className)) return [];
		children = [];
		childNodes(node).forEach(function (child) {
			children = children.concat(sanitizeNode(child, emojis));
		});
		if (tag === "span" && /\bellipsis\b/.test(className)) children.push(text("…"));
		if (!ALLOWED_TAGS[tag]) return children.length ? children : (textContent(node) ? [text(textContent(node))] : []);
		if (tag === "a") {
			href = attribute(node, "href");
			if (!exports.isWebUrl(href)) return children;
			return [element("a", children, {
				href: href,
				target: "_blank",
				rel: "noopener noreferrer nofollow ugc"
			})];
		}
		return [element(tag, children)];
	}

	exports.sanitizeHtml = function (html, emojis, domParser) {
		var children = [], root;
		if (domParser && domParser.parseFromString) {
			root = domParser.parseFromString(String(html || ""), "text/html").body;
		} else {
			root = fallbackParse(html);
		}
		childNodes(root).forEach(function (child) {
			children = children.concat(sanitizeNode(child, emojis));
		});
		return children;
	};

})();
