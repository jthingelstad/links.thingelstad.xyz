# links.thingelstad.xyz

**Linking Things.** Every link Jamie Thingelstad has saved to Pinboard since 2005, as a
database: one page per link, and what connects them. It lives at
https://links.thingelstad.xyz/, the MCP server at `/mcp`. The design is `docs/DIRECTION.md` and the data contract
is `docs/DATA.md`; read them before changing structure, URLs or data.

- Built with Astro and TypeScript on the POAP pattern (`poap.thingelstad.xyz`): static
  output, Pagefind over the record pages only, minimal JavaScript (search and its preview
  pane, the home page's live results, the Kudos status line on record pages, and turning
  the home page to today's quote), no
  frameworks, nothing fetched at serve time from another host. The exceptions are the
  footer photo, `owner.avatar` from `shared/sites.json`, and Tinylytics, one script in
  production builds only (`PUBLIC_TINYLYTICS_ENABLED=true`, set by the deploy
  workflow; `design/tinylytics.md`). Never send a hit or a kudos from QA.
- **Data.** `data/` is written only by the Python tools (`tools/sync.py`,
  `tools/join_issues.py`, `tools/enrich_*.py`; `tools/README.md`). Never edit it by
  hand. `src/lib/data.ts` is the only module that reads `data/links` and
  `data/derived`, and everything derived (hosts, years, weeks, appearances, mentions,
  saved twice, kinds) is derived there, in memory.
- **Bus join, prepared off.** `sync-join.yml` defaults to a credential-free rehearsal. Real work also requires `SYNC_JOIN_APPROVED=true`, Jamie's explicit permission to repair WT354; the sync rule has a separate approval gate. The nightly checkout and schedule stay as they are. Never run the real join to test this proposal.
- **Enrichment.** `src/lib/enrichment.ts` is the only module that reads
  `data/enrichment` (`LINKS_ENRICHMENT` points it at `tests/fixtures/enrichment`
  for tests and screenshots). It keeps facts and drops every liveness field (dns,
  https, status, alive, final_url, redirects, errors) before a page, twin or feed
  sees it; `validate:site` fails if one gets through. Images are the tools' copies
  under `public/media/`, never hotlinked and never committed from here. A video is a
  click-to-play facade: no player request until the click.
- **Kinds** (`src/lib/kinds.ts`): every link has one, from its host and path alone,
  first rule wins, "page" is the rest. The browser search and the MCP server import
  the same file, so it takes no Node imports. Adding a kind adds a `/kinds/<kind>/`
  URL.
- **Voice** (`src/lib/voice.ts`): who a note speaks for, read from the note's form
  alone: bare text is Jamie's (`jamie`), a `>` blockquote is the page's words
  (`excerpt`), a blockquote inside Jamie's text is `mixed`. There is no year rule:
  the page excerpts the bookmarklet saved before 2017 were quoted at the source on
  2026-10-24. `agent` is provenance, read from the `_agent` tag the OpenClaw
  `pinboard-enrichment` skill adds to every note it writes, never from the text. The
  site, the twins, the llms files and the MCP label with it.
- **The database.** `npm run db` (`tools/build_db.py`, stdlib only) writes
  `public/links.db` from the JSON; `npm run build` runs it first. It is gitignored,
  deterministic, and facts only like the pages. The site never reads it.
- **Arrival receipts.** `/sync-fact.json` carries the imported change stamp and newest joined issue id/time only. `tools/sync-receipt.mjs` reports after a verified public deploy, never after a local join alone. Empty `SYNC_RECEIVED_BUS` is off. Unknown baselines and unchanged facts are not arrivals; the WT354 join remains Jamie's decision.
- **The id** is the first 12 hex characters of md5 of the URL exactly as saved, and it
  comes from the data. Never recompute an id from a normalised URL. Normalisation is
  for joins only; `src/lib/normalize.ts` must agree with `tools/linking/urls.py`, and
  `npm test` checks that on every URL.
- **URLs are fixed** (DIRECTION.md, "Pages"): `/links/<id>/` with its `.json` and `.md`
  twins, `/hosts/<host>/`, `/kinds/`, `/kinds/<kind>/`, `/issues/<n>/` (the Weekly
  Thing archive key, `140-special` for the special issue), `/years/<yyyy>/` with its
  `llms.txt`, `/newest/`, `/search/`, `/surprise/` (a noindex door to a random
  record), `/about/`, the feeds (`feed.xml` and
  `feed.json` at the root and under each host and kind page) and `/links.json`,
  `/hosts.json`, `/issues.json`, `/links.db`, `/llms.txt`, `/mcp` and `/mcp/health`. Kudos,
  feed readers, the Librarian, WT Builder and MCP clients depend on them.
  `src/lib/paths.ts` is the one place they are formed; `src/lib/data.ts` re-exports
  it for the pages and the MCP server imports it directly.
- **`/llms.txt`** (`llmsTxt()` in `src/lib/dataset.ts`) keeps the shape llmstxt.org's
  reference parser reads: prose only above the first `##`, then every line under a
  heading (`###` too) is one `- [name](url): notes` item, one link, no brackets in the
  name. `validate:site` fails a built file that strays (`llms_shape_problems`); the
  year files are full text, not that shape.
- **Search grammar** (`src/lib/search-grammar.ts`): parsing a query (words,
  "phrases", -exclusions, `site:`, `year:`, `wt:`, `kind:`), the rule that keeps
  only real matches (a bare word by its first three letters, a "quoted" word whole),
  and `onHost`, what `site:` takes in (the host and the hosts under it), which the MCP
  server and the suggestions' counts use too. The browser search and the MCP server's
  `links_search` both import it, and both search the same Pagefind index, so the site
  and the MCP find the same links; the MCP alone puts whole-word matches first
  (`wholeWords`), the browser shows the index's order. Change the grammar there, never
  in either caller. No Node imports. The box's suggestions (`src/lib/suggest.ts`, shown by
  `src/scripts/suggest.ts`) read the word at the cursor with its `tokenAt` and suggest
  from `/search/suggest.json`, the search page's own file (not a fixed URL, not part
  of the dataset); `validate:site` checks it against `/hosts.json` and `/issues.json`.
