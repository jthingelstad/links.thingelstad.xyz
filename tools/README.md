# Data tools

Three commands write and check everything under `data/`. They are Python 3 with the
standard library only (no venv, no installs) and run under `python3 -I`. Run them from
the repository root. `docs/DATA.md` is the contract they keep; this file covers how
to run them and the details a reimplementation needs.

| Command | npm script | Reads | Writes |
| --- | --- | --- | --- |
| `python3 tools/sync.py` | `npm run sync` | Pinboard API, or a saved export | `data/links/<yyyy>.json`, `data/sync.json`, `pinboard/posts_all.json` |
| `python3 tools/join_issues.py` | `npm run join` | Weekly Thing issue files, `data/links/` | `data/derived/issues.json` |
| `python3 tools/validate_data.py` | `npm run validate:data` | `data/`, `pinboard/posts_all.json` | nothing |

The shared code is the `tools/linking/` package: `urls` (normalise, ids, md5),
`pinboard` (API client and sharding), `frontmatter` (the YAML reader), `issues` (the
join), `validate` (the checks) and `jsonio` (output format and atomic writes).

Tests: `python3 -m unittest discover -s tests -v` (the `test_*.py` files; `npm test`
runs them after the Node tests).

## Output format

Every JSON file under `data/` is `json.dumps(value, ensure_ascii=False, indent=1)`
plus a trailing newline, UTF-8. Writes are atomic (a temporary file in the same
directory, then a rename), and a file whose bytes would not change is not touched, so
the Astro dev server only sees the year files that really changed.

## sync.py: the Pinboard mirror

```sh
set -a; source .env; set +a      # puts PINBOARD_API_TOKEN in the environment
python3 -I tools/sync.py         # pull if Pinboard changed
python3 -I tools/sync.py --check # ask only: one posts/update call, writes nothing
python3 -I tools/sync.py --force # pull even if the stamp has not moved
python3 -I tools/sync.py --from pinboard/posts_all.json  # offline, no network
```

A live run:

1. Calls `posts/update` and compares its `update_time` with `updated` in
   `data/sync.json`.
2. If the stamp has not moved (and there is no `--force`), stops. No `posts/all` call.
3. Refuses (exit 3) if `posts/all` was called less than five minutes ago. The time
   of the last call is the later of `fetched_at` in `data/sync.json` and
   `pinboard/.posts_all_called_at`, a marker written just before every `posts/all`
   call, so even a call whose response was lost still counts. `--force` checks this
   before making any call at all.
4. Calls `posts/all`, refuses an export that is empty or not a list of bookmarks,
   and refuses one with more than a tenth fewer public bookmarks than the last sync
   (`--allow-shrink` overrides, for a real mass deletion or a privacy change).
5. Saves the raw response to `pinboard/posts_all.json` with mode 0600. It holds the
   private bookmarks, so it lives outside `data/` and is gitignored; the tool refuses
   a `--raw` path under `--data`.
6. Writes the public shards and removes any year file that no longer has a public
   link.
7. Writes `data/sync.json`.

The shards hold `shared: "yes"` bookmarks only, as records with the contract's
fields in the contract's order, sorted by `saved` then `id`. A bookmark whose `hash`
is not md5 of its `href`, or two bookmarks with the same id, stop the sync before
anything is written.

`data/sync.json`:

```json
{
 "updated": "2026-10-23T19:51:57Z",
 "fetched_at": "2026-10-23T20:05:00Z",
 "public": 16524,
 "total": 16882
}
```

`updated` is Pinboard's stamp as of the last pull, `fetched_at` is when that
`posts/all` call was made (UTC), `public` is the number of records written and
`total` the number of bookmarks in the export, private ones included.

Offline (`--from FILE`) makes no network call and needs no token. It writes the same
shards from a saved export and keeps `updated` and `fetched_at` from the existing
`data/sync.json`. With no `data/sync.json` yet, `updated` is `null` (the next live run
will then see the stamp as moved and pull) and `fetched_at` is the file time of the
export.

The API calls send a User-Agent naming links.thingelstad.xyz, wait at least three
seconds between calls, and time out after 30 seconds (`posts/update`) or 180
seconds (`posts/all`).

