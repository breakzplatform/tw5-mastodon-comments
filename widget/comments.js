/*\
title: $:/plugins/breakzplatform/mastodon-comments/widget/comments.js
type: application/javascript
module-type: widget

Display the replies to a Mastodon post as comments on a tiddler

\*/
(function () {

	/*jslint node: true, browser: true */
	/*global $tw: false, DOMParser: false */
	"use strict";

	var Widget = require("$:/core/modules/widgets/widget.js").widget;
	var thread = require("$:/plugins/breakzplatform/mastodon-comments/lib/thread.js");

	var PLUGIN_PREFIX = "$:/plugins/breakzplatform/mastodon-comments/";
	var CONFIG_PREFIX = "$:/config/breakzplatform/mastodon-comments/";
	var LANGUAGE_TIDDLER = PLUGIN_PREFIX + "language";
	var POST_FIELD = "mastodon-post";
	var RETRY_MESSAGE = "tm-mastodon-comments-retry";
	var DEFAULT_DEPTH = 6;
	var MAX_DEPTH = 20;
	var CACHE_LIFETIME = 5 * 60 * 1000;
	var REQUEST_TIMEOUT = 20 * 1000;

	var threadCache = {};

	var MastodonCommentsWidget = function (parseTreeNode, options) {
		this.initialise(parseTreeNode, options);
		var self = this;
		this.addEventListener(RETRY_MESSAGE, function () {
			delete threadCache[self.cacheKey];
			self.refreshSelf();
			return false;
		});
	};

	MastodonCommentsWidget.prototype = new Widget();

	MastodonCommentsWidget.prototype.render = function (parent, nextSibling) {
		this.parentDomNode = parent;
		this.computeAttributes();
		this.execute();

		this.wrapper = this.document.createElement("div");
		this.wrapper.className = "mastodon-comments";
		this.wrapper.setAttribute("data-tiddler-title", this.tiddlerTitle);
		parent.insertBefore(this.wrapper, nextSibling);
		this.domNodes.push(this.wrapper);
		this.renderContent();

		if (!$tw.browser || !this.postRef) return;
		var entry = threadCache[this.cacheKey];
		if (!entry || entry.loading || entry.expires < Date.now()) this.load();
	};

	MastodonCommentsWidget.prototype.execute = function () {
		this.tiddlerTitle = this.getAttribute("tiddler", this.getVariable("currentTiddler"));
		this.postLink = this.getAttribute("post", this.getPostField()).trim();
		this.postRef = thread.parsePostLink(this.postLink);
		var depth = parseInt(this.getConfig("depth", ""), 10);
		this.maxDepth = isNaN(depth) ? DEFAULT_DEPTH : Math.min(Math.max(depth, 1), MAX_DEPTH);
		this.sort = this.getConfig("sort", "oldest");
		this.showCounts = this.getConfig("counts", "yes") !== "no";
		this.collapseCw = this.getConfig("collapse-cw", "yes") !== "no";
		this.cacheKey = this.postRef ? [this.postRef.instance, this.postRef.id].join(" ") : this.postLink;
	};

	MastodonCommentsWidget.prototype.getPostField = function () {
		var tiddler = this.wiki.getTiddler(this.tiddlerTitle);
		return (tiddler && tiddler.fields[POST_FIELD]) || "";
	};

	MastodonCommentsWidget.prototype.getConfig = function (name, fallback) {
		var text = this.wiki.getTiddlerText(CONFIG_PREFIX + name);
		text = (text || "").trim();
		return text || fallback;
	};

	MastodonCommentsWidget.prototype.getText = function (key) {
		return this.wiki.extractTiddlerDataItem(LANGUAGE_TIDDLER, key, key);
	};

	MastodonCommentsWidget.prototype.renderContent = function () {
		if (this.destroyChildren) this.destroyChildren({ removeDOMNodes: false });
		while (this.wrapper.firstChild) {
			this.wrapper.removeChild(this.wrapper.firstChild);
		}
		this.makeChildWidgets(this.buildContent());
		this.renderChildren(this.wrapper, null);
	};

	MastodonCommentsWidget.prototype.isAttached = function () {
		return this.document.documentElement.contains(this.wrapper);
	};

	MastodonCommentsWidget.prototype.request = function (url, callback) {
		var finished = false;
		var xhr = $tw.utils.httpRequest({
			url: url,
			callback: function (error, text, request) {
				var body = null;
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				try {
					body = JSON.parse(text);
				} catch (parseError) {
				}
				if (!error && body) {
					callback(null, body, request);
					return;
				}
				callback({ status: request ? request.status : 0 }, null, request);
			}
		});
		var timer = setTimeout(function () {
			if (finished) return;
			finished = true;
			if (xhr && xhr.abort) xhr.abort();
			callback({ status: 0, timeout: true });
		}, REQUEST_TIMEOUT);
	};

	MastodonCommentsWidget.prototype.statusUrl = function (suffix) {
		return "https://" + this.postRef.instance + "/api/v1/statuses/" + this.postRef.id + (suffix || "");
	};

	MastodonCommentsWidget.prototype.load = function () {
		var self = this;
		var key = this.cacheKey;
		var entry = threadCache[key];
		if (entry && entry.loading) {
			entry.waiting.push(function () {
				self.onLoaded();
			});
			return;
		}
		pruneExpired(threadCache);
		entry = threadCache[key] = { loading: true, waiting: [], expires: Infinity };
		var finish = function (result) {
			threadCache[key] = { result: result, expires: Date.now() + (result.error === "rate-limit" ? 0 : CACHE_LIFETIME) };
			self.onLoaded();
			entry.waiting.forEach(function (notify) {
				notify();
			});
		};
		this.request(this.statusUrl(""), function (error, root) {
			if (error) return finish({ error: self.describeError(error) });
			self.loadContext(root, false, finish);
		});
	};

	MastodonCommentsWidget.prototype.loadContext = function (root, retried, finish) {
		var self = this;
		this.request(this.statusUrl("/context"), function (error, context, request) {
			var refresh = request && request.getResponseHeader && request.getResponseHeader("Mastodon-Async-Refresh");
			if (!error && refresh && !retried) {
				setTimeout(function () {
					self.loadContext(root, true, finish);
				}, thread.asyncRefreshDelay(refresh));
				return;
			}
			finish(error ? { error: self.describeError(error) } : { root: root, context: context });
		});
	};

	MastodonCommentsWidget.prototype.describeError = function (error) {
		if (error.status === 429) return "rate-limit";
		if (error.status === 404) return "not-found";
		if (error.status === 401 || error.status === 403) return "login-required";
		if (error.status === 0 && error.timeout) return "timeout";
		if (error.status === 0) return "network";
		return "unavailable";
	};

	MastodonCommentsWidget.prototype.onLoaded = function () {
		if (this.isAttached()) this.renderContent();
	};

	function element(tag, className, children, attributes) {
		var node = { type: "element", tag: tag, attributes: {}, children: children || [] };
		if (className) node.attributes["class"] = { type: "string", value: className };
		$tw.utils.each(attributes || {}, function (value, name) {
			node.attributes[name] = { type: "string", value: String(value) };
		});
		return node;
	}

	function text(content) {
		return { type: "text", text: content };
	}

	function pruneExpired(cache) {
		var now = Date.now();
		Object.keys(cache).forEach(function (key) {
			if (cache[key].expires < now) delete cache[key];
		});
	}

	function externalLink(href, className, children, title) {
		var attributes = { href: href, target: "_blank", rel: "noopener noreferrer nofollow ugc" };
		if (title) attributes.title = title;
		return element("a", className, children, attributes);
	}

	MastodonCommentsWidget.prototype.format = function (key, values) {
		var result = this.getText(key);
		$tw.utils.each(values, function (value, name) {
			result = result.split("$" + name + "$").join(String(value));
		});
		return result;
	};

	MastodonCommentsWidget.prototype.countText = function (count, singularKey, pluralKey) {
		return this.format(count === 1 ? singularKey : pluralKey, { count: count });
	};

	MastodonCommentsWidget.prototype.rootUrl = function (root) {
		return (root && thread.isWebUrl(root.url) && root.url) || (this.postRef && this.postRef.url) || this.postLink;
	};

	MastodonCommentsWidget.prototype.message = function (key, extraClass, children) {
		return element("p", "mastodon-comments-message" + (extraClass ? " " + extraClass : ""), [text(this.getText(key))].concat(children || []));
	};

	MastodonCommentsWidget.prototype.buildContent = function () {
		if (!this.postRef) {
			return [this.message(this.postLink ? "Error/InvalidLink" : "Error/MissingLink", "mastodon-comments-warning")];
		}
		var replyLink = externalLink(this.rootUrl(), "mastodon-comments-reply-link", [text(this.getText("ReplyOnMastodon"))]);
		if (!$tw.browser) return [element("p", "mastodon-comments-message", [replyLink])];

		var entry = threadCache[this.cacheKey];
		if (!entry || entry.loading) return [this.message("Loading", "mastodon-comments-loading")];
		if (entry.result.error) return this.buildError(entry.result.error);

		var root = thread.buildThread(entry.result.root, entry.result.context, {
			maxDepth: this.maxDepth,
			sort: this.sort
		});
		replyLink = externalLink(this.rootUrl(root.status), "mastodon-comments-reply-link", [text(this.getText("ReplyOnMastodon"))]);
		if (root.kind === "not-found") return [this.message("Error/NotFound", "mastodon-comments-warning")];
		if (root.kind === "hidden") return [this.message("Error/RootHidden", "mastodon-comments-warning", [text(" "), replyLink])];

		var content = [this.buildHeader(root.status, replyLink)];
		if (root.replies.length) {
			content.push(element("div", "mastodon-comments-list", root.replies.map(this.buildNode, this)));
		} else if (!root.omitted) {
			content.push(this.message("NoReplies"));
		}
		if (root.omitted) {
			content.push(element("p", "mastodon-comments-message mastodon-comments-omitted", [
				externalLink(this.rootUrl(root.status), "", [text(this.countText(root.omitted, "Omitted/One", "Omitted/Many"))])
			]));
		}
		return content;
	};

	MastodonCommentsWidget.prototype.buildError = function (error) {
		var key = {
			"rate-limit": "Error/RateLimit",
			"not-found": "Error/NotFound",
			"login-required": "Error/LoginRequired",
			"network": "Error/Network",
			"timeout": "Error/Timeout"
		}[error] || "Error/Unavailable";
		var content = [this.message(key, "mastodon-comments-warning")];
		if (error === "login-required") {
			content[0].children.push(text(" "), externalLink(this.rootUrl(), "", [text(this.getText("OpenPost"))]));
		}
		if (error !== "not-found") {
			content.push({
				type: "button",
				attributes: {
					message: { type: "string", value: RETRY_MESSAGE },
					"class": { type: "string", value: "mastodon-comments-retry" }
				},
				children: [text(this.getText("Retry"))]
			});
		}
		return content;
	};

	MastodonCommentsWidget.prototype.buildHeader = function (status, replyLink) {
		var children = [];
		if (this.showCounts) {
			children.push(element("span", "mastodon-comments-counts", [text([
				this.countText(status.replies_count || 0, "Count/Reply", "Count/Replies"),
				this.countText(status.reblogs_count || 0, "Count/Boost", "Count/Boosts"),
				this.countText(status.favourites_count || 0, "Count/Favourite", "Count/Favourites")
			].join(" · "))]));
		}
		children.push(replyLink);
		return element("div", "mastodon-comments-header", children);
	};

	MastodonCommentsWidget.prototype.buildNode = function (node) {
		var body = this.buildStatus(node.status);
		if (node.replies.length) {
			body.push(element("div", "mastodon-comment-replies", node.replies.map(this.buildNode, this)));
		}
		return element("div", "mastodon-comment", body);
	};

	MastodonCommentsWidget.prototype.buildStatus = function (status) {
		var account = status.account || {};
		var profile = thread.isWebUrl(account.url) ? account.url : this.rootUrl(status);
		var meta = [];
		if (thread.isWebUrl(account.avatar)) {
			var avatarLink = externalLink(profile, "mastodon-comment-avatar-link", [
				element("img", "mastodon-comment-avatar", [], { src: account.avatar, alt: "", loading: "lazy" })
			]);
			avatarLink.attributes["aria-hidden"] = { type: "string", value: "true" };
			avatarLink.attributes.tabindex = { type: "string", value: "-1" };
			meta.push(avatarLink);
		}
		meta.push(externalLink(profile, "mastodon-comment-author", [
			element("span", "mastodon-comment-name", thread.replaceCustomEmojis(account.display_name || account.acct || "", account.emojis)),
			text(" "),
			element("span", "mastodon-comment-handle", [text("@" + (account.acct || ""))])
		]));
		var created = new Date(typeof status.created_at === "string" ? status.created_at : NaN);
		if (!isNaN(created.getTime()) && thread.isWebUrl(status.url)) {
			meta.push(externalLink(status.url, "mastodon-comment-date", [
				element("time", "", [text($tw.utils.formatDateString(created, this.getText("DateFormat")))], {
					datetime: created.toISOString()
				})
			], created.toISOString()));
		}
		var content = [element("div", "mastodon-comment-meta", meta)];
		content.push(this.buildStatusContent(status));
		var media = this.buildMedia(status);
		if (media) content.push(media);
		var card = this.buildCard(status);
		if (card) content.push(card);
		var counts = [];
		if (status.replies_count) counts.push(this.countText(status.replies_count, "Count/Reply", "Count/Replies"));
		if (status.reblogs_count) counts.push(this.countText(status.reblogs_count, "Count/Boost", "Count/Boosts"));
		if (status.favourites_count) counts.push(this.countText(status.favourites_count, "Count/Favourite", "Count/Favourites"));
		if (this.showCounts && counts.length) {
			content.push(element("div", "mastodon-comment-counts", [text(counts.join(" · "))]));
		}
		return content;
	};

	MastodonCommentsWidget.prototype.buildStatusContent = function (status) {
		var body = element("div", "mastodon-comment-text", this.sanitizeStatusContent(status));
		if (!status.spoiler_text) return body;
		var summary = element("summary", "mastodon-comment-cw-summary", thread.replaceCustomEmojis(status.spoiler_text, status.emojis));
		var attrs = this.collapseCw ? {} : { open: "open" };
		return element("details", "mastodon-comment-cw", [summary, body], attrs);
	};

	MastodonCommentsWidget.prototype.sanitizeStatusContent = function (status) {
		var parser = typeof DOMParser !== "undefined" ? new DOMParser() : null;
		return thread.sanitizeHtml(status.content || "", status.emojis, parser);
	};

	MastodonCommentsWidget.prototype.buildMedia = function (status) {
		var images = (Array.isArray(status.media_attachments) ? status.media_attachments : []).filter(function (media) {
			return media && media.type === "image" && thread.isWebUrl(media.preview_url || media.url);
		});
		if (!images.length) return null;
		var children = images.map(function (image) {
			var img = element("img", "mastodon-comment-image", [], {
				src: image.preview_url || image.url,
				alt: image.description || "",
				loading: "lazy"
			});
			return thread.isWebUrl(image.url) ? externalLink(image.url, "mastodon-comment-image-link", [img], image.description) : img;
		});
		if (!status.sensitive) return element("div", "mastodon-comment-images", children);
		return element("details", "mastodon-comment-sensitive", [
			element("summary", "mastodon-comment-sensitive-summary", [text(this.getText("SensitiveMedia"))]),
			element("div", "mastodon-comment-images", children)
		]);
	};

	MastodonCommentsWidget.prototype.buildCard = function (status) {
		var card = status.card;
		if (!card || !thread.isWebUrl(card.url)) return null;
		var children = [element("span", "mastodon-comment-card-title", [text(card.title || card.url)])];
		if (card.description) children.push(element("span", "mastodon-comment-card-description", [text(card.description)]));
		return externalLink(card.url, "mastodon-comment-card", children);
	};

	MastodonCommentsWidget.prototype.refresh = function (changedTiddlers) {
		var changedAttributes = this.computeAttributes();
		var settingsChanged = Object.keys(changedTiddlers).some(function (title) {
			return title.indexOf(CONFIG_PREFIX) === 0 || title === LANGUAGE_TIDDLER;
		});
		var fieldChanged = this.attributes.post === undefined && changedTiddlers[this.tiddlerTitle] &&
			this.getPostField().trim() !== this.postLink;
		if (changedAttributes.tiddler || changedAttributes.post || settingsChanged || fieldChanged) {
			this.refreshSelf();
			return true;
		}
		return this.refreshChildren(changedTiddlers);
	};

	exports["mastodon-comments"] = MastodonCommentsWidget;

})();
