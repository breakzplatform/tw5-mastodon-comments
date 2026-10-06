/*\
title: $:/plugins/breakzplatform/mastodon-comments/viewtoolbar/mastodon-comments-open-listener.js
type: application/javascript
module-type: startup

Scroll to the Mastodon comments when they are opened from the toolbar

\*/
(function () {

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	// Export name and synchronous status
	exports.name = "open-mastodon-comments";
	exports.platforms = ["browser"];
	exports.after = ["render"];
	exports.synchronous = true;

	// The button opens the comments and asks to scroll to them in the same
	// click, before the story is refreshed, so wait for the refresh to run
	exports.startup = function () {
		$tw.rootWidget.addEventListener("tm-mastodon-comments-scroll", function (event) {
			var title = event.param;
			var attempts = 0;
			var tryScroll = function () {
				var wrappers = document.querySelectorAll(".mastodon-comments");
				for (var index = 0; index < wrappers.length; index++) {
					if (wrappers[index].getAttribute("data-tiddler-title") === title) {
						$tw.pageScroller.scrollIntoView(wrappers[index]);
						return;
					}
				}
				// Older cores refresh the story later than the next tick
				if (++attempts < 20) setTimeout(tryScroll, 50);
			};
			setTimeout(tryScroll, 0);
			return false;
		});
	};

})();
