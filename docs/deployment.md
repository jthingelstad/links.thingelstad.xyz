# Deployment, storage and DNS

The pattern is POAP's (`poap.thingelstad.xyz`): a private web bucket that only CloudFront
reads, and pages deployed from main by GitHub Actions through an OIDC role that cannot
change infrastructure. Linking Things has no media bucket and no archive bucket; every
object is in `dist/`, the video thumbnails and book covers under `media/` included
(`public/media/`, written only by `tools/enrich_facts.py`, about 6 MB).

## Stacks (us-east-1, account 999153317627)

| Stack               | Template                 | Holds                                                                                                                                                               |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `links-certificate` | `infra/certificate.json` | ACM certificate for `links.thingelstad.xyz`, DNS validated                                                                                                          |
| `links-storage`     | `infra/storage.json`     | `links-storage-web-999153317627`: private, SSE-S3, versioned (replaced and removed objects kept 30 days), retained if the stack goes                                |
| `links-site`        | `infra/site.json`        | Distribution with origin access control, cache and header policies, the index function, a 14-day access log without client addresses, 5xx alarm to the family topic |
| `links-delivery`    | `infra/delivery.json`    | GitHub OIDC deployment role, main only: list, read, write and remove site objects, invalidate this distribution                                                     |

Live ids and ARNs are in `infra/deployment.json`; `tools/bootstrap-infra.mjs` writes them.
`npm run validate:infra` pins what the templates promise (one private bucket, HTTPS
through OAC, a path-only cache key, no client addresses in the log, the role's exact
subject and actions), and cfn-lint checks the schema, on every push.

## Bootstrap, once

With the `cloud-engineer` identity (`AWS_PROFILE=cloud-engineer`, us-east-1):

```sh
npm ci
npm run infra:plan     # creates a change set for each stack and prints it; executes nothing
```

Review the printed changes; `apply` runs only on Jamie's go.

```sh
npm run infra:apply    # executes them in order and prints the DNS records
```

The order is storage, site, storage again (the bucket policy names the distribution),
delivery, certificate. The certificate stack waits until ACM sees its validation record,
so `apply` prints both records as soon as they exist and keeps waiting (up to an hour)
while Jamie adds them at Namecheap. If it is cut off, run it again: finished stacks
report no changes and a stack still in progress is waited for. When ACM shows ISSUED:

```sh
npm run infra:attach   # gives the distribution its alias and certificate
```

