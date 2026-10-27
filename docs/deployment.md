# Deployment, storage and DNS

The pattern is POAP's (`poap.thingelstad.xyz`): a private web bucket that only CloudFront
reads, and pages deployed by one AWS CodeBuild publisher. GitHub main promotes
its tested source package using OIDC; content events use IAM. `docs/BOOKMARKS.md`
describes the durable inbox, canonical snapshot and publication receipts. Linking Things has no media bucket and no archive bucket; every
object is in `dist/`, the video thumbnails and book covers under `media/` included
(`public/media/`, written only by `tools/enrich_facts.py`, about 6 MB). The one path
that is not a file is `/mcp`, the MCP server: a Lambda Web Function behind the same
distribution (section "The MCP server").

## Stacks (us-east-1, account 999153317627)

| Stack               | Template                 | Holds                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `links-certificate` | `infra/certificate.json` | ACM certificate for `links.thingelstad.xyz`, DNS validated                                                                                                                                                                                                                  |
| `links-storage`     | `infra/storage.json`     | `links-storage-web-999153317627`: private, SSE-S3, versioned (replaced and removed objects kept 30 days), retained if the stack goes                                                                                                                                        |
| `links-site`        | `infra/site.json`        | Distribution with origin access control, cache and header policies, the index and crawler functions, a 14-day access log without client addresses, 5xx alarm to the family topic; the `/mcp*` behaviour to the `links-mcp` endpoint through a second origin access control  |
| `links-delivery`    | `infra/delivery.json`    | Main-only GitHub OIDC role: promote one approved source package and start/watch the AWS publisher                                                                                                                                                                           |
| `links-publisher`   | `infra/publisher.json`   | One serialized CodeBuild project, its scoped site/MCP role, logs and EventBridge bookmark trigger                                                                                                                                                                           |
| `links-mcp`         | `infra/mcp.json`         | The MCP server: `links-mcp-code-999153317627` (private, versioned, the packaged server), an execution role that writes its own logs and nothing else, 30-day logs, the `links-mcp` web function, its revision and `live` endpoint (IAM auth), 5xx alarm to the family topic |

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

Review the printed changes; `apply` runs only on Jamie's go. `apply` does not execute the
change sets `plan` made: it plans each stack afresh, prints the new change set and
executes it at once, stack by stack. Executing one deletes the stack's other change sets,
and a stack with nothing to change is left a FAILED "no changes" set until someone
deletes it. Same template, same parameters, so the changes match `plan`'s unless the live
stack moved in between; read what `apply` prints all the same.

```sh
npm run infra:apply    # plans each stack again, executes it, and prints the DNS records
```

On the first run, `npm run build` first: `apply` packages the MCP server with the build's
Pagefind client and uploads it (section "Adding it to the live site, once"). Once
`links-mcp` has its endpoint, `apply` passes the live `CodeKey` and `CodeVersion` through
unchanged, so a later `apply` never swaps the revision; that is the CI deploy's job. The
order is mcp, the distribution's grant on its endpoint, storage, site,
storage again (the bucket policy names the distribution), publisher, delivery, certificate. The
certificate stack waits until ACM sees its validation record, so `apply` prints both
records as soon as they exist and keeps waiting (up to an hour) while they are added to the
zone stack (see DNS below). If it is cut off, run it again: finished stacks
report no changes and a stack still in progress is waited for. When ACM shows ISSUED:

```sh
npm run infra:attach   # gives the distribution its alias and certificate
```

