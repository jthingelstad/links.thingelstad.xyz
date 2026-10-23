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
- **Kudos** (`src/components/Kudos.astro`): one Like per record page, a button with
  `class="tinylytics_kudos"`, `data-private="true"` and `data-path` set to the
  permalink `/links/<id>/`, which is why the id must never change. A status element
  beside it announces "Liked. Thank you." when Tinylytics marks the button
  `did_select`, and, on a build without Tinylytics, says that likes count on the
  published site only. The heart and its ring use the site's tokens (`--line`,
  `--card`, `--muted`, `--link`). It is outside the Pagefind index.
- **`npm run validate:site` checks it.** Without the variable: no file in `dist/`
  mentions tinylytics.app at all (HTML, script, JSON, XML, text and Markdown alike),
  and a loader found there fails with "validate it with the same setting". With it:
  every page carries exactly one loader for exactly that URL, and tinylytics.app is the
  one off-site fetch allowed, for that URL only. Either way every record has one
  private Like keyed on its own permalink.
- Never send a live hit or a kudos from QA. Screenshots of a production build are taken
  from 127.0.0.1 (where the hostname gate keeps the loader out) with requests to
  tinylytics.app blocked as well. Never create events, hits or kudos from tools or the
  Tinylytics MCP.
- Nothing else is tracked: no per-visitor identity, no search terms.

Open, for Jamie: the count is private (`data-private="true"`, as on the POAP site),
while `docs/DIRECTION.md` first described the Like "with the count so far".