The token comes from `PINBOARD_API_TOKEN` only; the tool never reads `.env`. It is
never printed: every error message is passed through a redaction that removes the
token, its secret half and any `auth_token=` value, and API errors are re-raised
outside the original exception handler so no traceback can carry the request URL.

Exit codes: 0 done (including "nothing changed"), 1 error, 3 refused by the
five-minute limit.

Other flags: `--data DIR` (default `data/`) and `--raw FILE` (default
`pinboard/posts_all.json`).

## join_issues.py: the Weekly Thing join

```sh
python3 -I tools/join_issues.py
python3 -I tools/join_issues.py --archive DIR --links DIR --out FILE
```

Defaults: `--archive ~/Projects/thingelstad.com/weekly.thingelstad.com/apps/site/archive`
(found relative to this repository), `--links data/links`,
`--out data/derived/issues.json`. It prints a one-line count of issues, link rows,
linked ids and unmatched rows.

Every `*.md` file in the archive is an issue. `archive.njk` and `redirects.njk` are
templates and are not read. For each issue:

- `number` is the front matter `number` as an integer, or `null` when it is not all
  digits (`140-special`). A quoted number (`"352"`) is still a number.
- `slug` is the front matter `slug`, falling back to the file name.
- `title` is `subject` with a leading `WT<n>` and dash (hyphen, en or em dash)
  removed; older subjects (`Weekly Thing #173 / ...`) are kept whole.
- `date` is `publish_date` as written. 61 issues carry microseconds
  (`2021-02-13T16:55:35.260587Z`), and they pass through unchanged.
- `url` is `https://weekly.thingelstad.com` plus the front matter `permalink`
  (`/archive/<n>/`), falling back to `/archive/<file name>/`. It is never built from
  the slug: `/archive/<slug>/` pages are meta-refresh redirects to the permalink.
- `links` keeps the front matter order. A row without a `url` is skipped, so
  `position` counts only the rows kept, from 0. `text`, `section` and
  `heading_context` are copied as strings, or `null` where the front matter has
  `null` (about 2,700 rows have no `heading_context`).

Issues are sorted by `date` then `slug`; two issues with the same slug stop the join.

### Matching an issue link to a saved link

Both URLs are normalised (below) and compared. When several saved links normalise
alike (the saved-twice groups), the choice is:

1. the one saved under exactly the issue's URL;
2. otherwise the one saved most recently at or before the issue's `date`;
3. otherwise the earliest saved.

Rule 1 matters: Jamie often re-saved a link in a different form (`http` then
`https`, or with `?ref=`) years after an issue carried it, and the issue should
point at the bookmark it was made from.

## validate_data.py: the contract check

```sh
python3 -I tools/validate_data.py
python3 -I tools/validate_data.py --data DIR --raw FILE
```

Exit 0 and a summary line when everything holds:

```
validate_data: ok: 16,524 links, 22 years, 354 issues, 6,456 linked ids, 45 unmatched rows; private bookmarks checked against the raw export
```

Exit 1 when anything fails, with each problem on stderr (the first 50, then a
count), and `FAILED with N problem(s)` in the summary line. It checks:

- links: only `<yyyy>.json` files, none empty, each in the canonical format; every
  record has exactly the contract's fields in order; `id` is `md5(url)[:12]` and
  `hash` is `md5(url)`; ids unique across all years; `saved` is
  `YYYY-MM-DDTHH:MM:SSZ` and in the year of its file; records sorted by `saved` then
  `id`; `tags` a list of tags without spaces; `toread` a boolean; `meta` 32 hex.
- private bookmarks: a record with a `shared` field fails. When the raw export
  (`--raw`, default `pinboard/posts_all.json`) is present, any record whose id
  belongs to a bookmark that is not `shared: "yes"` there fails. Messages name the
  id, never the URL. Without the export this check is skipped and the summary says so.
- issues.json: exact fields and order for issues and links, `number` an integer or
  `null` and unique, `slug` unique, `date` an ISO 8601 UTC time, `url` on
  weekly.thingelstad.com, issues sorted by `date` then `slug`, `position` running
  0, 1, 2, ..., every non-null `id` a saved link.
- sync.json (when present): exact fields, stamps well formed, `public` equal to the
  number of records, `total` at least that.
