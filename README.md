# <img src="public/icon-48.png" width="38" align="left" /> Specto

> Your lookout for live streams on [Kick](https://kick.com). Based on [Gumbo](https://github.com/Seldszar/Gumbo) by Seldszar.

*Specto* is Latin for "I watch."

Check your followed Kick channels and live streams, browse popular streams and categories, search channels and categories, and get notified when a channel goes live or changes category — all from the browser toolbar.

## How it works

Kick's [public API](https://docs.kick.com/) has no endpoint for a user's follows, and every token requires a client secret, which can't be shipped in an extension. Instead, this extension uses the private API that the kick.com website itself uses:

- **Sign in** happens on kick.com. The extension reads your `session_token` cookie and sends it as a bearer token, exactly like the site does. No password or API keys are stored by the extension.
- **Log out** in the extension removes that cookie, which also signs you out of kick.com.
- A [`declarativeNetRequest` rule](public/rules.json) sets `Referer: https://kick.com/` on the extension's requests to Kick.

All Kick calls live in [`src/background/modules/kick.ts`](src/background/modules/kick.ts), which maps Kick responses to the Helix-shaped types the UI was originally built around. Channels and categories are identified by their slug.

| Feature | Endpoint |
| --- | --- |
| Followed channels | `kick.com/api/v2/channels/followed` (authenticated) |
| Stream details (uptime, thumbnail, category) | `kick.com/api/v2/channels/{slug}/livestream` |
| Top streams, category streams | `web.kick.com/api/v1/livestreams` |
| Top categories, category details | `kick.com/api/v1/subcategories` |
| Category clips | `kick.com/api/v2/categories/{slug}/clips` |
| Channel and category search | `kick.com/api/search` |
| Users | `kick.com/api/v2/channels/{slug}` |
| Current user | `kick.com/api/v1/user` (authenticated) |

### Caveats

- These endpoints are undocumented and can change or be blocked (Kick sits behind Cloudflare) without notice.
- The session cookie grants full account access; the extension only uses it for the requests above.
- Not available on Kick, so removed: category videos, reruns, channel schedules, IGDB links, and the "followed since" date.

## Install (development)

1. Install the dependencies: `yarn install`
2. Build for the desired platform:
   - `yarn build:chrome`
   - `yarn build:firefox`
3. Load the `dist` folder:
   - **Chrome / Edge / Brave:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `dist`.
   - **Firefox (128+):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → select `dist/manifest.json`.
4. Log in on [kick.com](https://kick.com) in the same browser profile.

Each CI run also uploads `chrome-artifact` and `firefox-artifact` builds.

## Credits

Gumbo is © Alexandre Breteau (Seldszar), released under the [MIT License](LICENSE). If you enjoy it, consider [supporting the original author](https://github.com/Seldszar/Gumbo#donating).
