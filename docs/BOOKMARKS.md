# Prompt publication of Feedbin bookmarks

Jamie requested Feedbin → Pinboard → Linking Things on 2026-10-27. Hop 23
in the shared flows file is this additive public path. Hop 5 remains the
nightly full-account mirror, and the WT354 join (hop 6) remains unchanged.

The first implementation keeps Astro, Pagefind and the existing tested
GitHub Actions/OIDC deploy. A recent successful run spent 73 seconds building
and 54 seconds deploying; enrichment is outside this path. This is minutes
after discovery, not a promise of publication within seconds. Feedbin is
still discovered on sync's half-hour clock.

## Delivery

1. Sync confirms the exact bookmark with the existing runtime credential,
   then reads it with `posts/get?meta=yes`. Only an explicit `shared=yes`
   record with every canonical field may leave that runtime. Private records
   and the raw account export never enter GitHub or the inbox.
2. Sync writes an immutable, SHA-256-addressed public capture into the
   separate private `links-storage-inbox-999153317627` bucket, checkpoints
   its pointer, then emits `pinboard/bookmarks-ready`. The event holds only
   version, time and pending count. Notes and tags stay out of the bus and
   Sync's public journal.
3. The one EventBridge API destination dispatches `sync-bookmarks.yml` on
   `main`. The workflow uses the existing main-only OIDC role to read this
   inbox, validates every new capture, and commits only
   `data/derived/bookmarks.json`. The inbox is durable; the workflow drains
   all unprocessed captures, so replacing a pending GitHub run loses none.
4. The workflow explicitly dispatches normal CI, because a push using
   `GITHUB_TOKEN` does not itself start push workflows. A retry checks the
   public revision and dispatches again if publication has not landed.
5. Normal CI builds and verifies the whole site and deploys its verified
   artifact. After public readback, a known previous 404 followed by the
   exact public record and provenance fact permits `links/received`,
   `kind: star`, carrying the Feedbin id. Existing public records are
   baselines, not invented arrivals. Sync also polls the exact JSON twin.

## Two writers without shared output files

Only the Mac writes `data/links/<year>.json` and `data/sync.json`. Only the
bookmark workflow writes the additive capture ledger. The static TypeScript
reader and Python readers combine them using the same precedence:

- A canonical record wins every field, preserving later edits.
- An absent record is added only when its capture was observed after the
  full snapshot's `fetched_at`.
- A newer full snapshot controls privacy and deletion. An older capture
  cannot resurrect an absent record.

The partial import never advances the account-wide `updated` stamp or
snapshot counts. The next full mirror absorbs the new bookmark, and normal
nightly enrichment supplies additional facts later. The JSON/Markdown
twins, feeds, search and SQLite download all use the combined public set.

`/sync-fact.json` adds `stars` (Feedbin id, exact URL, link id for records
currently present) and `bookmark_captures` (processed capture digests).
Acknowledging a processed stale capture is different from claiming arrival.
Sync repeats the wake-up each half-hour until a deployed fact acknowledges
the capture. Dispatch acceptance, a commit, or an S3 upload is insufficient.
No starring-to-arrival lag is quoted because Feedbin gives no star time.

## Activation and recovery

The changes are prepared with Sync's `LinksBookmarkMode=off`. Deploy the
Links storage/delivery change sets and merge its workflow first. Add the
fine-grained `github_links_actions_token` to `sync-runtime` in Secrets
Manager, restricted to this repository with Actions read/write. Never paste
or retrieve the token into an agent session.

Set `SYNC_LINKS_BOOKMARK_MODE=rehearsal` for Sync's reviewed deployment.
Send a `pinboard/ping`; verify the credential-free rehearsal succeeds.
Then deploy `SYNC_LINKS_BOOKMARK_MODE=active`, grant the Links deploy role
receipt permission through Sync's existing `ReceiverRoles`, and set the
repository variable `SYNC_RECEIVED_BUS=thingelstad-publishing`.

Use the already confirmed real Feedbin backlog for acceptance. Verify the
exact public records, the receipt, and Sync's end-to-end star journey.
Keep the nightly full mirror. Setting mode back to `off` stops captures and
removes the API destination without undoing committed public bookmarks.
Provider/storage failures retain work for the next clock; rejected imports
publish nothing. A superseding main push causes a safe retry, never a force
push or publication of an older revision.