Then set the repository variable `AWS_DEPLOY_ROLE_ARN` to the deployment role ARN the
script printed (Settings, Secrets and variables, Actions, Variables). From then on every
push to main deploys. A later `infra:apply` keeps the attached certificate (it reads the
site stack's current parameter), and a stack that failed to create
(`ROLLBACK_COMPLETE`) has to be deleted on Jamie's go before it is created again.

## DNS (Namecheap, hosts relative to `thingelstad.xyz`)

| Type  | Host                                                        | Target                                           |
| ----- | ----------------------------------------------------------- | ------------------------------------------------ |
| CNAME | `links`                                                     | the CloudFront domain in `infra/deployment.json` |
| CNAME | the ACM validation host (`_<hash>.links`, printed by apply) | the ACM validation value (keep it for renewal)   |

Both records are printed by the bootstrap script. DNS changes are made by Jamie. There is
no Route 53 zone.

## Every push to main

`.github/workflows/ci.yml`, on every push and pull request: lint, format, types, the
Node and Python tests, the shared-files check, Ruff, `npm audit`, cfn-lint, infrastructure
and data validation; CodeQL; a credential-free build from the committed `data/`, the
site validator (links, metadata, sitemap, twins, Pagefind) and Chromium checks at desktop
and phone widths against `dist/` served behind the edge function
(`npm run test:ci-browser`). On main the build turns Tinylytics on
(`PUBLIC_TINYLYTICS_ENABLED=true`; the layout still loads it only on the production host)
and keeps the verified `dist/` as an artifact, and the deployment job publishes exactly
that artifact with `npm run deploy`.

`npm run deploy:plan` prints what a deploy would do with any identity in the account and
writes nothing.

## What a deploy uploads, removes and invalidates

`tools/deploy.mjs` with the rules in `tools/delivery-plan.mjs` (tested in
`tests/deploy.test.mjs`):

1. **Diff.** Every built file is hashed (md5) and the bucket is listed (ListObjectsV2,
   1,000 keys a page, about 74 calls). Objects are stored exactly as built, never
   pre-compressed, so a single-part upload's ETag is its md5 and only keys whose ETag
   differs are uploaded. When the header rules change, the fingerprint in
   `revision.json` changes and the next deploy uploads everything, so stored headers
   always follow the rules.
2. **Upload** in publication order: content-addressed assets, then what pages name by a
   fixed name (twins, feeds, Pagefind's entry file and scripts), then pages,
   `revision.json` last. Before each group the deploy checks this commit is still the
   head of main, so a superseded run stops.
3. **Remove** page keys the build no longer has, then invalidate, then remove stale
   content-addressed assets (so a cached page never names a missing stylesheet).
   Removal is the policy because a link made private at Pinboard must leave the site.
   A link deleted at Pinboard will keep its page as a tombstone once tombstones are
   built (`docs/DIRECTION.md`), so it is not removed. Versioning keeps every removed or
   replaced object for 30 days; the deployment role cannot delete versions.
4. **Guard.** A deploy that would remove more pages than the larger of 100 and 2% of the
   live pages stops before writing anything and prints the first few keys. If the
   removal is intended, run the workflow by hand (Actions, Validate and deploy, Run
   workflow on main) with `allow_removals` set to the exact count it printed.
5. **Invalidate** the changed and removed paths (both `/x/` and `/x/index.html` for a
   page), or `/*` when there are more than 50. CloudFront's first 1,000 paths a month are
   free across the whole account, then $0.005 a path, and `/*` counts as one. A data sync
   changes hundreds of pages, so it invalidates `/*`.
6. **Verify** `/`, `/revision.json` and one record's page, `.json` and `.md` twins from
   CloudFront: same bytes and the Content-Type the deploy stored; and that
   `/links/<id>` redirects to `/links/<id>/`.

One consequence of removing stale Pagefind chunks: a search page left open across a
deploy can fail to load an old chunk until it is reloaded.

## Content types, caching and compression

| Objects                                                                 | Content-Type                                                                 | Cache-Control                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Pages (`.html`)                                                         | `text/html; charset=utf-8`                                                   | `public,max-age=0,s-maxage=60,must-revalidate` |
| JSON twins and other `.json`                                            | `application/json`                                                           | the same                                       |
| Markdown twins (`.md`)                                                  | `text/markdown; charset=utf-8`                                               | the same                                       |
| Feeds, `feed.xml` and `feed.json` wherever they sit                     | `application/rss+xml; charset=utf-8`, `application/feed+json; charset=utf-8` | the same                                       |
| Sitemaps (`.xml`), `robots.txt`, `llms.txt`, `years/<yyyy>/llms.txt`    | `application/xml; charset=utf-8`, `text/plain; charset=utf-8`                | the same                                       |
| Pagefind's entry file, scripts and wasm                                 | JSON, JavaScript, `application/octet-stream`                                 | the same                                       |
| `_astro/` bundles and fonts, Pagefind `.pf_*` chunks (named by content) | by extension                                                                 | `public,max-age=31536000,immutable`            |
| `favicon.svg`                                                           | `image/svg+xml`                                                              | `public,max-age=3600`                          |
| Thumbnails and covers, `media/<youtube,vimeo,books>/<id>.jpg`           | `image/jpeg`                                                                 | `public,max-age=3600`                          |

A file with an extension not in `tools/delivery-plan.mjs` stops the deploy before
anything is written. The response headers policy adds `Access-Control-Allow-Origin: *`
for GET and HEAD, so the JSON and Markdown twins and the exports can be read from a page
on any origin; everything here is public data. The edge function redirects `/hosts/<name>` to `/hosts/<name>/`
(host names have dots, `/hosts/obsidian.md/`), so no file but `hosts/index.html` may sit
directly under `hosts/`; the deploy refuses one.

CloudFront compresses with Brotli or gzip for clients that ask, for the types on its list
(HTML, JSON, XML, CSS, JavaScript, plain text, SVG) between 1 KB and 10 MB. Markdown
(`text/markdown`) is not on that list, so the twins (2 KB on average) go uncompressed,
and so would a single JSON file over 10 MB. The year llms files are under 1 MB each, so
they are compressed. A client that sends no `Accept-Encoding`
(Python's urllib, curl without `--compressed`) gets the plain bytes.

## The nightly job: sync and enrichment on the Mac, not in CI

`PINBOARD_API_TOKEN` lives in `.env` on Jamie's Mac and the raw export
(`pinboard/posts_all.json`) holds the private bookmarks; neither is ever in GitHub. CI
never calls Pinboard and holds no Pinboard secret. Instead `tools/nightly.sh` runs on the
Mac every night and commits what changed; its push to main is the deploy.

**What it does** (`tools/README.md`, "The nightly job"): checks that the checkout is on
`main` and clean, fetches and fast-forwards (pushing an earlier run's commit first);
loads `.env` and `GITHUB_TOKEN` from `gh auth token` without echoing either; runs
`sync.py` and `join_issues.py`; then, one after another, `enrich_hosts.py --limit 1000`,
`enrich_facts.py --limit 500` and `enrich_pages.py --wayback-only --limit 800`;
validates `data/`; commits `data/` and `public/media/` as `Linking Things nightly` with
the message `Nightly: sync and enrichment, <YYYY-MM-DD>` and each step's summary in the
body; and pushes to main with retries after 2, 4, 8 and 16 seconds. A Pinboard rate
limit, a Wayback refusal or a GitHub rate limit is logged and the run goes on; a failed
validation exits 1 and leaves the tree as it is for a look.

**When:** 00:30 Mac time (US Central), from
`launchd/com.thingelstad.links-nightly.plist` (`StartCalendarInterval`; a Mac asleep at
00:30 runs it on waking). A first pass over the 7,064 hosts and 16,524 Wayback lookups
takes about three weeks of nights; after that a night is well under an hour.

**Logs:** `~/Library/Logs/links/nightly.log`, every line stamped in US Central, with each
tool's full output; launchd's own `nightly.out` and `nightly.err` beside it. The lock is
`~/Library/Logs/links/nightly.lock`.

**The checkout must be left on `main` and clean.** Do other work in a separate worktree
or clone. A checkout on another branch, with an uncommitted change or an untracked file,
or diverged from origin, makes the job exit 2 without touching anything; the log says
why, and the next night tries again.

**Install**, once:

```sh
mkdir -p ~/Library/Logs/links
cp launchd/com.thingelstad.links-nightly.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.thingelstad.links-nightly.plist
launchctl print gui/$(id -u)/com.thingelstad.links-nightly | head -20
```

To change it, `launchctl bootout gui/$(id -u)/com.thingelstad.links-nightly`, edit,
and bootstrap again. To run it now, `launchctl kickstart gui/$(id -u)/com.thingelstad.links-nightly`.

**A bounded trial by hand**, from the checkout, on main and clean:

```sh
tools/nightly.sh --dry-run                           # the plan; no network, no writes
tools/nightly.sh --hosts 20 --facts 10 --wayback 5   # a real run, a few minutes, then a push
tail -40 ~/Library/Logs/links/nightly.log
```

The real trial commits and pushes like the nightly run, so it deploys.

## Cost

The build is about 73,700 objects and 284 MB: 23,970 pages, 16,525 JSON and 16,524
Markdown files, and 16,687 Pagefind files.

- **First deploy:** one PUT per object, about 73,700 at $0.005 per 1,000: about $0.37.
  Listing, the invalidation and the checks are fractions of a cent.
- **A no-change push:** about six uploads (the few Pagefind files that differ from build
  to build, and `revision.json`) and two or three invalidation paths: nothing measurable.
- **A sync or a template change:** a template change rewrites every page, about 24,000
  PUTs, about $0.12; a nightly sync and enrichment commit is hundreds to a few thousand
  PUTs, about a cent (the first full facts run added 292 images, 6 MB).
- **Monthly, at this site's traffic:** S3 storage under a cent (0.3 GB, plus 30 days of
  replaced versions); CloudFront within the always-free 1 TB, 10 million requests and 2
  million function invocations; the access log within the 750 bytes a request CloudFront
  delivers to CloudWatch Logs free, 14 days of storage a few cents at most; the 5xx alarm
  $0.10; the certificate free. About $0.15 to $0.50 a month, most of it the alarm and
  template-change deploys. No Route 53.

## Later: the archive

The 70 GB Pinboard archive is for data only and never served (`docs/DIRECTION.md`, "The
archive"); it stays on the Mac. If a backup copy in S3 is wanted, it would be a separate
private bucket (Glacier class, every version kept, no CloudFront grant, no access for the
deployment role) in its own stack, not a prefix of the web bucket. Nothing here creates
it.

## Differences from POAP

- One bucket: no archive bucket, no media prefixes, no write-once media rules, no
  `media:*` scripts.
- No read-only build role: the build reads nothing from AWS.
- The deploy removes keys the build no longer has (POAP never removes), behind the
  removal guard.
- The edge function also redirects `/hosts/<name>` (a host name has dots) and keeps a
  repeated query parameter.
- Objects are stored uncompressed and diffed by ETag in one listing; a change in header
  rules re-uploads everything via the fingerprint in `revision.json`.
- `infra:apply` after `infra:attach` keeps the certificate: it reads the site stack's
  `CertificateArn` parameter (POAP's script reads an output the site stack does not
  have, so a second apply there would detach the certificate).
- The certificate stack goes last and the validation record is printed while it waits,
  so both DNS records are added in one visit.
