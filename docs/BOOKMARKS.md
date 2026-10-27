# Publication of Feedbin bookmarks

Jamie approved an AWS publisher on 2026-10-27 for Feedbin -> Pinboard -> Linking
Things (hop 23). Astro, Pagefind and the public URL contract stay in place.
Publication and enrichment are separate: public bookmarks can land before the
nightly mirror and enrichment. Feedbin discovery remains a half-hour poll.

## One publisher

1. Sync reads the exact confirmed bookmark. Only explicit `shared=yes` with
   every canonical field can enter the private inbox. Its immutable SHA-256
   capture binds the Feedbin identity, exact URL, public record and observation
   time. Neither the raw account export nor a credential leaves the source.
2. The inbox write precedes Sync's checkpoint and metadata-only
   `pinboard/bookmarks-ready` event. Sync repeats the wake-up each half-hour
   until a deployed fact acknowledges the capture.
3. An EventBridge rule in `links-publisher` starts one CodeBuild project with
   concurrent build limit one. It drains the durable inbox, imports into a
   build-local `data/derived/bookmarks.json`, validates data, builds Astro and
   Pagefind, validates every public output, and publishes the site and MCP.
   Content arrivals make no Git commits and trigger no GitHub workflow.
4. The public fact carries processed capture hashes and star identities of
   records currently present. A known previous 404, matching served fact and
   exact public JSON twin permit a `links/received` event for that star.
   Existing pages are baselines, never fabricated arrival measurements.
5. Only after public verification and the MCP step succeed does the publisher
   write its private success marker. Duplicate wake-ups then do nothing.
   A partially published build has no success marker and must finish on retry.

The inbox and versioned approved source packages share the existing private
`links-storage-inbox-999153317627` bucket with separate IAM prefixes. Sync
can write only `bookmarks/*`. GitHub main can write only `releases/current.zip`
and start/watch this one project. Only the CodeBuild role can publish site
objects, invalidate this distribution and update the existing MCP code revision.
No GitHub personal access token, new source connection or always-on server is
required. `tools/publication-context.mjs` checks the real AWS identity, project,
release manifest and current package metadata before publication groups.

## Code releases and canonical data

GitHub still reviews and tests code and the Mac's canonical data commits. Main
must pass all existing quality, security, data, build and browser gates. Its
OIDC role then promotes a versioned source package, carrying the exact tested
commit and canonical snapshot, to S3. The AWS publisher builds that approved
package with all durable captures. Old CI runs cannot promote a superseded
main; an older publisher stops when its approved package is replaced.

The canonical year files win every field. An absent capture is visible only
when observed after the full snapshot's `fetched_at`. A newer full snapshot
controls deletion and privacy; replay never resurrects an absent old bookmark.
Each build starts from the approved snapshot and replays the full inbox, so a
capture remains available across code releases without a Git ledger commit.
The partial import never advances the account-wide change stamp or counts.
JSON/Markdown twins, feeds, search and SQLite use the combined public set.
The nightly full mirror, enrichment and WT354 issue join remain as they were.

## Deployment and recovery

`npm run infra:plan -- --publisher-only` reviews the publisher and GitHub
promotion role; `npm run infra:apply -- --publisher-only` applies them using
cloud-engineer. Commit the resulting live role ARN in `infra/deployment.json`.
Grant that publisher role receipt permission through Sync's `ReceiverRoles`.
Merge the reviewed publisher code and wait for its first approved release to
publish before setting Sync's `LinksBookmarkMode=active`. Off disables future
captures; it never deletes previously published records or the durable inbox.

Provider, storage and build failures retain work. EventBridge retries failed
starts; pending captures cause further half-hour wake-ups. A failed code release
is visible in both GitHub's release job and CodeBuild and can be retried by
rerunning main CI. The publisher validates before any website write, retains the
existing removal guard and publication ordering, verifies public bytes, and
writes its success marker last. Source packages are versioned for recovery.
Use actual already-confirmed missing bookmarks for end-to-end acceptance.

## Acceptance on 2026-10-27

The first approved AWS release was main `e0e970df9fa2222edffbe66dfa8dfd7b133ddd08`
(GitHub run `40556436240`). CodeBuild verified and published the existing
16,539 records before captures were enabled. The source then captured all
50 real feed records; EventBridge started the content builds without a
GitHub dispatch credential. All 50 captures were acknowledged by the
published fact, with 16,544 records in the resulting site.

These five records were known HTTP 404s before publication. Each now passes
exact URL/id checks in its public JSON twin, HTML and Markdown, `/links.json`,
RSS, `/newest/`, and the downloadable SQLite database:

| Feedbin id | Public link id |
| --- | --- |
| 5323715058 | 99acb94678d1 |
| 5317954508 | df7d9d2802df |
| 5314473860 | 7832d4d7980d |
| 5258533599 | 79b6ca584a93 |
| 5244978813 | 7f3a627640ac |

Sync's current star journey records the exact destination report at
`2026-10-27T18:19:06Z` (`via: site-deploy`), and both star hops are fresh.
The source star has no timestamp, so this creates no star-to-arrival lag.
The global full-mirror stamp remains `2026-10-26T17:31:17Z` and the newest
joined issue remains 353. The MCP reader retains its existing ten-minute
revalidation interval; public static arrival and cached MCP refresh are
separate observations.
