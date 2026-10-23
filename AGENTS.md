# links.thingelstad.xyz

**Linking Things.** Every link Jamie Thingelstad has saved to Pinboard since 2005, as a
database: one page per link, and what connects them. It will live at
https://links.thingelstad.xyz/. The design is `docs/DIRECTION.md` and the data contract
is `docs/DATA.md`; read them before changing structure, URLs or data.

- Built with Astro and TypeScript on the POAP pattern (`poap.thingelstad.xyz`): static
  output, Pagefind over the record pages only, minimal JavaScript (the search page is
  the only page with a script), no frameworks, no third-party scripts, nothing fetched
  at serve time from another host. The one exception today is the footer photo,
  `owner.avatar` from `shared/sites.json`; Tinylytics will be the second
  (`design/tinylytics.md`).
- **Data.** `data/` is written only by the Python tools (`tools/sync.py`,
  `tools/join_issues.py`; `tools/README.md`). Never edit it by hand.
  `src/lib/data.ts` is the only module that reads it, and everything derived (hosts,
  years, weeks, appearances, mentions, saved twice) is derived there, in memory.
- **The id** is the first 12 hex characters of md5 of the URL exactly as saved, and it
  comes from the data. Never recompute an id from a normalised URL. Normalisation is
  for joins only; `src/lib/normalize.ts` must agree with `tools/linking/urls.py`, and
  `npm test` checks that on every URL.
- **URLs are fixed** (DIRECTION.md, "Pages"): `/links/<id>/` with its `.json` and `.md`
  twins, `/hosts/<host>/`, `/issues/<n>/` (the Weekly Thing archive key, `140-special`
  for the special issue), `/years/<yyyy>/`, `/search/`. Kudos, the Librarian and WT
  Builder depend on them. `src/lib/data.ts` is the one place they are formed.
- **Times** are stored in UTC and shown in US Central, and years, months and weeks are
  Central too.
- **Jamie's sites.** The strip, the footer h-card, the rel=me links and the shared type
  (`shared/sites.json`, `shared/tokens.css`, `shared/fonts/`) are vendored from
  `../thingelstad.com/shared/` by `npm run sites:sync`; `npm run sites:check` fails on
  drift. Never edit `shared/` here. No italics on sans-serif type.
- **Secrets.** `.env`, `pinboard/` and `archive/` are never committed.
  `pinboard/posts_all.json` holds private bookmarks and must never be published or
  copied into `data/`. Never print the Pinboard token.
- Run `npm run lint`, `npm run format:check`, `npm run check`, `npm test`,
  `npm run sites:check`, `npm run validate:data`, `npm run build` and
  `npm run validate:site` before pushing. Chromium for screenshots:
  `npx playwright install chromium`.
- Infrastructure changes go through reviewed CloudFormation change sets with the
  `cloud-engineer` identity, applied on Jamie's go. DNS changes (Namecheap) are made
  by Jamie.