- credentials: every file under `data/` is scanned for `auth_token=`, a run of 20 or
  more hex characters after the word token, a Pinboard `user:HEX` token, and the
  `PINBOARD_API_TOKEN` value when it is set. Messages name the file, line and
  pattern, never the text that matched.

## The front matter reader

`linking/frontmatter.py` reads the YAML front matter between the opening `---` and
the next `---` (or `...`) line, with the standard library only. It covers what the
issue files use and what YAML writers commonly emit:

- block mappings and sequences, including sequences at the same indent as their key;
- plain, single-quoted (`''` is a quote) and double-quoted scalars (all YAML escapes,
  `\x`, `\u` and `\U` included), multi-line folding for all three;
- literal and folded block scalars (`|`, `>`, chomping, explicit indent);
- flow sequences of scalars (`[]`, `[a, 'b']`) and the empty flow mapping `{}`;
- comments, a byte order mark, CRLF line endings.

Every scalar stays a string; only `null`, `Null`, `NULL`, `~` and an empty value
become `None`. Numbers, booleans and dates are never resolved, so the join decides
what `number` means. It refuses, with the file line, anchors, aliases, tags,
duplicate keys, complex keys, nested flow collections, non-empty flow mappings, tabs
in indentation, and text after a closing quote.

Line breaks follow YAML 1.2, as js-yaml 4 (the WT Builder writer) does: only LF and
CR break lines, so U+0085, U+2028 and U+2029 inside a value are ordinary characters.
PyYAML is YAML 1.1 and treats them as breaks; that is the only known difference
between the two on these files. All 354 issue files parse to the same values as
PyYAML.

## URL normalisation, for the TypeScript port

`src/lib/data.ts` reimplements `normalise()` and must agree with
`tools/linking/urls.py` exactly, or the saved-twice pairs and note mentions will not
match the join. The rule (docs/DATA.md) in the order the code applies it:

1. Trim surrounding whitespace (Python `str.strip()`), then split with
   `urllib.parse.urlsplit`, which also deletes every tab, CR and LF anywhere in the
   string. If `urlsplit` raises (an unclosed `[` IPv6 host), the trimmed input is
   the result.
2. Host: the whole netloc lower-cased (userinfo and port included, kept), minus one
   leading `www.`. No IDNA conversion: `bücher.example` and `xn--bcher-kva.example`
   stay different.
3. Scheme: dropped, whatever it is.
4. Path: percent-decoded as UTF-8 (`%2F` becomes `/`; an invalid sequence such as
   `%C3` becomes U+FFFD; a `%` not followed by two hex digits stays), then every
   trailing `/` stripped, then `/` if empty. `+` stays `+`.
5. Query: split on `&` only (`;` is not a separator). A parameter's name is the text
   before its first `=`, or the whole parameter. Drop empty parameters and those
   whose name is exactly `ref`, `source`, `mc_cid`, `mc_eid`, `fbclid` or `gclid`,
   or starts with `utm_`. Names are case-sensitive (`Ref` and `UTM_source` stay).
   Keep the rest in order, as written (not decoded). No `?` when none are left.
6. Fragment: dropped (everything from the first `#`, even a `?` after it).

The result is `host + path + ("?" + query if any)`.

| Input | Normalised |
| --- | --- |
| `  HTTPS://WWW.Example.COM/A/B/  ` | `example.com/A/B` |
| `https://www.www.example.com/` | `www.example.com/` |
| `https://blog.www.example.com/` | `blog.www.example.com/` |
| `https://User:Pw@WWW.Example.com:8080/a` | `user:pw@www.example.com:8080/a` |
| `https://example.com` | `example.com/` |
| `https://lookbusy.app//` | `lookbusy.app/` |
| `https://example.com/a%2Fb%2F` | `example.com/a/b` |
| `https://example.com/caf%C3%A9` | `example.com/café` |
| `https://example.com/%C3` | `example.com/` + U+FFFD |
| `https://example.com/%ZZ` | `example.com/%ZZ` |
| `HTTP://EXAMPLE.COM/%7Euser` | `example.com/~user` |
| `https://example.com/?q=a%20b&r=c+d` | `example.com/?q=a%20b&r=c+d` |
| `https://example.com/a?x=1&&utm_source=t&ref&Ref=y&y=2&` | `example.com/a?x=1&Ref=y&y=2` |
| `https://example.com/a?x=1;utm_source=t` | `example.com/a?x=1;utm_source=t` |
| `https://example.com/a#frag?x=1` | `example.com/a` |
| `www.example.com/a` (no scheme) | `www.example.com/a` (no host, so `www.` stays) |
| `//example.com/a` | `example.com/a` |
| `mailto:jamie@example.com` | `jamie@example.com` |
| `localhost:8080/a` | `8080/a` (`localhost` parses as a scheme) |
| `http://[::1/a` | `http://[::1/a` (unparseable) |

