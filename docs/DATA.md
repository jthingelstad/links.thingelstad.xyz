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

Later files, each with a `method` and `version` field, each with its own writer:
`data/enrichment/hosts/<host>.json` (DNS, RDAP, liveness), `data/enrichment/pages/<id>.json`,
`data/derived/topics.json`, `data/derived/neighbors.json`, `data/derived/stats.json`.
