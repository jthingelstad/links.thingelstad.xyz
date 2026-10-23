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
