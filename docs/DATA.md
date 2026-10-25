# Data contract

What the site reads, who writes it, and the rules. `docs/DIRECTION.md` has the why.
Every file under `data/` is public, generated, and never edited by hand.

## `data/links/<yyyy>.json`

One file per year of saving, a JSON array sorted by `saved` then `id`. Public
bookmarks only (`shared: yes` at Pinboard); private ones never enter the repository.

| Field | Type | From Pinboard | Rule |
| --- | --- | --- | --- |
| `id` | string, 12 hex | `hash[:12]` | md5 of `url` exactly as saved, first 12 hex characters. Unique. The permalink is `/links/<id>/`. |
| `hash` | string, 32 hex | `hash` | md5 of `url`. |
| `url` | string | `href` | Exactly as saved. Never normalised here. |
| `title` | string | `description` | May equal the URL for a handful of old saves. |
| `note` | string | `extended` | Markdown-ish text, may be empty. Jamie's commentary; a passage from the page is a `>` blockquote (the pre-2017 bookmarklet excerpts were quoted at the source on 2026-10-24). |
| `saved` | string | `time` | ISO 8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`. Display in US Central. |
| `tags` | string[] | `tags` split on spaces | Today only WT Builder's filing marks: `_brief`, `_feature`, `_local`, `_exclude`. |
| `toread` | boolean | `toread` | |
| `meta` | string, 32 hex | `meta` | Pinboard's change signature; differs when the bookmark was edited. |

Writer: `tools/sync.py` (Pinboard API: `posts/update`, then `posts/all` only when the
update stamp moved; at most one `posts/all` per five minutes; token from
`PINBOARD_API_TOKEN`, never printed). `tools/validate_data.py` fails on a private
bookmark, an unknown field, a bad id, or a duplicate.

## `data/derived/issues.json`

The join to The Weekly Thing, written by `tools/join_issues.py` from the issue files
at `~/Projects/thingelstad.com/weekly.thingelstad.com/apps/site/archive/<n>.md`
(front matter `number`, `subject`, `publish_date`, `links`). Twenty-one issues of 2017
and 2018 (WT32 to WT52) were imported into WT Builder as plain text and list no links in
front matter; for an issue whose front matter lists none, the rows are the link items of
the body instead: every Markdown link that is a whole line (with or without a heading
marker) under its `##` section, leaving out Jamie's own posts on thingelstad.com and
the photo files. Two issues (WT213 on Ukraine, WT322 from Banff) really have no links.

```json
{
  "source": "weekly.thingelstad.com archive front matter, or the issue body where the front matter lists no links",
  "issues": [
    {
      "number": 350,
      "slug": "350",
      "title": "Builders Puzzlers And Agents",
      "subject": "WT350 — Builders Puzzlers And Agents",
      "date": "2026-09-19T12:00:00Z",
      "url": "https://weekly.thingelstad.com/archive/350/",
      "links": [
        {
          "position": 0,
          "id": "8b8dc6b42f12",
          "url": "https://example.com/post",
          "text": "The link text in the issue",
          "section": "Notable",
          "heading_context": "Notable"
        }
      ]
    }
  ]
}
```

`id` is the Pinboard link matched by normalised URL, or `null` when the issue link
is not in Pinboard (45 rows today: tracking-parameter variants, mobile hosts,
Jamie's own sites). When several saved links normalise to the same key, the
tie-break is: an exact saved URL wins, then the latest link saved at or before the
issue date, then the earliest saved. `position` is the link's order in the issue.
`text`, `section` and `heading_context` are strings or `null`, never the string
"null". Field order per issue is `number, slug, title, subject, date, url, links`.
`slug` is the archive path segment and `number` is `null` for the one special issue
(slug `special-thing-140-matching-donations-to-second`). `date` is the front
matter's `publish_date` as written, which may carry fractional seconds. `url` is the
issue's `permalink` on weekly.thingelstad.com (`/archive/<n>/`, and
`/archive/140-special/` for the special issue; slug paths there are redirects), not
Buttondown. Issues are sorted by `date` then `slug`.

## URL normalisation (for joins only)

Used to match an issue link, a note mention, or an archived page's outbound link to
a saved URL. Never used to form an id.

1. Lower-case the host; drop a leading `www.`.
2. Drop the scheme.
3. Percent-decode the path; drop a trailing slash (an empty path becomes `/`).
4. Drop query parameters whose name starts with `utm_`, and `ref`, `source`,
   `mc_cid`, `mc_eid`, `fbclid`, `gclid`; keep the rest in their original order.
