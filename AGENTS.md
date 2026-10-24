# links.thingelstad.xyz

**Linking Things.** Every link Jamie Thingelstad has saved to Pinboard since 2005, as a
database: one page per link, and what connects them. It will live at
https://links.thingelstad.xyz/. The design is `docs/DIRECTION.md` and the data contract
is `docs/DATA.md`; read them before changing structure, URLs or data.

- Built with Astro and TypeScript on the POAP pattern (`poap.thingelstad.xyz`): static
  output, Pagefind over the record pages only, minimal JavaScript (search, the Kudos
  status line on record pages, and turning the home page to today's quote), no
  frameworks, nothing fetched at serve time from another host. The exceptions are the
  footer photo, `owner.avatar` from `shared/sites.json`, and Tinylytics, one script in
  production builds only (`PUBLIC_TINYLYTICS_ENABLED=true`, set by the deploy
  workflow; `design/tinylytics.md`). Never send a hit or a kudos from QA.
- **Data.** `data/` is written only by the Python tools (`tools/sync.py`,
  `tools/join_issues.py`, `tools/enrich_*.py`; `tools/README.md`). Never edit it by
  hand. `src/lib/data.ts` is the only module that reads `data/links` and
  `data/derived`, and everything derived (hosts, years, weeks, appearances, mentions,
  saved twice, kinds) is derived there, in memory.
- **Enrichment.** `src/lib/enrichment.ts` is the only module that reads
  `data/enrichment` (`LINKS_ENRICHMENT` points it at `tests/fixtures/enrichment`
  for tests and screenshots). It keeps facts and drops every liveness field (dns,
  https, status, alive, final_url, redirects, errors) before a page, twin or feed
  sees it; `validate:site` fails if one gets through. Images are the tools' copies
  under `public/media/`, never hotlinked and never committed from here. A video is a
  click-to-play facade: no player request until the click.
- **Kinds** (`src/lib/kinds.ts`): every link has one, from its host and path alone,
  first rule wins, "page" is the rest. The browser search imports the same file, so
  it takes no Node imports. Adding a kind adds a `/kinds/<kind>/` URL.
- **The database.** `npm run db` (`tools/build_db.py`, stdlib only) writes
  `public/links.db` from the JSON; `npm run build` runs it first. It is gitignored,
  deterministic, and facts only like the pages. The site never reads it.
- **The id** is the first 12 hex characters of md5 of the URL exactly as saved, and it
  comes from the data. Never recompute an id from a normalised URL. Normalisation is
  for joins only; `src/lib/normalize.ts` must agree with `tools/linking/urls.py`, and
  `npm test` checks that on every URL.
- **URLs are fixed** (DIRECTION.md, "Pages"): `/links/<id>/` with its `.json` and `.md`
  twins, `/hosts/<host>/`, `/kinds/`, `/kinds/<kind>/`, `/issues/<n>/` (the Weekly
  Thing archive key, `140-special` for the special issue), `/years/<yyyy>/` with its
  `llms.txt`, `/newest/`, `/search/`, `/about/`, the feeds (`feed.xml` and
  `feed.json` at the root and under each host and kind page) and `/links.json`,
  `/hosts.json`, `/issues.json`, `/links.db`, `/llms.txt`. Kudos,
  feed readers, the Librarian and WT Builder depend on them. `src/lib/data.ts` is the
  one place they are formed.
- **Times** are stored in UTC and shown in US Central, and years, months, weeks and
  the quote of the day turn over in Central too. Feed dates are Central with the real offset
  (RFC 822 in RSS, RFC 3339 in JSON Feed).
- **Reader-facing text never names Pinboard** (Jamie, 2026-10-23: "nobody needs to
  know pinboard exists"): pages, twins, feeds and llms files. Code comments and the
  docs may. Nor does any page say whether a link still works; links are not checked.
- **Prose is content.** The home page's quotes are `content/quotes.md` (format at the
  top of the file); a malformed entry fails the build with its line number. `/about/`
  is `content/about.md`, Jamie's words to edit: one `# ` title, then `## ` sections,
  or the build fails with the line.
- **Jamie's sites.** The strip, the footer h-card, the rel=me links and the shared type
  (`shared/sites.json`, `shared/tokens.css`, `shared/fonts/`) are vendored from
  `../thingelstad.com/shared/` by `npm run sites:sync`; `npm run sites:check` fails on
  drift. Never edit `shared/` here. No italics on sans-serif type.
- **Secrets.** `.env`, `pinboard/` and `archive/` are never committed.
  `pinboard/posts_all.json` holds private bookmarks and must never be published or
  copied into `data/`. Never print the Pinboard token.
- Run `npm run lint`, `npm run format:check`, `npm run check`, `npm test`,
  `npm run sites:check`, `npm run validate:infra`, `npm run validate:data`,
  `npm run build`, `npm run validate:site` and `npm run test:ci-browser` before
  pushing. Chromium for screenshots: `npx playwright install chromium`.
- **Hosting** is S3 and CloudFront in four stacks (`infra/`), deployed from main by
  GitHub Actions through an OIDC role; `docs/deployment.md` has the stacks, the
  bootstrap, the DNS records and what a deploy uploads, removes and invalidates. A new
  file extension needs its Content-Type in `tools/delivery-plan.mjs` or the deploy
  stops. The sync and the enrichment run on the Mac as the nightly launchd job
  `com.thingelstad.links-nightly` (`tools/nightly.sh` at 00:30 Central; the plist is in
  `launchd/`), which commits `data/` and `public/media` as "Linking Things nightly" and
  pushes, and the push deploys. CI never holds the token. The job needs the main
  checkout on `main` and clean, so work in a worktree.
- Infrastructure changes go through reviewed CloudFormation change sets with the
  `cloud-engineer` identity, applied on Jamie's go, never through the deployment role.
  DNS changes (Namecheap) are made by Jamie.