Then set the repository variable `AWS_DEPLOY_ROLE_ARN` to the deployment role ARN the
script printed (Settings, Secrets and variables, Actions, Variables). From then on every
push to main deploys. A later `infra:apply` keeps the attached certificate (it reads the
site stack's current parameter), and a stack that failed to create
(`ROLLBACK_COMPLETE`) has to be deleted on Jamie's go before it is created again.

## DNS

`thingelstad.xyz` is a Route 53 hosted zone, and every record in it is code in the
`dns-thingelstad-xyz` stack: `config/dns-thingelstad-xyz-stack.yaml` in
`projects-sysadmin`. DNS moved there from Namecheap BasicDNS on 2026-10-27; Namecheap is
still the registrar but no longer serves the zone. A record changes by a pull request to
that stack and a deploy, never in a console and never at Namecheap. The site's two
records are there:

| Type  | Host                                                        | Target                                           |
| ----- | ----------------------------------------------------------- | ------------------------------------------------ |
| CNAME | `links`                                                     | the CloudFront domain in `infra/deployment.json` |
| CNAME | the ACM validation host (`_<hash>.links`, printed by apply) | the ACM validation value (keep it for renewal)   |

The bootstrap script still prints them formatted for Namecheap; put them in the zone
stack instead. The certificate stack can own its validation record later
(`DomainValidationOptions` with the zone's `HostedZoneId`); until then it stays in the
zone stack.

## Every push to main

`.github/workflows/ci.yml`, on every push and pull request: lint, format, types, the
Node and Python tests, the shared-files check, Ruff, `npm audit`, cfn-lint, infrastructure
and data validation; CodeQL; a credential-free build from the committed `data/`, the
site validator (links, metadata, sitemap, twins, Pagefind) and Chromium checks at desktop
and phone widths against `dist/` served behind the edge function
(`npm run test:ci-browser`). On main the build turns Tinylytics on
(`PUBLIC_TINYLYTICS_ENABLED=true`; the layout still loads it only on the production host)
and keeps the verified `dist/` as an artifact. Once every gate passes, the release
job uses OIDC to promote the clean tested source commit and canonical data snapshot
as a versioned package in the private inbox bucket. `npm run publisher:release`
starts and watches the single AWS publisher. That publisher combines the source
snapshot with all public bookmark captures, validates data, builds and validates
the site, runs `npm run deploy`, then packages and deploys the MCP server.
Bookmark events use the same publisher and approved package. They never create
commits or run CI. Only a complete verified publication writes the private success
marker; duplicate wake-ups can then exit without rebuilding.

For this migration use `npm run infra:plan -- --publisher-only` and
`npm run infra:apply -- --publisher-only`; these touch only the new publisher and
existing GitHub promotion role. Commit the generated publisher role ARN. The
GitHub role loses its direct site, inbox and MCP grants. Sync's `ReceiverRoles`
grants the publisher its existing received-event contract.

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
   `revision.json` last. Before each group the deploy checks the approved S3 package is still current, so a superseded run stops.
3. **Remove** page keys the build no longer has, then invalidate, then remove stale
   content-addressed assets (so a cached page never names a missing stylesheet).
   Removal is the policy because a link made private at Pinboard must leave the site.
   Tombstones for links deleted at Pinboard are decided but not built
   (`docs/DIRECTION.md`); until they are, a deleted link's page is removed like any
   other. Versioning keeps every removed or
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
directly under `hosts/`; the deploy refuses one. It also redirects any `.../index.html`
to its route, so each page has one address.

A second function, on the viewer response, adds `X-Robots-Tag: noindex` to everything
that is not `text/html`: the twins, the feeds, the exports, the llms files, the sitemaps
and the images. Search engines index the pages only, so 16,000 Markdown and JSON copies
of the records never compete with them (Jamie, 2026-10-24: make sure crawlers are not
"penalizing us"). The 404 page carries its own `noindex` meta tag.

CloudFront compresses with Brotli or gzip for clients that ask, for the types on its list
(HTML, JSON, XML, CSS, JavaScript, plain text, SVG) between 1 KB and 10 MB. Markdown
(`text/markdown`) is not on that list, so the twins (2 KB on average) go uncompressed,
and so would a single JSON file over 10 MB. The year llms files are under 1 MB each, so
they are compressed. A client that sends no `Accept-Encoding`
(Python's urllib, curl without `--compressed`) gets the plain bytes.

## The MCP server

`src/mcp/` is a read-only MCP server at `https://links.thingelstad.xyz/mcp` (Streamable
HTTP with JSON responses, no sessions, no authentication; `docs/DIRECTION.md`, "Agents
and the MCP"). It runs on a Lambda Web Function in the `links-mcp` stack. The site's
distribution sends `/mcp*` to the function's `live` endpoint through origin access
control: the endpoint takes IAM auth only, CloudFront signs every request (a POST body
as `UNSIGNED-PAYLOAD`, so clients add nothing), and the function's resource policy lets
this distribution, and nothing else, invoke it. Nothing from `/mcp` is cached at the
edge; the cache key and the forwarded request carry no cookie and no query string, and
the server sees only `Origin`, `Content-Type`, `Accept`, `User-Agent`,
`MCP-Protocol-Version` and `Mcp-Session-Id`.

| Request           | Answer                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /mcp`       | JSON-RPC: `initialize`, `tools/list`, `tools/call`, `resources/*`, `ping`                                                                                                             |
| `GET /mcp`        | a page for people that lists the tools; an event-stream GET gets 405                                                                                                                  |
| `GET /mcp/health` | `server_version`, the package key, the data's generated time, its counts, and when it was loaded and last checked; the request waits for the first load, so 503 means the load failed |
| `OPTIONS /mcp`    | 204 with CORS for any origin                                                                                                                                                          |

The server keeps no data of its own. It reads `/links.json`, `/issues.json` and
`/hosts.json` from the production host, revalidates them by ETag every ten minutes (a
failed fetch keeps what it has and tries again a minute later), and searches the
published Pagefind index with Pagefind's client, packaged beside it from the same build.
It logs one line a request (request id, HTTP method, path, JSON-RPC method, tool, status,
milliseconds, and the error message if any), never argument values.
The 5xx alarm `links-mcp-5xx` goes to the family topic.

Locally, after `npm run build`:

```sh
PAGEFIND_MODULE=dist/pagefind/pagefind.js npm run mcp:serve   # 127.0.0.1:8790, reads the live site
```

### Adding it to the live site, once (done 2026-10-24)

This ran on 2026-10-24 with the `cloud-engineer` identity, in two reviewed rounds, each
`apply` on Jamie's go. Kept as the record of what the bootstrap did:

```sh
npm run build
npm run infra:plan                   # the links-mcp stack's first half; nothing else changes yet
npm run infra:apply -- --mcp-only    # links-mcp: bucket, roles, logs; upload; function, revision, endpoint
npm run infra:plan                   # now shows the grant and the site and delivery change sets
npm run infra:apply                  # the grant, links-site (/mcp), links-delivery (MCP actions)
```

1. **links-mcp, first half:** the code bucket, its policy (Lambda may read
   `mcp/*` for this function only; TLS only), the execution role and the two log groups.
2. **Upload:** `apply` packages the server (`npm run mcp:package`), puts the zip with
   its SHA-256 and takes the object version.
3. **links-mcp, second half:** the function, its first revision on that version, the
   `live` endpoint and the 5xx alarm. `--mcp-only` stops here.
4. **The distribution's grant:** CloudFormation has no resource for a web function's
   resource policy, so the bootstrap sets it with `PutResourcePolicy`, one statement:
   `cloudfront.amazonaws.com` may `lambda:InvokeWebFunctionEndpoint` on the `live`
   endpoint when `aws:SourceArn` is this distribution. `plan` prints it; `apply` writes
   it once, reads it back, and stops rather than replace a different policy it finds.
5. **links-site** with `McpOriginDomain`: the origin access control, the cache and
   origin request policies and the `/mcp*` behaviour.
6. **links-delivery** with the code bucket and execution role: the `McpDelivery` policy.
   It includes `iam:GetRole` on that one execution role: CloudFormation resolves the
   revision's `ExecutionRoleArn` (a `GetAtt` on the role) with the deploy's own
   credentials, and without it a revision swap fails at "Unable to retrieve Arn
   attribute for AWS::IAM::Role" (seen 2026-10-24, rolled back cleanly).

The rewritten `infra/deployment.json` (with `mcpExecutionRoleArn` and `mcpEndpointDomain`)
was committed as 65644c5; without those two values the deploy's MCP step prints a notice
and does nothing. `curl https://links.thingelstad.xyz/mcp/health` shows what is live.

cfn-lint 1.57.2 does not know the Lambda Web Functions actions, so `DeploymentRole`
ignores W3037 (unknown action) in its own metadata; `npm run validate:infra` pins those
actions exactly instead. `tests/mcp-infra.test.mjs` edits copies of the templates and
expects the validator to refuse each edit.

### What an MCP deploy does

After the site deploy, the AWS publisher runs `npm run mcp:package` and `npm run
mcp:deploy` (`tools/deploy-mcp.mjs`, its rules in `tools/mcp-plan.mjs`):

1. **Package.** `src/mcp/main.ts` bundled by esbuild with no runtime dependencies,
   a `package.json` and Pagefind's `pagefind.js` from the verified build, in a zip with
   sorted entries and fixed timestamps. Its key, `mcp/<sha256>.zip`, is a hash of the
   entries' names and contents, not of the zip's bytes: zlib's deflate output differs
   between builds (a Mac and the GitHub runner zipped identical files to different
   bytes on 2026-10-24), and the key must not.
2. **Skip.** When the stack's `CodeKey` is already that key, the live revision runs
   these files and the step ends. Most pushes (a nightly sync, a page template) end
   here.
3. **Upload** the zip with its SHA-256, which S3 checks; the response gives the object
   version.
4. **Change set** on the reviewed template (`UsePreviousTemplate`) with `CodeKey` and
   `CodeVersion` changed and every other value kept. It is executed only if it
   replaces the revision and points the endpoint at it and does nothing else;
   otherwise it is deleted and the deploy fails. The role cannot change the template
   or anything outside the `links-mcp` stack, so infrastructure changes still go
   through the bootstrap. The change set runs with the role's own credentials, which is
   why `McpDelivery` carries `iam:GetRole` on the execution role (bootstrap step 6).
5. **Verify** `/mcp/health` through CloudFront until it reports the new key, then
   `initialize` once.

To roll back, revert the commit: the next deploy builds the earlier bytes, whose key
differs from the live one, and puts them live the same way. After `npm run build` and
`npm run mcp:package`, `npm run mcp:plan` prints what a deploy of that package would do
with any identity in the account and writes nothing.

`CustomErrorResponses` on the distribution apply to every behaviour, so a 404 from the
server (an unknown path under `/mcp`) and a 403 from the endpoint (a broken grant) both
reach a client as the site's 404 page. A `/mcp` that suddenly answers with the 404 page
is the grant to check first.

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
takes about three weeks of nights of about three hours each (2026-10-24: 1,000 hosts in
75 minutes, 800 Wayback lookups in 97 minutes at the 6 s pace, committed at 03:21
Central); after that a night is well under an hour. The per-night limits are set in
`tools/nightly.sh`.

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
- **The MCP server:** a web function is billed for requests, active CPU time and the
  memory an environment holds while it is alive (about 290 MB once the three files are
  loaded), not for time spent waiting on the network. At a handful of agent sessions a
  month that is cents at most; the exact rates are on the Lambda pricing page, and the
  family's other web functions show what this account pays. The code bucket keeps
  about 90 KB a version, old versions gone after 30 days; logs are a line a request,
  kept 30 days; the `links-mcp-5xx` alarm $0.10. About $0.10 to $0.20 a month more,
  most of it the alarm.

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
