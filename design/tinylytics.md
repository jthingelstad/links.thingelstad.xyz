# Tinylytics

Site 3842, "Linking Things", created 2026-10-23 on Jamie's go. Embed uid
`x4A9AVd_xma4hyT9xLZw` (public, like every embed script on the web). Stats page
private.

Pattern, copied from poap.thingelstad.xyz (`design/tinylytics.md` there):

- `src/layouts/Layout.astro` loads one script,
  `https://tinylytics.app/embed/x4A9AVd_xma4hyT9xLZw.js?kudos=custom`, only when the
  build is for the production host (`https://links.thingelstad.xyz`). Local builds,
  previews and tests load nothing from tinylytics.app; `tools/check-site.mjs` (or
  the browser test) fails if any request reaches it.
- Kudos (`src/components/Kudos.astro`): one Like per record, `class="tinylytics_kudos"`,
  `data-private="true"`, keyed on the permalink `/links/<id>/`, which is why the id
  must never change. A notice element announces the result for screen readers.
- Never send a live hit or a kudos from QA. Never create events or hits from tools.
- Nothing else is tracked: no per-visitor identity, no search terms.
