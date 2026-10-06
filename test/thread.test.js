// Run with: node --test test/
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var thread = require("../lib/thread.js");

function status(id, options) {
	options = options || {};
	return {
		id: String(id),
		in_reply_to_id: options.parent === undefined ? null : String(options.parent),
		visibility: options.visibility || "public",
		created_at: options.createdAt || "2026-01-01T00:00:00Z",
		favourites_count: options.favourites || 0,
		replies_count: options.replies || 0,
		reblogs_count: options.boosts || 0,
		content: options.content || "<p>" + id + "</p>",
		spoiler_text: options.spoiler || "",
		sensitive: !!options.sensitive,
		account: {
			acct: options.acct || "alice@example.social",
			display_name: options.displayName || "Alice",
			emojis: options.accountEmojis || []
		},
		emojis: options.emojis || [],
		media_attachments: options.media || [],
		url: options.url || "https://example.social/@alice/" + id
	};
}

function textOf(nodes) {
	return nodes.map(function (node) {
		return node.type === "text" ? node.text : textOf(node.children || []);
	}).flat().join("");
}

test("parses supported Mastodon post links", function () {
	assert.deepEqual(thread.parsePostLink("https://mastodon.social/@Gargron/117382963679112384"), {
		instance: "mastodon.social",
		id: "117382963679112384",
		url: "https://mastodon.social/@Gargron/117382963679112384"
	});
	assert.deepEqual(thread.parsePostLink(" https://example.social/@user@other.domain/123?ref=x "), {
		instance: "example.social",
		id: "123",
		url: "https://example.social/@user@other.domain/123"
	});
	assert.deepEqual(thread.parsePostLink("https://example.social/users/alice/statuses/456"), {
		instance: "example.social",
		id: "456",
		url: "https://example.social/users/alice/statuses/456"
	});
});

test("rejects non-http links and non-status URLs", function () {
	["", "javascript:alert(1)", "ftp://mastodon.social/@a/1", "https://mastodon.social/@a/not-id",
		"https://mastodon.social/tags/test", "https://user@mastodon.social/@a/1", "https://mastodon.social:443/@a/1"]
		.forEach(function (link) {
			assert.equal(thread.parsePostLink(link), null, link);
		});
});

test("sanitizes HTML with a strict allowlist", function () {
	var nodes = thread.sanitizeHtml("<p data-x=\"1\">Hi <strong onclick=\"x\">there</strong><script>alert(1)</script><iframe>bad</iframe><img src=\"x\"><a href=\"https://example.com\" onclick=\"x\">link</a><a href=\"javascript:alert(1)\">bad</a></p>");
	assert.deepEqual(nodes, [{
		type: "element",
		tag: "p",
		attributes: {},
		children: [
			{ type: "text", text: "Hi " },
			{ type: "element", tag: "strong", attributes: {}, children: [{ type: "text", text: "there" }] },
			{ type: "text", text: "alert(1)" },
			{ type: "text", text: "bad" },
			{ type: "element", tag: "a", attributes: {
				href: { type: "string", value: "https://example.com" },
				target: { type: "string", value: "_blank" },
				rel: { type: "string", value: "noopener noreferrer nofollow ugc" }
			}, children: [{ type: "text", text: "link" }] },
			{ type: "text", text: "bad" }
		]
	}]);
});

test("handles nested tags and Mastodon invisible spans", function () {
	var nodes = thread.sanitizeHtml("<p>https://example<span class=\"invisible\">.com/path</span><span class=\"ellipsis\">/long</span> <em><code>x</code></em></p>");
	assert.equal(textOf(nodes), "https://example/long… x");
	assert.equal(nodes[0].children[1].tag, "span");
	assert.deepEqual(Object.keys(nodes[0].children[1].attributes), []);
});

test("renders custom emojis only with safe URLs", function () {
	var nodes = thread.sanitizeHtml("<p>Hello :party: :bad:</p>", [
		{ shortcode: "party", url: "https://cdn.example/party.png" },
		{ shortcode: "bad", url: "javascript:alert(1)" }
	]);
	assert.equal(nodes[0].children[1].tag, "img");
	assert.equal(nodes[0].children[1].attributes.alt.value, ":party:");
	assert.equal(nodes[0].children[1].attributes.src.value, "https://cdn.example/party.png");
	assert.equal(textOf(nodes), "Hello  :bad:");
});

