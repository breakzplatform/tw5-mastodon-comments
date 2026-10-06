# Mastodon comments for TiddlyWiki
Show the replies to a [Mastodon](https://joinmastodon.org) post as comments on a tiddler. Announce a tiddler on Mastodon, paste the link of that post into a `mastodon-post` field, and the conversation shows up at the bottom of the tiddler. Please add a star if you like the plugin!

Demo: https://tw5-mastodon-comments.joselito.dev

- No login, no API key and no third-party service: the replies come from the post's own Mastodon instance, straight to the visitor's browser
- Drawn with the wiki's own markup and palette, not an iframe, so the comments follow your theme
- Read-only: a *Reply on Mastodon* link opens the post, where anyone with an account can join in
- Avatars, names and handles, content warnings, sanitized post content, custom emojis, image attachments, preview cards, reply/boost/favourite counts and nested replies up to a configurable depth
- Only public and unlisted replies are shown; hidden replies and replies beyond the configured depth are counted with a link to Mastodon

Setup steps and details are in the plugin's *Setup* tab.

Sibling of [tw5-bluesky-comments](https://github.com/breakzplatform/tw5-bluesky-comments) and [tw5-github-comments](https://github.com/breakzplatform/tw5-github-comments).

## Installation instructions

### Drag'n'drop
- Open the demo TiddlyWiki: https://tw5-mastodon-comments.joselito.dev
- Drag the plugin box into your wiki

### Copy to a Node.js based wiki
- Create a `mastodon-comments` folder inside your wiki's `plugins` folder
- Clone this repo into the `mastodon-comments` folder

## Settings

In the *Mastodon comments* tab of the Control Panel:

| Setting | Default | |
|---|---|---|
| Filter | `[!is[system]]` | Which tiddlers can show comments. Only tiddlers with a `mastodon-post` field are affected |
| Reply depth | 6 | Levels of nested replies, from 1 to 20 |
| Order | Oldest first | Also newest first or most favourited first, for the direct replies |
| Show counts | Yes | Replies, boosts and favourites |
| Collapse content warnings | Yes | Content warnings start closed |
| Show and hide label text | Show/Hide Mastodon comments | Text of the button |

The texts are in a language dictionary tiddler that can be edited to translate them.

## Development

The library that parses links, sanitizes Mastodon HTML and builds the reply tree has tests that run with plain Node:

```sh
node --test test/
```

To try the plugin in a local wiki, create one next to the repo and link the plugin into it (a wiki inside the plugin folder would be loaded as part of the plugin):

```sh
mkdir -p ../mastodon-dev/plugins
ln -s "$PWD" ../mastodon-dev/plugins/mastodon-comments
echo '{"plugins":["tiddlywiki/tiddlyweb","tiddlywiki/filesystem"],"themes":["tiddlywiki/vanilla","tiddlywiki/snowwhite"]}' > ../mastodon-dev/tiddlywiki.info
npx tiddlywiki ../mastodon-dev --listen
```

Then open http://localhost:8080 and create a tiddler with a `mastodon-post` field. The test folder has a `tiddlywiki.files` with no tiddlers, so the tests stay out of the plugin.

## License

[MIT](LICENSE)