- **The MCP server** (`src/mcp/`; DIRECTION.md, "Agents and the MCP";
  `docs/deployment.md`, "The MCP server") is read-only, with no authentication, no
  model, no state and no keys. It reads only what the site publishes, over HTTPS: the
  three data files (`/links.json`, `/issues.json`, `/hosts.json`, revalidated by ETag
  every ten minutes), the Pagefind index, and for `resources/read` a link's Markdown
  twin or `/llms.txt`: never `data/`, never enrichment, never a bucket.
  Its answers carry what the JSON twins carry and nothing more (no `hash`, `meta` or
  enrichment field, nothing about whether a link works), and its reader-facing text
  (tool names and descriptions, notes, the `/mcp` page) follows the Pinboard rule
  below; `tests/mcp-server.test.mjs` checks both on every answer. A change to a tool's
  name, arguments or result shape bumps `SERVER_VERSION` in `src/mcp/tools.ts`.
  `npm run mcp:package` writes `.build/mcp/` (ignored); main deploys it after the site
  only when the bundle's contents change (the key hashes the entries' names and
  contents, so the same files key the same on any machine; `npm run mcp:plan` shows
  what a deploy would do). That deploy swaps the revision and nothing else: a change to
  `infra/mcp.json`, or to any `infra/*.json`, never goes live from a merge. It needs
  `npm run infra:plan`, a review, and `npm run infra:apply` on Jamie's go (below).
- **Times** are stored in UTC and shown in US Central, and years, months, weeks and
  the quote of the day turn over in Central too. Feed dates are Central with the real offset
  (RFC 822 in RSS, RFC 3339 in JSON Feed).