What the current data actually exercises: of 16,524 saved URLs, 59 have a percent
escape in the path, 4 end in `//`, 3 are non-ASCII, 3 have an upper-case host and 1
has a `;` in its query; of 6,510 issue links, 7 have a percent escape and 1 ends in
`//`. None has surrounding whitespace, userinfo, a port or a scheme other than http
or https. A JavaScript port should decode the path byte-wise rather than with
`decodeURIComponent` (which throws on `%C3` and `%ZZ`), and should not use the
WHATWG `URL` class for the host, since it applies IDNA and drops default ports.

Ids are never normalised: `id` is the first 12 hex characters of md5 of the URL's
UTF-8 bytes exactly as saved, so `http://wheregoes.com/` (`5029bebcaf78`) and
`https://wheregoes.com/` (`6d35b392e063`) are two links.

## Enrichment: enrich_hosts.py and enrich_pages.py

Two more commands observe the hosts and pages the links point at and write
`data/enrichment/` (docs/DATA.md, "Enrichment (phase 2)"). Like the others they are
standard library only and run under `python3 -I`; DNS needs `dig` (on macOS by
default). Both are incremental and idempotent: each run picks what has never been
observed, then what is due again, writes through `jsonio` (atomic, and a shard
whose bytes would not change is left alone), and saves its progress every few
records, so an interrupted run loses at most a handful of checks. Neither writes
anywhere but `<data>/enrichment/`, and neither stores a response body.

| Command | Reads | Writes |
| --- | --- | --- |
| `python3 -I tools/enrich_hosts.py` | `data/links/`, DNS, the hosts' home pages, RDAP | `data/enrichment/hosts/<a-z0-9>.json` |
| `python3 -I tools/enrich_pages.py` | `data/links/`, the saved URLs, the Wayback CDX API | `data/enrichment/pages/<yyyy>.json` |

Every run loads all existing shards first. A record whose host or id is no longer
in the public links is dropped (a bookmark made private takes its observations
with it), and a record in the wrong shard is moved. Both end with a one-line
summary and exit 0 when the run finished, 1 on an error, an interrupt, or a
Wayback refusal. `--dry-run` prints the selection, one line per host or link with
the reason it was chosen, and makes no request and writes nothing. `--data DIR`
works as for the other tools.

### enrich_hosts.py

```sh
python3 -I tools/enrich_hosts.py --min-links 25        # the 69 hosts with 25+ links
python3 -I tools/enrich_hosts.py --only tuaw.com,gigaom.com
python3 -I tools/enrich_hosts.py --limit 500            # a nightly slice
python3 -I tools/enrich_hosts.py --dry-run
```

The host set is the site's rule (`hostOf` in `src/lib/normalize.ts`): the URL's
host, lower case, without user info, minus one leading `www.`. 7,064 hosts today.

Selection: hosts with no record first, most links first; then hosts whose record
is at least `--recheck-after DAYS` old (default 30), oldest first. `--min-links N`
keeps hosts with at least N links, `--only HOST` (repeat or comma-separate) checks
the named hosts whatever their state, `--limit N` caps the run.

Per host:

- **DNS**: one `dig +noall +answer +comments` with five queries (A, AAAA, CNAME, NS,
  MX). That is the typed form of `dig +short`: the same answers with owner and
  type kept, so a CNAME target is never read as a name server. `a` and `aaaa` are
  every address after any CNAME chain, sorted; `cname` is the host's own target;
  `ns` is the NS records owned by the host itself, so it is empty for a name that
  is not a zone apex (`blog.example.com` under `example.com`); `mx` is whether a
  mail server is named (a null MX, `0 .`, is not one). `resolves` is false when A
  and AAAA are both empty, and `error` is added when the A query did not come back
  NOERROR (`NXDOMAIN`, `SERVFAIL`, `TIMEOUT`). A host that is an IP address is
  recorded without a lookup.
