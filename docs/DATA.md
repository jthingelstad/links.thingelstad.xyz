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
| `note` | string | `extended` | Markdown-ish text, may be empty. From 2007 to 2011 mostly a page excerpt, later Jamie's commentary. |
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

Observations about hosts and pages, sharded so git stays sane: hosts by the first
character of the host name, pages by the year the link was saved. Each shard is a
JSON object keyed by host or id, top-level keys sorted, fields inside a record in
the order shown here, indent 1, trailing newline. Every record carries `checked`
(UTC), `method` and `version`; a reader treats a missing record as "not yet
observed", never as "dead". A record whose key is no longer a public link or a host
of one is dropped on the next run, so a bookmark that turns private leaves no trace
here. Hosts are keyed as saved; a host outside a-z0-9 (an internationalised name)
would be keyed by its punycode form (none exist today). `tools/validate_data.py`
does not check these shards yet.

`data/enrichment/hosts/<a-z0-9>.json`, written by `tools/enrich_hosts.py`:

```json
{
  "macstories.net": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "enrich_hosts",
    "version": 1,
    "dns": { "resolves": true, "a": ["1.2.3.4"], "aaaa": [], "cname": null, "ns": ["ns1.example.net"], "mx": true },
    "https": { "reachable": true, "redirects_http": true, "status": 200, "error": null },
    "rdap": {
      "domain": "macstories.net",
      "registrar": "Example Registrar",
      "registered": "2009-03-01",
      "expires": "2027-03-01",
      "status": ["client transfer prohibited"],
      "nameservers": ["ns1.example.net"],
      "checked": "2026-10-24T02:00:00Z"
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
registry has no RDAP (some country codes) and the reason is in `rdap_error`.
Rechecks: DNS and HTTPS every 30 days, RDAP every 90, by `checked`.

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
    "wayback": { "first": "2026-07-01T10:11:12Z", "last": "2026-10-01T00:00:00Z", "count": 4, "count_capped": false, "checked": "2026-10-24T02:00:00Z" }
  }
}
```

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
`limit=-1` only when that cap is hit, recorded as `count_capped`) at a six-second
pace, because bursts get the IP blocked (learned on thingelstad.xyz); `count`
covers every capture status and the http, https and www forms. Rechecks: dead
pages every 30 days, live ones every 90, Wayback every 90, by `checked`. The host,
page and Wayback runs go one after another, never in parallel, because they share
one address. `tools/README.md` has the full-pass estimates (about 8 h, 14 h and
31 h) and the nightly slices.

Later derived files, each with `method` and `version`: `data/derived/topics.json`,
`data/derived/neighbors.json`.