test("builds the reply tree and filters non-public visibility", function () {
	var root = status("1", { replies: 4 });
	var context = { descendants: [
		status("2", { parent: "1", createdAt: "2026-01-03T00:00:00Z" }),
		status("3", { parent: "1", createdAt: "2026-01-02T00:00:00Z" }),
		status("4", { parent: "1", visibility: "private" }),
		status("5", { parent: "4" }),
		status("6", { parent: "2" })
	] };
	var built = thread.buildThread(root, context, { maxDepth: 6, sort: "oldest" });
	assert.equal(built.kind, "visible");
	assert.deepEqual(built.replies.map(function (node) { return node.status.id; }), ["3", "2"]);
	assert.deepEqual(built.replies[1].replies.map(function (node) { return node.status.id; }), ["6"]);
	assert.equal(built.omitted, 2);
});

test("sorts direct replies by newest or favourites and nested replies chronologically", function () {
	var root = status("1");
	var context = { descendants: [
		status("2", { parent: "1", favourites: 1, createdAt: "2026-01-01T00:00:00Z" }),
		status("3", { parent: "1", favourites: 5, createdAt: "2026-01-02T00:00:00Z" }),
		status("4", { parent: "2", createdAt: "2026-01-04T00:00:00Z" }),
		status("5", { parent: "2", createdAt: "2026-01-03T00:00:00Z" })
	] };
	var byFavourites = thread.buildThread(root, context, { maxDepth: 6, sort: "favourites" });
	assert.deepEqual(byFavourites.replies.map(function (node) { return node.status.id; }), ["3", "2"]);
	assert.deepEqual(byFavourites.replies[1].replies.map(function (node) { return node.status.id; }), ["5", "4"]);
	var newest = thread.buildThread(root, context, { maxDepth: 6, sort: "newest" });
	assert.deepEqual(newest.replies.map(function (node) { return node.status.id; }), ["3", "2"]);
});

test("counts replies beyond the configured depth", function () {
	var built = thread.buildThread(status("1"), { descendants: [
		status("2", { parent: "1" }),
		status("3", { parent: "2" })
	] }, { maxDepth: 1, sort: "oldest" });
	assert.deepEqual(built.replies.map(function (node) { return node.status.id; }), ["2"]);
	assert.equal(built.replies[0].replies.length, 0);
	assert.equal(built.omitted, 1);
});

test("survives cyclic reply chains", function () {
	var built = thread.buildThread(status("1"), { descendants: [
		status("2", { parent: "1" }),
		status("3", { parent: "2" }),
		status("2", { parent: "3" })
	] }, { maxDepth: 6, sort: "oldest" });
	assert.deepEqual(built.replies.map(function (node) { return node.status.id; }), ["2"]);
	assert.deepEqual(built.replies[0].replies.map(function (node) { return node.status.id; }), ["3"]);
	assert.equal(built.replies[0].replies[0].replies.length, 0);
});

test("ignores descendants that reuse the root id", function () {
	var built = thread.buildThread(status("1"), { descendants: [
		status("2", { parent: "1" }),
		status("1", { parent: "2" })
	] }, { maxDepth: 6, sort: "oldest" });
	assert.deepEqual(built.replies.map(function (node) { return node.status.id; }), ["2"]);
	assert.equal(built.replies[0].replies.length, 0);
});

test("keeps the first status when duplicate ids appear", function () {
	var built = thread.buildThread(status("1"), { descendants: [
		status("2", { parent: "1", createdAt: "2026-01-01T00:00:00Z" }),
		status("2", { parent: "1", createdAt: "2026-01-02T00:00:00Z", displayName: "Duplicate" }),
		status("3", { parent: "2" })
	] }, { maxDepth: 6, sort: "oldest" });
	assert.deepEqual(built.replies.map(function (node) { return node.status.account.display_name; }), ["Alice"]);
	assert.deepEqual(built.replies[0].replies.map(function (node) { return node.status.id; }), ["3"]);
});

test("reports hidden roots and keeps CW data on statuses", function () {
	assert.equal(thread.buildThread(status("1", { visibility: "direct" }), { descendants: [] }, {}).kind, "hidden");
	assert.equal(status("2", { spoiler: "Spoiler", sensitive: true }).spoiler_text, "Spoiler");
	assert.equal(status("2", { spoiler: "Spoiler", sensitive: true }).sensitive, true);
});

test("isWebUrl accepts only http and https links", function () {
	assert.equal(thread.isWebUrl("https://example.com/a"), true);
	assert.equal(thread.isWebUrl("HTTP://example.com"), true);
	assert.equal(thread.isWebUrl("javascript:alert(1)"), false);
	assert.equal(thread.isWebUrl("data:text/html,x"), false);
	assert.equal(thread.isWebUrl("https://exa mple.com"), false);
	assert.equal(thread.isWebUrl(null), false);
});