5. Drop the fragment.

Both sides are normalised the same way. When saved URLs normalise alike (43 groups
today: 41 pairs and 2 triples, differing by scheme, www, trailing slash, percent
escape, fragment, query or host case), every record exists and each lists the
others as "saved twice". `tools/README.md` has the edge-case table (byte-wise UTF-8
decoding of the path, no IDNA on the host) that the TypeScript port must match.

## Derived at build, not stored

`src/lib/data.ts` is the only module that reads `data/` and the only place URLs are
formed. It derives, in memory: host per link (normalised host), year, whether the
note is empty, the appearances index (id to issues), same-week neighbours, note
mentions (URLs inside notes resolved to ids), and the saved-twice pairs. Hosts,
years and issues get pages from these; nothing of that is written back to `data/`.

## Enrichment (phase 2)

Observations about hosts, pages and special hosts, sharded so git stays sane: hosts
by the first character of the host name, pages and facts by the year the link was
saved. Each shard is a JSON object keyed by host or id, top-level keys sorted,
fields inside a record in the order shown here, indent 1, trailing newline; a
shard with no records has no file. Every record carries `checked` (UTC), `method`
and `version`; a reader treats a missing record as "not yet observed", never as
"dead". A record whose key is no longer a public link or a host of one is dropped
on the next run, so a bookmark that turns private leaves no trace here (and its
images leave `public/media/`). Hosts are keyed as saved; a host outside a-z0-9 (an
internationalised name) would be keyed by its punycode form (none exist today).
Nothing here holds a page body or an excerpt of one.