- **HTTPS**: a GET of `https://<host>/`, redirects walked as for pages, no body
  read. `reachable` is whether an HTTP response came back, `status` is that
  response's status after redirects, and `error` says why when it is not
  reachable (`tls: certificate has expired`, `timeout`). `redirects_http` is
  whether `http://<host>/` redirects and its chain reaches an https URL. A host
  that does not resolve gets no request.
- **RDAP**, for hosts with at least `--rdap-min-links N` links (default 5,
  DIRECTION.md's 428 hosts) and no answer younger than `--rdap-recheck-after DAYS`
  (default 90): `https://rdap.org/domain/<domain>`, redirected to the registry.
  The domain is the obvious one first (the last two labels, or three under a
  two-level suffix such as `co.uk` in `TWO_LEVEL_SUFFIXES` in `linking/rdap.py`),
  then longer names from the full host down, until the registry answers. Answers
  are cached per domain for the run, so `blog.cloudflare.com` and `cloudflare.com`
  cost one call, and a top-level domain without RDAP is asked once. `registrar` is
  the vCard name of the entity with the registrar role, `registered` and `expires`
  the dates of the registration and expiration events (UTC, `YYYY-MM-DD`),
  `status` and `nameservers` lower case and sorted. When there is no answer,
  `rdap` is `null` and `rdap_error` says why: `no RDAP service for .mn` (rdap.org
  knows no server for the top-level domain), `refused: <server> answered HTTP 403`,
  or `not found at <server>`. A `null` is asked again on the next check; a found
  answer keeps its own `checked` and is reused until it is 90 days old.
  `--no-rdap` skips RDAP and keeps whatever answer the record had.

The summary counts hosts checked, alive (resolves and answers over https or
http), dead, and RDAP answers found.

### enrich_pages.py

```sh
python3 -I tools/enrich_pages.py --no-wayback --limit 2000    # liveness, a nightly slice
python3 -I tools/enrich_pages.py --wayback-only --limit 400   # Wayback, 40 minutes at the pace
python3 -I tools/enrich_pages.py --sample 150 --no-wayback    # a spread across every year
python3 -I tools/enrich_pages.py --year 2009 --dry-run
python3 -I tools/enrich_pages.py --ids 8b8dc6b42f12,5029bebcaf78
```

Selection: links never observed first, in saved order; then links due again by
`checked`: a dead page after 30 days, a live one after 90 (`--recheck-after DAYS`
replaces both). `--year YYYY` keeps one year, `--ids` (repeat or comma-separate)
picks links whatever their state, `--sample N` takes N spread evenly across the
years (an equal share per year, the remainder to the busiest years, evenly spaced
within a year, the same picks every time for the same state), `--limit N` caps
the run. `--wayback-only` selects links that already have a liveness record and no
Wayback answer, then Wayback answers older than 90 days; `--no-wayback` skips
Wayback. With neither, each selected link gets both.

**Liveness** is one GET of the URL as saved, with a 15 second timeout. Redirects
are walked by the tool, up to five, so the chain is recorded: `redirects` is a
list of `{"status", "url"}`, one per hop, `url` being where that hop pointed.
At most 256 KB of a 2xx body is read and then dropped; redirect and error bodies
are not read. `alive` is true when the chain ends in a 2xx. Otherwise `error`
says why: `HTTP 404`, `HTTP 403 (DataDome)`, `more than 5 redirects`,
`redirect to a non-web URL`, `dns: name does not resolve`, `timeout`,
`tls: ...`, `connection refused`. `status` is the last response's, `null` when
none came back; `final_url` is the URL of the last request; `content_type` is the
media type without parameters. Cookies set during a chain are kept for that
chain only, as a browser would, so a cookie-check redirect does not loop. A 403,
a 429 or a 999 (LinkedIn) is often a bot wall rather than a dead page. When the
response says so in a header, the error names it: `(Cloudflare challenge)` for
`cf-mitigated: challenge`, `(Vercel challenge)` for `x-vercel-mitigated:
challenge`, `(DataDome)` for `x-datadome: protected` (`BOT_WALLS` in
`linking/web.py`). Otherwise the record says what the server answered and the
reader decides.

Recorded URLs have the values of credential-looking query parameters blanked
(`token`, `signature`, `session`, `X-Amz-*` and similar become `REDACTED`),
because a redirect can land on a signed or session URL and `data/` is public.

**Wayback** is one CDX request per link,
`https://web.archive.org/cdx/search/cdx?url=<url>&output=json&fl=timestamp&limit=10000`:
the capture timestamps oldest first, so `first`, `last` and `count` come from one
answer. Only a URL with 10,000 captures or more (a busy home page) costs a second
request (`limit=-1`) for the true latest, and then `count` is 10,000 with
`count_capped: true`. `wayback` has its own `checked`. A link that has never been
captured gets `{"first": null, "last": null, "count": 0}`. A 429 that survives the
retry, or a refused or reset connection, ends Wayback lookups for the run (the
archive blocks an IP that keeps going) and the run exits 1; liveness carries on.

The summary counts links checked, alive, dead, and Wayback lookups made, with
captures, and failed. A `--wayback-only` run says `liveness skipped` and how many
links it selected.

### Pacing and manners

Every request is a GET with `User-Agent: LinkingThings/0.1 (+https://links.thingelstad.xyz)`
and a 15 second timeout (30 for the CDX API). Requests to one host are at least
one second apart, counted from the end of the previous one; DNS lookups are one a
second; the Wayback Machine gets six seconds. A 429 or 5xx is retried once, after
10 seconds (60 for the archive, or a longer `Retry-After` up to a minute), never
more, and not at all when a named bot wall sent it, since a challenge answers the
same way ten seconds later. A host that resolves to a private, loopback, link-local or otherwise
non-public address is never fetched, including as a redirect target. The tools
fetch nothing but the URL being checked and its redirects, the hosts' home pages,
the RDAP endpoints, and the CDX API. These are floors: runs are sequential, so
real spacing is longer.

### What a missing record means

Not yet observed, never dead. The same holds for a missing part: a host record
without `rdap` was not asked (fewer links than `--rdap-min-links`), and a page
record without `wayback` has not been looked up. `rdap: null` with `rdap_error`
is an answer (no service, a refusal, not found), and a page with `alive: false`
says why in `error`.

### A full pass, and keeping it fresh

Measured on 2026-10-23 from this Mac, sequential, at the pacing above:

| Run | Sample | Time | Rate |
| --- | --- | --- | --- |
| `enrich_hosts.py --min-links 25` | 69 hosts, with RDAP | 287 s | 4.2 s a host |
| `enrich_pages.py --sample 150 --no-wayback` | 150 links, 2005 to 2026 | 423 s | 2.8 s a link |
| `enrich_pages.py --wayback-only --sample 20` | 20 links | 134 s | 6.7 s a link |

So a first pass over everything takes roughly:

| Pass | Count | Estimate |
| --- | --- | --- |
| Hosts, DNS and HTTPS | 7,064 hosts | 6 to 9 hours (about 3.2 s a host once RDAP is taken out; DNS pacing alone is 2 hours, and a dead host can spend 30 s in two timeouts) |
| RDAP | 428 hosts with 5+ links | about 10 more minutes |
| Page liveness | 16,524 links | 13 to 15 hours |
| Wayback | 16,524 links | about 31 hours (the six second pace is the floor) |

None of that needs to happen in one sitting. Every run saves as it goes and the
next run picks up what is left, so the first pass fits in slices:

```sh
python3 -I tools/enrich_hosts.py --limit 1000                # about an hour; 8 nights
python3 -I tools/enrich_pages.py --no-wayback --limit 2000   # about 95 minutes; 9 nights
python3 -I tools/enrich_pages.py --wayback-only --limit 800  # about 90 minutes; 21 nights
```

Run the three one after another, not side by side: they would share a home IP,
and the Wayback Machine in particular blocks an address that keeps going. A
Wayback refusal stops that run with exit 1; leave it a day before the next.

After the first pass the cadence is the recheck windows: hosts every 30 days
(about 235 a day), RDAP every 90 days, dead pages every 30 days and live pages
every 90 (about 270 a day at the sample's three quarters alive), Wayback every 90
days (about 185 a day). The same three commands with the same limits then finish
in well under an hour a night, most of it Wayback.
