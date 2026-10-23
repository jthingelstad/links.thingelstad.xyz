# Tinylytics

Site 3842, "Linking Things", created 2026-10-23 on Jamie's go. Embed uid
`x4A9AVd_xma4hyT9xLZw` (public, like every embed script on the web). Stats page
private.

The pattern is poap.thingelstad.xyz's (`design/tinylytics.md` there). Built
2026-10-23:

- **One script, production builds only.** `src/components/Analytics.astro`, placed at
  the end of the body by `src/layouts/Layout.astro`, writes the loader only when
  `import.meta.env.PROD && import.meta.env.PUBLIC_TINYLYTICS_ENABLED === 'true'`. At
  run time the loader adds
  `https://tinylytics.app/embed/x4A9AVd_xma4hyT9xLZw.js?kudos=custom` only when the
  page is on `links.thingelstad.xyz`, so a production build served on 127.0.0.1 or on
  a CloudFront preview URL loads nothing either. It marks the page with
  `data-tinylytics="on"` when it does.
- **The deploy workflow sets `PUBLIC_TINYLYTICS_ENABLED=true`** for the production
  build and for `npm run validate:site` after it (the validator reads the same
  variable to know which build it is checking). Nothing else sets it: `npm run dev`,
  `npm run build` on the Mac and every test build carry no reference to tinylytics.app.
- **Kudos, public** (`src/components/Kudos.astro`). Jamie, 2026-10-23: "The kudos
  button (let's use that name instead of like) is of course public. That is how that
  feature of tinylytics works." One Kudos button per record page, keyed on the
  permalink, which is why the id must never change:

  ```html
  <button type="button" id="kudos-links-<id>" class="tinylytics_kudos kudos"
    data-path="/links/<id>/" aria-labelledby="kudos-links-<id>-label kudos-links-<id>"
    title="Give kudos to this link"></button>
  <span class="kudos-label" id="kudos-links-<id>-label" aria-hidden="true">Kudos</span>
  ```

  The embed is loaded with `?kudos=custom`, which "returns only the count"
  (https://tinylytics.app/docs/widgets/kudos, "Emoji and custom markup"; the
  parameters are in the table at https://tinylytics.app/docs/widgets): the script
  writes the public count into the empty button, and the site draws the heart in CSS
  before it. There is no `data-private`, which would hide the count. After a click
  Tinylytics adds `.did_select` and disables the button; the CSS turns the ring and
  the heart to the link colour, and a status line beside it says "Kudos given. Thank
  you." On a build without Tinylytics the status line says that kudos are counted on
  the published site only, and the button shows the heart alone. A screen reader
  hears "Kudos" and then the count. The colours are the site's tokens (`--line`,
  `--card`, `--muted`, `--link`). It is outside the Pagefind index.
- **`npm run validate:site` checks it.** Without the variable: no file in `dist/`
  mentions tinylytics.app at all (HTML, script, JSON, XML, text and Markdown alike),
  and a loader found there fails with "validate it with the same setting". With it:
  every page carries exactly one loader for exactly that URL, and tinylytics.app is the
  one off-site fetch allowed, for that URL only. Either way every record has exactly
  one Kudos button keyed on its own permalink, and a `data-private` on it fails: the
  count is public.
- Never send a live hit or a kudos from QA. Screenshots of a production build are taken
  from 127.0.0.1 (where the hostname gate keeps the loader out) with requests to
  tinylytics.app blocked as well. Never create events, hits or kudos from tools or the
  Tinylytics MCP.
- Nothing else is tracked: no per-visitor identity, no search terms.