`tools/validate_data.py` checks every shard: the file name, the canonical format
and sorted keys; every key a public host or link id, filed in the shard its key
belongs to (the host's first character, or the year its link was saved); only the
fields below, in order, with their types; no liveness field on a Wayback-only
record; no string longer than 2,000 characters; every `image` a file that exists
under `public/media/`, and no file there that no facts record names.

`data/enrichment/hosts/<a-z0-9>.json`, written by `tools/enrich_hosts.py`:

```json
{
  "macstories.net": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "enrich_hosts",
    "version": 2,
    "dns": { "resolves": true, "a": ["1.2.3.4"], "aaaa": [], "cname": null, "ns": ["ns1.example.net"], "mx": true },
    "https": { "reachable": true, "redirects_http": true, "status": 200 },
    "home": {
      "checked": "2026-10-24T02:00:00Z",
      "title": "MacStories",
      "generator": "WordPress 6.8",
      "feeds": [{ "type": "rss", "url": "https://www.macstories.net/feed/", "title": "MacStories" }],
      "hcard": false,
      "rel_me": ["https://mastodon.social/@macstories"],
      "webmention": null
    },
    "rdap": {
      "domain": "macstories.net",
      "registrar": "Example Registrar",
      "registered": "2009-03-01",
      "expires": "2027-03-01",
      "status": ["client transfer prohibited"],
      "nameservers": ["ns1.example.net"],
      "checked": "2026-10-24T02:00:00Z"
    }
  },
  "gone.example": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "enrich_hosts",
    "version": 2,
    "dns": { "resolves": false, "a": [], "aaaa": [], "cname": null, "ns": [], "mx": false, "error": "NXDOMAIN" },
    "https": { "reachable": false, "redirects_http": false, "status": null, "error": "does not resolve" },
    "home": {
      "checked": "2026-10-24T02:00:00Z",
      "title": null,
      "generator": null,
      "feeds": [],
      "hcard": false,
      "rel_me": [],
      "webmention": null,
      "error": "does not resolve"
    }
  }
}
```

DNS from `dig +noall +answer`, parsed by record type (`+short` loses the type), for
A, AAAA, CNAME, NS and MX; stdlib `socket` is only A/AAAA. `ns` is empty for a host
that is not a zone apex. `dns` and `https` carry `error` (a string, or absent) when
the lookup or the request failed; `https.error` names a bot wall when the headers
show one (`cf-mitigated`, `x-vercel-mitigated: challenge`, `x-datadome`).
RDAP through the bootstrap redirector `https://rdap.org/domain/<domain>`, which
302s to the registry; `domain` is the registrable domain of the host (strip labels
from the left until RDAP answers, cache the answer per domain; a small list of
two-level public suffixes such as `co.uk` avoids wasted calls). Pace one request a
second per service with a User-Agent naming the site. `rdap` is `null` when the
registry has no RDAP (some country codes) and the reason is in `rdap_error`; a host
with too few links for RDAP has neither field.
Rechecks: DNS, HTTPS and home every 30 days, RDAP every 90, by `checked`.

`home` (version 2, 2026-10-23) is the host's open-web signals, read from the same
`https://<host>/` GET as `https` (one request; at most 256 KB read, parsed with the
standard library's `html.parser`, the body never stored). Always present in version
2, with exactly these fields:

- `checked`: the record's own `checked`.
- `title`: the first `<title>` outside an `<svg>`, whitespace collapsed, at most 300
  characters, or `null`.
- `generator`: `<meta name="generator">`, the same way, or `null`.
- `feeds`: each `<link rel="alternate">` whose type is `application/rss+xml`
  (`rss`), `application/atom+xml` (`atom`) or `application/feed+json` (`json`), as
  `{type, url, title}` with `url` absolute and `title` a string or `null`; repeats
  dropped, at most 20. Plain `application/json` is not a feed (WordPress uses it
  for its REST API).
- `hcard`: whether any element has the class `h-card`.
- `rel_me`: the absolute URLs of `rel="me"` on `<link>` and `<a>`, repeats dropped,
  at most 50.
- `webmention`: the first Webmention endpoint, the HTTP `Link` header's before the
  HTML's (`rel="webmention"` on `<link>` or `<a>`), absolute, or `null`.
- `error`, only when the page could not be read: the request's error (as in
  `https.error`), `not HTML (<type>)`, `empty body`, `unparseable (<exception>)` or
  `does not resolve`. The other fields are then empty, except a `webmention` from
  the `Link` header.

Every URL is absolute against `<base href>` or the final URL, http or https only,
at most 2,000 characters, with credential-looking query values blanked. A version 1
record (no `home`) is due on the next run.

`data/enrichment/pages/<yyyy>.json`, written by `tools/enrich_pages.py`:

```json
{
  "8b8dc6b42f12": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "enrich_pages",
    "version": 1,
    "status": 200,
    "alive": true,
    "final_url": "https://www.amitgawande.com/blog/2026/the-fuzzy-mind/",
    "redirects": [{ "status": 301, "url": "https://www.amitgawande.com/blog/2026/the-fuzzy-mind/" }],
    "content_type": "text/html",
    "wayback": { "first": "2026-07-01T10:11:12Z", "last": "2026-10-01T00:00:00Z", "count": 4, "checked": "2026-10-24T02:00:00Z" }
  },
  "b026db6b27cc": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "enrich_pages",
    "version": 1,
    "wayback": { "first": "2005-03-02T01:02:03Z", "last": "2026-10-20T00:00:00Z", "count": 10000, "count_capped": true, "checked": "2026-10-24T02:00:00Z" }
  }
}
```

A record is either a liveness record (`status`, `alive`, `final_url`, `redirects`,
`content_type`, `error` when there is one, then `wayback` once looked up) or a
Wayback-only record: `checked` (the time of the lookup), `method`, `version` and
`wayback`, nothing else, never a liveness field. Liveness stays in the tool and the
contract but is not run for the site (Jamie, 2026-10-23: "You don't need to
validate the links. They just are."); the nightly job writes Wayback-only records.

`alive` is true for a 2xx or 3xx that ends in a 2xx; a 4xx, 5xx, DNS failure or
timeout is false with the reason in `error` (`HTTP 404`, `dns: name does not
resolve`, `timeout`, `tls: self-signed certificate`). A bot wall is named in the
error (`HTTP 403 (DataDome)`, `HTTP 429 (Vercel challenge)`) and is not retried; the
site treats a named wall as unknown, never as dead. Each `redirects` item is the
hop's `status` and the `url` it pointed at. A redirect that lands on a 2xx counts as
alive even when it reaches a home page or another host; the site decides at build
time, from `final_url`, how to show that (open). GET with a 15 second timeout,
redirects walked by hand up to five hops, never more than 256 KB downloaded, no
response body stored, credential-looking query values blanked, non-public
addresses refused. Wayback from the CDX API in one query
(`https://web.archive.org/cdx/search/cdx?url=<url>&fl=timestamp&limit=10000`, and
`limit=-1` only when that cap is hit, recorded as `count_capped: true`, absent
otherwise) at a six-second pace, because bursts get the IP blocked (learned on
thingelstad.xyz); `count` covers every capture status and the http, https and www
forms; `first` and `last` are `null` when there are no captures. A failed lookup
writes nothing. Rechecks: dead pages every 30 days, live ones every 90, Wayback
every 90 (by `wayback.checked`). The host, facts and Wayback runs go one after
another, never in parallel, because they share one address. `tools/README.md` has
the full-pass estimates and the nightly slices.

`data/enrichment/facts/<yyyy>.json`, written by `tools/enrich_facts.py`: facts from
the APIs of special hosts, keyed by link id and filed by the year the link was
saved, for the links one adapter (`tools/linking/adapters/<method>.py`) applies to.

```json
{
  "02088718eb1b": {
    "checked": "2026-10-24T01:16:04Z",
    "method": "youtube",
    "version": 1,
    "kind": "video",
    "video_id": "m6cDErtCKAc",
    "provider": "youtube",
    "title": "iPhone 18 Pro: A Photographer's Review",
    "author": "Tyler Stalman",
    "author_url": "https://www.youtube.com/@stalman",
    "image": "/media/youtube/m6cDErtCKAc.jpg"
  },
  "6f5e4d3c2b1a": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "github",
    "version": 1,
    "kind": "repository",
    "error": "HTTP 404"
  }
}
```

Every record is `checked`, `method`, `version`, `kind`, then either the method's
fields, in this order, or `error` alone (a string: `HTTP 404`, `timeout`, `the
answer is not JSON`). Text fields are whitespace-collapsed strings of at most 500
characters, or `null`; URL fields are http(s) URLs or `null`.

| `method` (`kind`)          | Applies to                                                                                                                       | Fields after `kind`                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `youtube` (`video`)        | `youtube.com`, `m.`, `youtube-nocookie.com`, `youtu.be`: `watch?v=`, `watch_popup?v=`, `/embed/`, `/shorts/`, `/v/`, `/live/` | `video_id`, `provider` (`youtube`), `title`, `author`, `author_url`, `image`, from oEmbed                         |
| `vimeo` (`video`)          | `vimeo.com/<id>` and its `/m/`, `/channels/`, `/album/`, `/groups/` forms, `player.vimeo.com/video/<id>`                         | the same, `provider` `vimeo`, from oEmbed                                                                        |
| `github` (`repository`)    | `github.com/<owner>/<repo>` (two path segments, not a GitHub section such as `/blog/` or `/features/`); `gist.github.com/<id>`  | repository: `full_name`, `description`, `language`, `stars`, `license` (SPDX id), `archived`, `pushed`, `homepage`, `fork`; gist: `full_name` (`gist/<id>`), `description`, `files` (names, at most 50), `language` (the first file's) |
| `wikipedia` (`article`)    | `<lang>.wikipedia.org/wiki/<title>` and `<lang>.m.`                                                                              | `title`, `description` (the page's short description), `lang`, `url`, from the REST summary; never the extract or a thumbnail |
| `openlibrary` (`book`)     | Amazon product URLs whose ASIN is an ISBN-10 (`/dp/`, `/gp/product/`, `/exec/obidos/ASIN/`)                                      | `isbn`, `title`, `authors` (at most 5 names), `published` (as Open Library writes it), `image`, `openlibrary_url` |

`stars` is a count or `null`; `archived` and `fork` are booleans; `pushed` is
GitHub's UTC stamp. `image` is `/media/<youtube|vimeo|books>/<id>.jpg`, a site path:
the file is `public/media/...` in the repo and is served at `/media/...`. It is
`null` when the image could not be had (no image, not a JPEG, over 1 MB). Images
are saved once and never overwritten; a file no record names any more is removed
by the next run, so `public/media/` is written only by `tools/enrich_facts.py`
and holds exactly the images the facts records name. GitHub calls use the token in
`GITHUB_TOKEN` when it is set (5,000 requests an hour instead of 60), and only to
`api.github.com`; a rate limit stops the method for the run and records nothing.
Rechecks: every 90 days, an error after 30, and at once when the record's method
or version is not the adapter's. A request that times out or gets a 429 or 5xx
keeps the record's earlier facts.

Later derived files, each with `method` and `version`: `data/derived/topics.json`,
`data/derived/neighbors.json`.
