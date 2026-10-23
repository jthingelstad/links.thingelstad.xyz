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
(front matter `number`, `subject`, `publish_date`, `links`).

```json
{
  "source": "weekly.thingelstad.com archive front matter",
  "issues": [
    {
      "number": 350,
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
Jamie's own sites). `position` is the link's order in the issue. Each issue also
carries `slug` (the archive path segment); `number` is `null` for the one special
issue (`special-thing-140-matching-donations-to-second`). Issues are sorted by
`date` then `slug`; `url` is the issue on weekly.thingelstad.com, not Buttondown.

## URL normalisation (for joins only)

Used to match an issue link, a note mention, or an archived page's outbound link to
a saved URL. Never used to form an id.

1. Lower-case the host; drop a leading `www.`.
2. Drop the scheme.
3. Percent-decode the path; drop a trailing slash (an empty path becomes `/`).
4. Drop query parameters whose name starts with `utm_`, and `ref`, `source`,
   `mc_cid`, `mc_eid`, `fbclid`, `gclid`; keep the rest in their original order.
5. Drop the fragment.

Both sides are normalised the same way. When two saved URLs normalise alike (44
pairs today, scheme or www only), both records exist and each lists the other as
"saved twice".

## Derived at build, not stored

`src/lib/data.ts` is the only module that reads `data/` and the only place URLs are
formed. It derives, in memory: host per link (normalised host), year, whether the
note is empty, the appearances index (id to issues), same-week neighbours, note
mentions (URLs inside notes resolved to ids), and the saved-twice pairs. Hosts,
years and issues get pages from these; nothing of that is written back to `data/`.

## Enrichment (phase 2)

Observations about hosts and pages, sharded so git stays sane: hosts by the first
character of the host name, pages by the year the link was saved. Each shard is a
JSON object keyed by host or id with sorted keys, indent 1, trailing newline. Every
record carries `checked` (UTC), `method` and `version`; a reader treats a missing
record as "not yet observed", never as "dead".

`data/enrichment/hosts/<a-z0-9>.json`, written by `tools/enrich_hosts.py`:

```json
{
  "macstories.net": {
    "checked": "2026-10-24T02:00:00Z",
    "method": "enrich_hosts",
    "version": 1,
    "dns": { "resolves": true, "a": ["1.2.3.4"], "aaaa": [], "cname": null, "ns": ["ns1.example.net"], "mx": true },
    "https": { "reachable": true, "redirects_http": true, "status": 200 },
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

DNS from `dig +short` (A, AAAA, CNAME, NS, MX; stdlib `socket` is only A/AAAA).
RDAP through the bootstrap redirector `https://rdap.org/domain/<domain>`, which
302s to the registry; `domain` is the registrable domain of the host (strip labels
from the left until RDAP answers, cache the answer per domain; a small list of
two-level public suffixes such as `co.uk` avoids wasted calls). Pace one request a
second per service with a User-Agent naming the site. `rdap` is `null` when the
registry has no RDAP (some country codes) and the reason is recorded.

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
    "redirects": [],
    "content_type": "text/html",
    "wayback": { "first": "2026-07-01T10:11:12Z", "last": "2026-10-01T00:00:00Z", "count": 4, "checked": "2026-10-24T02:00:00Z" }
  }
}
```

`alive` is true for a 2xx or 3xx that ends in a 2xx; a 4xx, 5xx, DNS failure or
timeout is false with the reason in `error`. GET with a 15 second timeout, follow
up to five redirects, never download more than 256 KB. Wayback from the CDX API
(`https://web.archive.org/cdx/search/cdx?url=<url>&output=json&limit=1` and the
same with `&limit=-1` for the latest) at a six-second pace, because bursts get the
IP blocked (learned on thingelstad.xyz). Recheck dead pages monthly, live ones
quarterly, by `checked`.

Later derived files, each with `method` and `version`: `data/derived/topics.json`,
`data/derived/neighbors.json`.