- **Reader-facing text never names Pinboard** (Jamie, 2026-10-23: "nobody needs to
  know pinboard exists"): pages, twins, feeds, llms files and the MCP server's tools,
  notes and page. Code comments and the docs may. Nor does any page say whether a
  link still works; links are not checked.
- **Prose is content.** The home page's quotes are `content/quotes.md` (format at the
  top of the file); a malformed entry fails the build with its line number. `/about/`
  is `content/about.md`, Jamie's words to edit: one `# ` title, then `## ` sections,
  or the build fails with the line.
- **Jamie's sites.** The strip, the footer h-card, the rel=me links and the shared type
  (`shared/sites.json`, `shared/tokens.css`, `shared/fonts/`) are vendored from
  `../thingelstad.com/shared/` by `npm run sites:sync`; `npm run sites:check` fails on
  drift. Never edit `shared/` here. No italics on sans-serif type.
- **Share images.** A record's `og:image` is its own card (2026-10-25; Jamie: "Linking
  Things link cards with Jamie-voice notes only"), drawn by cards.thingelstad.com from the
  record's h-entry: the title, `p-host`, the day saved, a `p-issue` on each issue chip,
  and the note only when `p-voice` is `jamie`. `src/lib/card.ts` forms the card's URL,
  with `v` a hash of what the card shows, and is the only place `v` is computed; the
  card maker's own rules are in `../thingelstad.com/cards.thingelstad.com/AGENTS.md`.
  Changing what a record's h-entry carries changes its card, so check both. Every other
  page's `og:image` is `/share.jpg` (the SEO scan, 2026-10-25), the live front page at
  1200 x 630 with a large Twitter card: `npm run share-image` (`tools/share-image.mjs`)
  redraws it by hand, with Tinylytics blocked; the count on it is a point in time.
  `tools/validate-site.py` fails a record that doesn't name its card and any other page
  that names another image.
- **Secrets.** `.env`, `pinboard/` and `archive/` are never committed.
  `pinboard/posts_all.json` holds private bookmarks and must never be published or
  copied into `data/`. Never print the Pinboard token.
- Run `npm run lint`, `npm run format:check`, `npm run check`, `npm test`,
  `npm run sites:check`, `npm run validate:infra`, `npm run validate:data`,
  `npm run build`, `npm run validate:site` and `npm run test:ci-browser` before
  pushing. Chromium for screenshots: `npx playwright install chromium`.
- **Hosting** is S3 and CloudFront in four stacks plus `links-mcp`, the MCP server's
  Lambda Web Function behind the same distribution (`infra/`), deployed from main by
  GitHub Actions through an OIDC role; `docs/deployment.md` has the stacks, the
  bootstrap, the DNS records and what a deploy uploads, removes and invalidates. A new
  file extension needs its Content-Type in `tools/delivery-plan.mjs` or the deploy
  stops. The sync and the enrichment run on the Mac as the nightly launchd job
  `com.thingelstad.links-nightly` (`tools/nightly.sh` at 00:30 Central; the plist is in
  `launchd/`), which commits `data/` and `public/media` as "Nightly: sync and
  enrichment, <date>" and pushes, and the push deploys. CI never holds the token. The
  job needs the main checkout on `main` and clean, so work in a worktree. While the
  first enrichment pass runs (about three weeks of nights) a night takes about three
  hours (2026-10-24: 1,000 hosts in 75 minutes, 800 Wayback lookups in 97 minutes), so
  the main checkout is busy from 00:30 to about 03:30 Central.
- Infrastructure changes go through reviewed CloudFormation change sets with the
  `cloud-engineer` identity (`npm run infra:plan` to review, `npm run infra:apply` on
  Jamie's go, `npm run infra:attach` once for the certificate), never through the
  deployment role. `apply` plans each stack afresh and executes it at once, so read what
  it prints too. DNS changes (Namecheap) are made by Jamie.
