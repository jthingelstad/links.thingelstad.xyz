# Direction: Linking Things (links.thingelstad.xyz)

Written 2026-10-23, the first session on this project, before any code. Everything
measured below was measured that day against the live Pinboard export
(`pinboard/posts_all.json`, fetched 2:52 PM Central) and the sibling repos on this Mac.

## What it is

**Linking Things** (the name, Jamie, 2026-10-23). Every link Jamie has saved since
2005, as a public, searchable, connected database.
One permalink per link. Search that feels like a private Google over twenty-one years
of curation. Topics and hosts to browse by. Every link knows where else it appears
(a Weekly Thing issue, a blog post, a podcast episode), what Jamie wrote about it,
what it points at and what points at it. Machine interfaces (JSON, Markdown,
`llms.txt`, a feed, a SQLite file) beside every human page. An homage to the
hyperlink.

This is the fourth run at the idea, and the first with the whole corpus and a
real connection layer:

- **links_thing (2012)**: a Semantic MediaWiki bookmarking wiki, nearly 4,000
  links imported from Pinboard, with calendar, video and statistics views; gone by 2015.
- **Link Thing (2017 to 2021)**: a Jekyll (later Blot) link blog at
  links.thingelstad.com, posts written from the Pinboard API, Lunr.js search over
  9,000 links, index pages per site, comments; gone after December 2021.
- Jamie, Weekly Thing 274 (January 2024): "I may create a link blog again in the
  future, but if I did I want it to not be blog-date-centric but instead
  content-keyword-search centric."
- Jamie, "How I Find Links for the Weekly Thing" (October 2023): "That link is now
  in link archive permanently. To me this feels like an ever growing database of
  knowledge. I'd love to do more with this database."

The earlier two were blogs with a date spine. This one has a search spine and a
graph. That is the difference to protect.

## Settled with Jamie, 2026-10-23

- **Serving costs nothing and runs nothing.** Static files on S3 and CloudFront; no
  server, no database and no model call answers a visitor. Search is Pagefind in the
  browser. Model cost is welcome at ingestion and build time (topics, neighbours,
  excerpts). The conversational layer is Thingy and the Librarian, not this site.
- **The Librarian ingests this site** as another source, the way it ingests Things
  I've built. The link becomes the unit the Librarian reasons with; the Weekly Thing
  as a source is mostly subsumed by the blog and the links as specific units, and the
  Weekly Thing stays indexed too (section "The Librarian").
- **Tinylytics is on this site, with public Kudos on every link** (the name, Jamie,
  2026-10-23: "let's use that name instead of like"), the count shown the way
  Tinylytics shows it.
- **RSS and JSON Feed** for the site, every host and every topic.

## What we have (measured 2026-10-23)

| Fact | Value |
| --- | --- |
| Bookmarks | 16,882, first 2005-08-02, latest 2026-10-23 |
| Public (`shared: yes`) | 16,524; private 358 (never published) |
| With a note (`extended`) | 13,075 (77%), median 243 characters, longest 23,492 |
| Notes with Markdown links inside | 1,715; 1,793 notes carry a bare URL |
| Tags | Four only: `_brief` 2,601, `_feature` 402, `_local` 25, `_exclude` 18. No topic tags survive. 13,836 bookmarks are untagged. |
| Distinct hosts | 7,259 (www stripped); 5,959 hosts have exactly one link |
| Top hosts | youtube.com 302, medium.com 266, github.com 256, macstories.net 239, nytimes.com 208 |
| Scheme | 6,901 saved as `http://` (41%), 9,981 as `https://` |
| Near-duplicate URLs | 43 groups (41 pairs, 2 triples) differ by scheme, www, trailing slash, escape, fragment or case |
| In a Weekly Thing issue | 6,465 links (39% of all; 41% to 87% of each year since 2017) |
| In two or more issues | 0. A link featured again was always saved again under another URL form |
| Note links to another saved link | 202 edges from 190 notes; 226 note links go to Jamie's own sites |
| Hosts that no longer resolve | 21 of a random 300 (7%), carrying 22 of those hosts' 568 links |
| `hash[:12]` unique | Yes, across all 16,882, so Pinboard's own short id works as ours |

Two things in the data shape the design:

1. **There are no topic tags.** Jamie used to tag by topic and stopped; the four
   tags left are WT Builder's filing marks. Topics have to be derived (section
   "Topics").
2. **The note is not always Jamie's voice.** From 2007 to 2011 most notes are
   page excerpts captured by the bookmarklet (3,874 notes open with a quote mark;
   the 2008 median note is 593 characters). From 2017 on they are Jamie's
   commentary, often with a quoted excerpt in a Markdown blockquote. The record page
   should show both and not label an excerpt as Jamie's words.

### The join to the Weekly Thing is clean

Every issue on weekly.thingelstad.com carries its links in front matter (21 imported
issues of 2017 and 2018 list none there, so the join reads their bodies; docs/DATA.md)
(`links: [{url, text, domain, heading_context, section}]`), 6,510 rows across 330
issues. Normalising URLs (scheme, www, trailing slash, tracking parameters) matches
6,465 of them (99.3%) to a Pinboard bookmark, 6,465 distinct links. The 45 misses are mobile hosts,
tracking-parameter variants and Jamie's own sites. "Appears in WT350" is a build-time
join, no new data entry. The Librarian's link index goes further (19,922 links across
issues, blog and podcast, with a role of headline, commentary or journal, queryable by
URL through `find_links`), so "appears in" can extend to blog posts and episodes.

## What the site does

### Pages

| URL | What |
| --- | --- |
| `/` | Built as a search box, like Google's front page (Jamie, 2026-10-23): the wordmark, the box, how many links are in the index and the years they span, and a row of ways in (Newest, Years, Hosts, Kinds, Issues, Stats, Feed; Topics goes first once topic pages exist). A quote of the day from `content/quotes.md` when it holds any; nothing while it is empty. The site header is left off this page |
| `/search/?q=` | Results: title, host, saved date, a snippet of the note, a WT chip; filters for topic, year, kind, in a Weekly Thing, has a note; sort by relevance or date. Built: `kind:video` keeps one kind and, with no other words, links that kind's page |
| `/links/<id>/` | The record (below). `<id>` is the first 12 hex characters of md5 of the saved URL, which is Pinboard's API `hash`; anyone can compute it from the URL |
| `/links/<id>.json`, `/links/<id>.md` | Machine twins of the record, the Things I've built pattern |
| `/hosts/<host>/` | Every link from a host, newest first, with the host facts (section "Enrichment") |
| `/kinds/` | Built: the eight kinds (section "Special hosts and kinds"), each with its count and a line on what it holds. Linked from the site header and the front page |
| `/kinds/<kind>/` | Built: a kind's links by year, newest first, with its feed pair. A page lists at most the newest 1,000 and says so when it stops; only "page" (15,690 links) is that large, and every link is on its year's page |
| `/issues/<n>/` | The links that appeared in Weekly Thing n, in issue order, pointing at weekly.thingelstad.com/archive/n/ |
| `/topics/<slug>/` | Links in a topic, co-topics, the hosts and issues most present in it (phase 3) |
| `/years/<yyyy>/` | The year's links by month |
| `/newest/` | Built: the newest 50 links, the site feed's links, as a page |
| `/stats/` | Linking volume along its dimensions (section "Statistics") |
| `/about/` | The homage, in Jamie's words: what this is, why links matter, how it is made. Built from `content/about.md` (a `# ` title, then `## ` sections; the build fails on any other shape), a first draft in Jamie's voice from the Librarian for Jamie to edit. Linked from every page's footer |
| `/feed.xml`, `/feed.json` | The newest 50 links as RSS 2.0 and JSON Feed 1.1, the Link Thing feed reborn; every host, kind and topic page carries its own pair at `feed.xml` and `feed.json` under its path. Built for the site, all 7,064 host pages (the host's newest 50) and the eight kind pages (the kind's newest 50); topics with the topic pages. Each item is the record: its permalink as link and id, the destination and the note as content, Central dates with the real offset, tags as categories. Every page advertises the site pair; a host page advertises its own first |
| `/links.json`, `/hosts.json`, `/issues.json`, `/topics.json` | The whole public dataset. Built: `links.json` (every record, newest first, Pinboard's fields plus `permalink` and `kind`; section "If Pinboard went away"), `hosts.json` (host, count, first, last, url) and `issues.json` (the join, with each issue's `page` here and each saved link's `permalink`). `topics.json` comes with topics |
| `/links.db` | The SQLite database the site is built from, public fields only. Built: `npm run db` (`tools/build_db.py`, first step of `npm run build`) writes `public/links.db`, never committed, from the same JSON the pages read. Tables: links, hosts, issues, appearances, host_facts, wayback, facts, and meta (built_at, method, version, row counts). Facts only, as on the pages: nothing that says whether a host or page works. Deterministic: the same `data/` makes the same bytes, and built_at is the newest moment in the data, not the clock. 13.4 MB on 2026-10-23, served as `application/vnd.sqlite3` |
| `/llms.txt`, `/years/<yyyy>/llms.txt` | As on every other site of Jamie's. Built: `llms.txt` in llmstxt.org's shape (the data files, the record shape, the pages, and each year's file with its link count and size). A year's file holds every record saved in that Central year, newest first, as a slim row: title, URL, date saved and host, tags, the issues it appeared in, the permalink, then the note in full. 22 files, 10.6 MB together, the largest (2008) 0.8 MB; a year past about 4 MB would split by month, and `validate:site` fails one. They replaced `llms-full.txt` (every twin in one 36 MB file) on 2026-10-23 |

### The id

Pinboard's API `hash` is md5 of the saved URL, verified 2026-10-23: md5 of `href`
equals `hash` for all 16,882 bookmarks. The id is therefore derivable by anyone from
the URL alone: take the URL exactly as saved, md5 it, keep the first 12 hex characters
(unique across the corpus). Three consequences:

- **Lookup without a database.** A page or bookmarklet can compute the id in the
  browser and fetch `/links/<id>.json`; a 404 means "never saved". WT Builder's
  `get_item` can form the permalink the same way.
- **Editing a URL in Pinboard changes its id.** The sync detects a vanished hash and a
  new one with the same title and date, writes an alias, and the old permalink
  redirects. The same mechanism handles the 43 saved-twice groups.
- **The saved URL is the key, not a normalised one.** Normalisation is for joining
  (issues, note mentions, cites), never for the id.

**Pinboard's own web ids are something else.** Jamie pasted a page of the account on
2026-10-23. Its bookmark permalinks (`b:97f129a3300b`), its archived-copy links
(`cached/97f129a3300b/`, the same id) and its "N others saved this" pages
(`url:` plus 40 hex characters) were tested against five known links: none is md5,
SHA-1, SHA-256, SHA-512 or RIPEMD-160 of the saved URL or of any obvious variant
(scheme dropped, www dropped, trailing slash either way, lower-cased, http), with or
without the username, nor the API's `meta` field, nor a hash of a hash. They are
private ids. So:

- Linking Things ids are md5-based and ours; they are not Pinboard's `b:` ids, and
  the two never need to agree.
- A record cannot link to its exact Pinboard page from API data, and it does not
  try: no page sends a reader to Pinboard (Jamie, 2026-10-23). "Elsewhere" on the
  record is the Wayback copy and the record's JSON and Markdown twins.
- "N others on Pinboard" (3, 8, 13, 40 on the pasted page) is a connection to the
  Pinboard commons the API does not expose; it stays out unless the archive export
  carries it.
- The archive export may name each bookmark's folder by the `cached/` id, which is
  the `b:` id. If it does, the mapping arrives free, as data (still no link to
  Pinboard on the record); check on the day the archive lands.

Also confirmed from the paste: Pinboard's web pages show times in US Central
(12:35:06 on the page is 17:35:06Z in the export), and the API is UTC; the `☑` beside
a title marks an archived copy, so the archive's coverage can be read off the page
but not the API.

### The record page

The link is the hero. Its title is the destination link, printed with the host and
the date saved (US Central). Under it:

- **What Jamie wrote.** The note rendered from Markdown. Links inside it that point at
  other saved links become record links. Excerpts stay visibly quoted.
- **Appears in.** WT350, Notable, with a link to the issue; blog posts and episodes
  that link it, from the Librarian.
- **About the page.** Description, author, published date, language, reading time,
  the feed it advertises, first and latest Wayback capture.
- **Connections.** Same host; same issue; mentioned by other notes; cited by (saved
  pages whose own links point here); cites (where this page links, among saved
  links); same topics; similar; saved the same week.
- **Elsewhere.** The Wayback Machine's copies, and the record as JSON and Markdown.
  Nothing on any page names Pinboard: "nobody needs to know pinboard exists" (Jamie,
  2026-10-23).
- **Kudos.** A Tinylytics kudos button keyed on the permalink, the POAP site's
  per-drop pattern, with its public count beside a heart (`design/tinylytics.md`).
  Jamie, 2026-10-23: "The kudos button (let's use that name instead of like) is of
  course public. That is how that feature of tinylytics works."

A record stands on its own: the title, the note, the page facts and the Wayback link
are what was saved, whatever the destination does later. Links are not checked, and
no page says whether a destination still works: "You don't need to validate the
links. They just are." (Jamie, 2026-10-23).

### Links that are nothing but a link

3,601 public links (22%) have no note: 31% of those saved before 2015, 5% to 13%
through the WT Builder years, and rising again in 2025 (350 of 1,076) and 2026, where
a link saved and not published stays bare. The 18 `_exclude` links are the newest
case: WT Builder's mark for "public on Pinboard, kept out of the issue", all from
2026, two with notes. Jamie, 2026-10-23: include them, but "it would be odd for them
to have a landing page".

The record is a card that scales with what is known, never a landing page with
nothing on it. For a bare link the card is: the title as the destination link, the
host and the date, then only the rows that have content: appears in, page facts once
enriched, same host, saved the same week, cites and cited by, nearest neighbours. No empty "What Jamie wrote" heading, no filler. The
permalink exists because the JSON twin, the Librarian source and the tombstone all
need a unit to hang on, and because a bare link still has neighbours, which is the
point of the site.

The alternative, kept open: bare links get no HTML page, only the JSON twin, and
search results, host pages and year pages send them straight to the destination. It
costs consistency (two kinds of result row) and loses the connections for a fifth of
the corpus. The spike renders both and the decision is made on screenshots. Either
way the search filter "has a note" exists, off by default.

### Search

Pagefind, as on nnxyz, Weekly Thing and the POAP site. The index is written after
the Astro build over the record pages only. Indexed text: title (weighted highest),
note, and the page's own description (its meta description, a fact it publishes
about itself). Nothing from an archived page body, pending what the archive holds
(Jamie, 2026-10-23). Metadata per result: host, date, issue, topics, kind.
Filters: topic, year, in-WT, has-note, kind. Sort attribute: date. Pagefind documents under
300 KB of network per search on a 10,000-page site and a goal of tens of thousands of
pages; 16,882 records is inside that, and the spike measures it. Host is a search
term, not a filter (7,259 filter values would bloat the filter index). The nnxyz
lesson applies: Pagefind 1.5 fuzzy-matches metadata, so exact filtering is done
client side.

Google's grammar works: `site:macstories.net`, `year:2019`, `wt:300`, `topic:dns`,
`kind:video`, quoted phrases, and `-` to exclude, parsed in a few lines of client
code into Pagefind filters. `/` focuses the box; arrow keys walk the results.

Results open the record, not the destination. The destination is one click away on
every record and marked on every result. The record is the product (the connections
live there); a Google-style jump to the destination would make the site a redirect
service.

### Statistics

Jamie, 2026-10-23: "a stats page that shows linking volume along a number of
interesting dimensions". Computed at build from the data module, drawn as SVG at
build (no chart library at serve time), each chart with its table beside it for
readers and machines. Dimensions, all from data already in hand:

- Links per year and per month, 2005 to now, with the Weekly Thing's share of each
  year once issues began (2017).
- Per weekday and per hour of the day, in US Central: when Jamie saves.
- Notes versus bare links per year, and note length per year (the voice shift from
  excerpts to commentary shows here).
- Hosts: new hosts per year, the top ten hosts per year as a bump chart, and hosts
  that stopped (last link before a cutoff).
- The web's shape: http versus https by year, top-level domains, URL length, the
  share of links on the ten largest hosts (concentration) by year.
- The Weekly Thing: links per issue over time, sections, the share of a week's saved
  links that were published (the cutting-room floor, in aggregate).
- Once enrichment lands: domains that changed hands (RDAP); once topics land, topics
  by year.

The home page's count (the links in the index and the years they span) is the first
row of this page. The dataviz skill
is loaded before any chart is drawn, so the charts read as one system in light and
dark.

## The data layer

Three layers, three owners, the Things I've built shape.

| Layer | Where | Nature | Who writes it | Cadence |
| --- | --- | --- | --- | --- |
| Mirror | `data/links/<yyyy>.json` | Pinboard's fields for public bookmarks, verbatim: id, href, title, note, time, tags, hash, meta | `npm run sync`, never a person | Weekly, and after Saturday's issue |
| Enrichment | `data/enrichment/pages/<yyyy>.json`, `data/enrichment/hosts/<a-z0-9>.json` (shards, docs/DATA.md) | Facts observed about the page and the host | `tools/enrich_hosts.py`, `tools/enrich_pages.py`, never a person | Nightly slices, incremental |
| Derived | `data/derived/issues.json`, `topics.json`, `neighbors.json`, `graph.json` | The joins and the model outputs, each stamped with its method and version | `npm run derive` | On every sync; topics and neighbours for new links only |

Rules:

- **Pinboard is the source of authority for the bookmark.** Title, note, date, tags
  are read from Pinboard and never edited here; edits happen in Pinboard or in WT
  Builder, which writes back. The site never writes to Pinboard. A bookmark deleted at
  Pinboard leaves at the next sync; its id goes on a tombstone list so the old
  permalink says so instead of 404ing (Jamie's call, section "Decisions").
- **Nothing private enters `data/`.** The sync drops `shared: no` before writing.
  `npm run validate:data` fails if a private bookmark, a credential, or an
  unexpected field appears. The raw export in `pinboard/` is gitignored (done today)
  and holds the 358 private bookmarks; it never leaves this Mac. The line is
  Pinboard's own: everything the site publishes is already public at
  pinboard.in/u:jthingelstad.
- **`links.db` is a view, not the truth.** `npm run db` builds a SQLite file
  from the JSON (built: links, hosts, issues, appearances, host_facts, wayback, facts
  and meta; topics, link_topics and edges join it with phase 3) and publishes it for
  download. The Astro build reads the JSON itself, not the file: `data/links` and
  `data/derived` through `src/lib/data.ts`, the only place URLs are formed, and
  `data/enrichment` through `src/lib/enrichment.ts`, which keeps the facts and drops
  every liveness field before a page sees it.
- **Every derived value names its method.** `topics.json` records the vocabulary
  version, model and prompt hash; `neighbors.json` the embedding model; `graph.json`
  the edge types and their sources. Re-deriving is cheap; silently mixing methods is
  not.

## Connections

The graph is the point of the site. Edge types, their source, and when they arrive:

| Edge | Source | Coverage today | Phase |
| --- | --- | --- | --- |
| appears in issue | weekly.thingelstad.com front matter; the Librarian for blog and podcast | 6,465 links, 354 issues | 1 |
| same host | the URL | every link | 1 |
| saved the same week | `time` | every link | 1 |
| mentioned by (a note links here) | URLs inside notes | 202 edges | 1 |
| saved twice | normalised URL | 43 groups | 1 |
| cites / cited by | outbound links of the archived page copy, matched to saved URLs | unknown until the archive is parsed; the richest source of real hyperlink structure | 2 |
| same topic | topics | every link | 3 |
| similar | embeddings over title, note and excerpt, top 10 kept per link | every link | 3 |

The "cites" edge is the homage made concrete: the actual hyperlinks between the pages
Jamie saved. It needs the Pinboard archive (section "The archive"). Phase 1 ships the
edges that need no new data; the record page and the graph file are shaped to accept
the rest.

### Nearest neighbours

Jamie likes this one. Every record shows its five nearest neighbours, computed at
build from an embedding of the title, the note and the page's description, with the
reason shown beside each ("same topic", "same issue", "same host", or nothing, which
is the interesting case: two links from different years and hosts that are about the
same thing). The top ten per link are kept in `neighbors.json`; the model and its
version are recorded there. Neighbours are recomputed for new links weekly and for
everything when the model changes. No runtime cost: the page is static and the
neighbours are text.

Hosts and topics have neighbours too: hosts whose links share topics, topics that
co-occur. The POAP site's `/network/` page is the precedent for one graph view over
the whole corpus; here it would be topics and the hosts that bridge them, drawn at
build as SVG.

## Topics

Nothing to inherit: no tags, and the Librarian's nine clusters are per issue and too
coarse for 17,000 links (its 776 extracted topics are entity names, many noise).
Proposal:

1. **Propose a vocabulary.** A model reads a stratified 1,500-link sample (title,
   note, excerpt) and proposes topics; the proposals are clustered into about 80 to
   150 candidates with descriptions.
2. **The model's vocabulary stands.** Jamie, 2026-10-23: "it isn't realistic for me to
   prune it. i think you should go with what the model comes back with." The
   vocabulary is written to `content/topics.yaml` (id, title, description, parent),
   the Things I've built shape, so a word can still be changed by hand later, but
   nothing waits on that.
3. **Classify every link** into one to three topics from the vocabulary, with a
   structured output so nothing outside it is written. Store in
   `data/derived/topics.json` with the vocabulary version. New links each week, same
   prompt.
4. **Topic pages** list links newest first, show co-topics, the hosts and issues most
   present, and a feed.

One-time cost for the bulk pass, roughly 500 input tokens and 60 output tokens per link
(the vocabulary prompt cached), first-party API prices as of 2026-10-06:

| Model | About |
| --- | --- |
| Claude Haiku 5.5 | $1.50 |
| Claude Sonnet 5.5 | $27 |
| Claude Opus 5.5 | $54 |

The Batch API halves each. Recommended: Sonnet 5.5 proposes the vocabulary (once, a
few dollars) and Haiku 5.5 classifies; the design does not depend on the choice.
Weekly reclassification of 30 or so new links costs cents on any of them. Jamie
accepted model cost at ingestion and build on 2026-10-23; none of it reaches serving.
The key is `CLAUDE_API_KEY` in the Mac's `.env`, next to the Pinboard token (an
`OPENAI_API_KEY` sits beside it, unused for now); the derive step runs on the Mac and
CI never holds it. Every bulk pass goes through the Message Batches API (Jamie,
2026-10-23: "make sure to use the new bulk methods to get massively lower costs").
Topics and neighbours wait for the archive export (Jamie, 2026-10-23: "If all we have
is a title and a URL it is hard to do much with it"); if the export never comes, that
is a decision to take then, not a title-only pass.

Embedding-based "similar" uses the model the Librarian already uses
(`cohere.embed-english-v3` on Bedrock) over the same text; 17,000 short documents is
a few million tokens, cents on Bedrock's published rate (verify before running). Keep
the vectors out of git; keep the top-10 neighbours per link in `neighbors.json`.

## Enrichment

What to collect, and from where. All of it is observation, none of it editorial.
And none of it judges a link. Jamie, 2026-10-23: "You don't need to validate the
links. They just are." So no page says whether a destination works, shows a status
or a redirect target, or counts the alive and the gone. The liveness part of the
page tool exists and is not run for the site; nothing is built from it.

**Per link** (`data/enrichment/pages/<yyyy>.json`, keyed by id; the Wayback part is
built and was sampled 2026-10-23 on 150 links. The liveness part was built and
sampled the same day, 114 alive and 36 dead with about 7 bot walls, before Jamie's
rule above; it stays in the tool and the contract, unused):

- Liveness (status now, final URL after redirects, checked-at) is in the contract
  and the tool and is not run: the site shows nothing from it.
- Page facts: HTML title, description, canonical, author, published date (meta tags
  and JSON-LD), language, word count and reading time, the feeds it advertises
  (`rel=alternate`), the outbound links. From the archived copy where we have one,
  else a live fetch.
- Wayback: first capture, latest capture, capture count, from the CDX API at the
  6-second pace Things I've built learned (bursts get the IP blocked), spread over
  nightly runs.
- Pinboard archive: when Pinboard archived it and how large the copy is, from the
  archive manifest.

**Per host** (`data/enrichment/hosts/<a-z0-9>.json`, keyed by host; DNS, HTTPS and
RDAP are built and were run on the 69 hosts with 25 or more links: all resolve, 66
have RDAP, none was registered after Jamie's first link, and tech.mn is parked, which
the CNAME showed and RDAP could not):

- DNS: A/AAAA, CNAME target, NS, whether MX exists, resolves or not, checked-at.
- HTTPS: reachable, redirects http to https.
- First and latest link saved, link count (derived, but handy here).
- Open-web signals from the home page: feeds advertised, h-card, rel=me, a
  Webmention endpoint. On brand for this site.
- RDAP, explained: the Registration Data Access Protocol is the successor to WHOIS, a
  public JSON API each registry runs (Verisign for .com) that returns a domain's
  registrar, registration date, expiry, status and name servers. No key, rate
  limited. What it adds here is the domain's age ("registered 1996") and whether a
  dead host's domain has since expired or changed hands, which is how a link saved in
  2009 comes to point at a spam site today. Recommended for hosts with five or more
  links (428 hosts, 7,263 links) in phase 2, not for all 7,064. Jamie declined it for
  Things I've built on 2026-10-18; this is a different site with a different reason.

Pacing: one request per second with a named user agent, incremental by checked-at,
so a first page-facts pass is hours and a weekly run is minutes. Steps that read
the 70 GB archive run on the Mac; DNS, RDAP and Wayback can run anywhere.

## Special hosts and kinds

Jamie, 2026-10-23: "some sites might appear enough to get special treatment". The
corpus is concentrated enough for that to pay: 218 hosts have ten or more links and
together hold 7,263 of them (44%). Measured 2026-10-23, public links:

| Host or kind | Links | Treatment |
| --- | --- | --- |
| YouTube (youtube.com, youtu.be) | 287 | The video id is the key, so one video saved under two URL forms is one record. Title and channel from oEmbed (no key). A thumbnail fetched at build and stored with the site, shown as a click-to-play facade; the click loads the `youtube-nocookie.com` embed. No YouTube script until the visitor asks for the video. |
| GitHub (github.com, gists) | 256 | A repository card: description, language, stars, license, archived, last push, from the REST API with the gh CLI's token on the Mac (`GITHUB_TOKEN`, exported by the nightly job). |
| Medium | 261 | Many moved to custom domains; the saved URL stands as saved. Author as the entity. |
| macstories.net, daringfireball.net, kottke.org, simonwillison.net, tbray.org, seths.blog, stratechery.com, scripting.com, lethain.com and the other personal sites in the top 50 | 50 to 240 each | These hosts are people. The host page names the author, the feed, and the span of years; together they are the blogroll (section "Ideas beyond the brief", OPML). |
| nytimes.com, arstechnica.com, techcrunch.com, theverge.com, theguardian.com, theatlantic.com, wired.com, bloomberg.com, economist.com, hbr.org | 45 to 204 each | Author and published date from page metadata; nothing more. |
| tuaw.com, gigaom.com, readwrite.com | 131, 115, 58 | Closed or changed hands. The host page says when the site closed; its records carry the Wayback link, as every record does. TUAW's domain was reported in 2024 to have been bought and refilled with generated articles under former writers' names: the case for RDAP. |
| Amazon | 142 | Mostly AWS pages (aws.amazon.com); only 3 are book pages with an ISBN-10 in the path (built, 2026-10-23). ASIN or ISBN from the URL; title, author and cover from Open Library; a "book" kind. Old affiliate tags stripped from the display URL. |
| Substack | 115 | A newsletter kind; feed discovery; author entity. |
| Vimeo | 64 | Same facade as YouTube, via oEmbed. |
| PDFs, arXiv | 57, 7 | A "paper" kind: page count and title from the file's metadata. |
| Wikipedia | 56 | The article's summary and thumbnail from the REST summary endpoint; an "article" card. |
| Twitter | 23 | Unviewable without an account; the record shows the title and the Wayback link, nothing else. |
| Jamie's own sites | 226 note links, plus direct links | Resolve to the Librarian source or the Thing, and link there. |

"Kind" (video, repository, book, paper, article, newsletter, podcast, page) is derived
from host and path and becomes a search filter and a browse page. Built in
`src/lib/kinds.ts`, first rule wins and "page" is everything else; on 2026-10-23:
video 351, repository 232 (GitHub's own sections such as /blog/ are pages), book 3,
paper 64, article 56, newsletter 122, podcast 6, page 15,690. The record names its
kind; when the facts tool has observed the page it shows a card (a video facade,
a repository or gist, a book, a Wikipedia article), and a host page shows its RDAP
and home-page facts. Each treatment is
one adapter in `tools/linking/adapters/<method>.py` with the same contract as the generic page
facts, so a host earns an adapter when its count and its API justify one; nothing
else in the build knows the host.

## The archive

Jamie's Pinboard archival account holds a copy of every saved page, about 70 GB,
downloading now. Pinboard documents no export format; users describe a tar.gz with
one folder per bookmark holding the page and its assets plus a JSON manifest. The
loader (`tools/archive.py`) is an adapter: given the archive root, yield
(bookmark id, HTML path, manifest). Nothing else touches the layout, so whatever
arrives, one file changes.

Jamie, 2026-10-23: the archive "is just for data", nothing from it is served, "I
don't want us to be a Wayback Machine". So:

- The archive is read once per link for facts (title, description, author, published
  date, language, word count, feeds advertised) and for the outbound links, which
  become the "cites" graph. Facts are published; bodies are not.
- No excerpts on pages and none in the search index. If the archive turns out to hold
  something that changes this, it is a new decision, not a drift.
- The public copy of a page is the Wayback Machine, linked from every record.
- The 70 GB stays on the Mac. A private S3 snapshot (Glacier class, hash-pinned like
  nnxyz's datasets) is a backup choice, not a publishing one.
- First thing to check in it: whether folders are named by Pinboard's `cached/` id
  (the `b:` id) and whether any manifest carries the "others saved this" count.
  Either would add a connection the API cannot give (section "The id").
- Pinboard's own "search full text" over the archived pages stays Jamie's private
  tool; Linking Things does not replicate it.

## The Librarian

The pattern exists. Things I've built publishes `things.json`; the Librarian's sync
workflow snapshots it into `data/things/things.json`
(`pipeline/things/import_things.py`), and its corpus build makes one source per thing
(`thing-<id>`, `source_kind: "thing"`, chunk ids `thing:<id>:<n>`). The boundary rule
in the Librarian's `ALIGNMENT.md` holds here: this site publishes, the Librarian
ingests, and nothing here calls the Librarian at build or serve time. The one read in
the other direction is at derive time on the Mac, where the Librarian's link index
supplies the blog and podcast appearances for a record.

For links:

- **`links.json` is the ingestion surface**: `site`, `generated`, then `links` (id,
  url, title, note, voice, saved, host, kind, issues, topics, excerpt, page facts,
  connections), `hosts`, `topics` and `issues`. The importer drops `generated` and
  sorts, so an unchanged corpus commits nothing, as with things. Phase 1 builds it as
  the Pinboard-shaped mirror (`site`, `generated`, `count`, then `links` with
  Pinboard's fields, `permalink` and `kind`), beside `hosts.json` and `issues.json`.
  `kind` (`src/lib/kinds.ts`) joined the rows on 2026-10-23 for the Librarian to read
  (Jamie: "add kind to the links.json rows"); it comes after the Pinboard fields, which
  stay exactly as saved. Whether phase 4 adds the other richer fields to these rows or
  publishes them in a file of their own, so the Pinboard shape never drifts, is open.
- **One source per link**, `link-<id>`, `source_kind: "link"`, dated by the saved date.
  Things are undated; links are not, so the date-anchored tools (`on_this_day`,
  `archive_lens`, `compare_eras`) reach twenty-one years of links. The chunk text is
  the title, the note, the excerpt and the appearances. The note carries its voice
  label, so `voice: "jamie"` keeps the commentary and drops the 2007 to 2011 excerpts.
- **The link index points at the unit.** The Librarian already resolves a URL to the
  issues, posts and episodes carrying it (`find_links`, 19,922 links). With links as a
  source, that index can name the `link-<id>` source, and `get_source` can attach the
  record's Markdown twin (`librarian://link/{id}`).
- **The Weekly Thing stays indexed, as the container.** Intro, journal, haiku, echoes
  and outro are issue-level text. The commentary on a link is the link's own note (WT
  Builder writes it to Pinboard), so the link carries the commentary and the issue
  cites the link; the blog carries the journal. Nothing leaves the corpus; what changes
  is which unit a question lands on.
- **Trigger.** A `links-published` dispatch from this repository's deploy workflow
  (planned for Things I've built, not done there yet), with the Librarian's weekly sync
  as the fallback.
- **Scope of the Librarian change.** `link` joins its `source_kind` enums, and 16,882
  dated sources change its index size and retrieval mix. That is a change in the
  Librarian's own repo with its own review, and the one scheduled model cost in this
  plan: embedding the week's new links, cents.

## Agents and the MCP

Jamie asked on 2026-10-23 whether "a static read-only MCP structure for this data set
with no authentication" is possible: "a set of static URLs that would allow Claude to
navigate this database in an effective way", and said "an MCP server is for sure going
to be in our future as a read-only interface on this."

**A static MCP does not exist, as a matter of protocol.** MCP's transport is JSON-RPC
over HTTP POST (`initialize`, `tools/list`, `tools/call`); a static host answers GET
only, and the older SSE transport needs a POST endpoint too. So there are two layers,
not one:

**The static layer, which is built.** It is what an agent with a fetch tool uses today,
and it costs nothing to serve:

- `/llms.txt` is the map: what the site is, the data files, the record shape, the
  pages. `/years/<yyyy>/llms.txt` is the full text in year-sized pieces (Jamie:
  "Trim. Probably by year").
- Every record has `.json` and `.md` twins at its own address, and `/links.json`,
  `/hosts.json`, `/issues.json` are the whole database in three files.
- The feeds, per site and per host, are the "what is new" interface.
- CORS is open for GET and HEAD, so a browser-based agent can fetch all of it.

The walk is: read `llms.txt`, then a year file or `links.json`, then record twins.
What it lacks is a word index: Pagefind's index is static files too, but shaped for
its own client. If agents turn out to struggle, a static term index (`/index/<two
letters>.json`, words to ids, built with the site) is the next step and still no
server. Not built until a real agent needs it.

**The MCP, when it comes.** A small, stateless, read-only server with no
authentication, on a Lambda Web Function behind its own hostname, the pattern of the
thingelstad.com and Elixir servers. It reads the same built files the site publishes
(`links.json`, `issues.json`, `hosts.json`, 12 MB, bundled with the function or read
from the site bucket at cold start), so it is never ahead of or behind the site; the
deploy workflow publishes it after the site. Tools, in the family's conventions (one
id everywhere, `serverInfo.version` bumps on schema change, notes[] in every answer):
`links_search` (the search grammar: words, site:, year:, wt:), `links_get` (id or
URL), `links_host`, `links_issue`, `links_year`, `links_stats`, `links_random`. Search
is an in-memory index over 16,524 records built at cold start, tens of milliseconds.
No model at serve time (Jamie's rule: "serving the site should be public and not
having model cost"), no state, no keys; public data needs no auth, and the edge's
rate limit is the only guard.

**And the Librarian.** Once links are a source there (section "The Librarian"), its
MCP answers "what did Jamie say about X" across everything at once. Both can be true:
the Librarian for questions, the links MCP for the record, fast and plain, with no
model in between. Order: the static layer (done), the Librarian ingestion (planned),
the links MCP when there is a concrete consumer (a Claude connector, Otto, WT Builder
asking "has this been linked before?").

## If Pinboard went away

Jamie, 2026-10-23: no plans to leave Pinboard, but "if Pinboard ever went away this
site would give me a possible new solution to stage links for the Weekly Thing". So
the mirror is kept lossless and Pinboard-shaped, not merely sufficient for pages:

- Every field Pinboard returns for a public bookmark is in `data/links/`, including
  `tags` (WT Builder's filing marks) and `meta`. Nothing is summarised away.
- The site publishes that mirror as `/links.json`: every public record with Pinboard's
  fields in Pinboard's order, plus its permalink and its kind, newest first as
  `posts/all` returns them. `npm run validate:site` checks it against `data/links/`
  field by field, so the published copy alone could restore the public bookmarks.
- The 358 private bookmarks live only in the raw export on the Mac. That file is the
  one copy of them outside Pinboard; it belongs in the sysadmin critical-state backup
  bundle (a request for the Systems Administrator, not a change here).
- The sync tool's offline mode already reads a file instead of the API. The day the
  API is gone, the same tool reads the last raw export and the site keeps building.
- WT Builder reads Pinboard through its own integration (`wt-builder/docs/integrations.md`).
  A replacement would be a small, local, Pinboard-shaped reader over `data/` and the
  raw export, so WT Builder's filing marks and notes keep working unchanged. Not
  built, not planned; the point is only that the data shape must never drift from
  Pinboard's.

## Build and hosting

- **Astro and TypeScript** on the nnxyz and POAP pattern, static output, one data
  module. Roughly 17,000 record pages, 7,300 host pages, 330 issue pages, topic and
  year pages: about 25,000 pages, minutes to build.
- **Pagefind** after the build, record pages only.
- **Infrastructure** on the POAP pattern: four CloudFormation stacks (certificate,
  storage, site, delivery), S3 and CloudFront, directory-index function, 5xx alarm on
  the family topic, GitHub Actions deploying `main` through OIDC. `npm run infra:plan`
  change sets with the `cloud-engineer` identity, applied on Jamie's go. Namecheap
  records (the `links` CNAME and the ACM validation CNAME) are Jamie's step; the
  handoff formats them for Namecheap.
- **Repository** `jthingelstad/links.thingelstad.xyz`, public like its siblings.
  `pinboard/`, `archive/` and `.env*` ignored; the Pinboard token lives only in `.env`
  on the Mac, and CI never holds it.
- **Nightly sync** (decided 2026-10-23): `tools/nightly.sh` runs on the Mac as the
  launchd job `com.thingelstad.links-nightly` at 00:30 Central: the Pinboard sync, the
  issues join, then bounded slices of the host, facts and Wayback enrichment. It
  commits `data/` and `public/media` as "Linking Things nightly" and pushes, and the
  push deploys. The GitHub Actions shape was not taken: the token stays on the Mac,
  and the archive and model steps have to run here anyway. The sync does not dispatch
  `links-published` to the Librarian for now (Jamie, 2026-10-23: everything except
  sending links to the Librarian). Topics, neighbours and archive-derived facts wait
  for the archive export and will run here too.
- **Checks**: lint, format, types, unit tests on the data module and the URL
  normaliser, `validate:data` (no private links, no unknown fields),
  `validate:site` (every page in the sitemap, every internal link resolves; every
  feed parses and holds the right records with Central dates; the dataset files match
  `data/`; every site URL in a feed, data or llms file is built; the year llms files
  hold every record exactly once, each in its own Central year; `/newest/` lists the
  newest 50; a public Kudos button on every record; Tinylytics only in a production
  build), browser tests at three widths with analytics blocked.
- **Analytics and kudos**: Tinylytics, one script in the layout with `?kudos=custom`,
  production host only; a public Kudos button on every record
  (`class="tinylytics_kudos"`, the POAP `Kudos.astro` pattern, never `data-private`)
  keyed on `/links/<id>/`, the count written in by the embed. QA never
  sends a hit or a kudos, and the site check fails if a request reaches
  tinylytics.app. Built 2026-10-23 on site 3842: the script is in the build only when
  the deploy workflow sets `PUBLIC_TINYLYTICS_ENABLED=true`, and loads only on
  links.thingelstad.xyz; `validate:site` fails if any other build mentions
  tinylytics.app (`design/tinylytics.md`).
- **Feeds**: RSS 2.0 and JSON Feed 1.1, as weekly.thingelstad.com ships them (`rss.njk`,
  `feed.njk`). The site feed carries the newest 50 links; each host and topic page has
  its own pair. Measured 2026-10-23: 14,128 host feed files for 7,064 hosts, 41 MB,
  about 1.5 s of build, so every host keeps its pair (the fallback was the 428 hosts
  with five or more links).
- **The sites strip**: Linking Things joins `sites.json` and the strip when it is
  done (Jamie, 2026-10-23: "99% sure"). The layout vendors `tokens.css` and carries the
  shared h-card and `rel=me` from the start, so joining is one registry line.

## Ideas beyond the brief

Things the corpus makes possible that the brief did not ask for. Each is cheap unless
marked. None is in a phase until Jamie says so.

**The hyperlink, honoured**

- **Two-way links.** "Cites" and "cited by" on every record is the bidirectional link
  Ted Nelson wanted and the web never had. Say so on the About page, and show both
  directions with equal weight.
- **Trails.** Vannevar Bush's memex idea: a named sequence of links with a sentence
  between each, authored by Jamie in `content/trails/<slug>.md` and rendered as a page
  with its own feed. A model can draft candidates from the neighbour graph for Jamie to
  keep or discard.
- **Lookup from the URL.** Because the id is md5 of the URL, `/lookup/` computes it in
  the browser and fetches the twin: "Has Jamie linked this?" as a page, a bookmarklet,
  and a line in WT Builder's item view.
- **A Netscape bookmark file.** `links.html` in the 1994 bookmark format every browser
  still imports: the whole corpus, loadable into anyone's browser.
- **The blogroll as OPML.** Once feed discovery runs, `blogroll.opml` lists the feeds
  behind the hosts Jamie links most: subscribe to the sites behind twenty-one years of
  links. Pairs with a `/blogroll/` page.
- **Webmentions, forward only.** Sending a Webmention to each newly saved page that
  accepts them is the IndieWeb way to say "Jamie linked to you". Never for the
  back catalogue. A product call.

**The web, as seen from here**

- **The shape of the web page.** Hosts rising and falling by year, the http to https
  turn, platform eras (Medium's peak, Substack's rise, Twitter's fade), TLDs, link
  length, notes per link. Twenty-one years of the web through one person's bookmarks.
  Year pages carry the same for their year.
- **Firsts.** The first link to each platform: first YouTube video, first GitHub
  repository, first Medium post, first Substack, first OpenAI page. A one-page history
  of adoption.
- **Domains that changed hands.** RDAP shows a host's domain registered again after
  Jamie's last link to it: the TUAW story, told per host.

**The editing, made visible**

- **The cutting-room floor.** For each Weekly Thing issue, the links saved that week
  that were not published, and the ratio. The issue page already has the published
  ones; this is the other half of the week.
- **Notes that are essays.** The longest notes (the longest is 23,492 characters) are
  posts in all but name. A page of the hundred longest, newest first.
- **Surprise me.** A random record, one more way in on the home page. (On this day
  was built and then removed on 2026-10-23: Jamie was "not sure on-this-day is
  meaningful for this data set". The Librarian's `on_this_day` still answers it.)

**People**

- **Authors.** Page metadata names authors; the personal hosts in the top 50 are
  people. A curated `content/people.yaml` (name, hosts, feed, a sentence) makes a
  People browse without trusting noisy metadata. Costly only in Jamie's time.

## Phases

**0. Spike** (one session, no infrastructure). Sync, mirror, join, the Astro skeleton
(home, search, record, host, issue, year), Pagefind, local build. Measures the index
size, the build time and the page weight; produces screenshots. Ends with `AGENTS.md`
for the repo.

**1. Launch.** Infrastructure, DNS, CI deploy, feeds, JSON and Markdown twins,
`llms.txt` and a file per year, About in Jamie's words, Tinylytics, weekly sync, a Things I've built
entry. Connections from existing data only.

**2. Depth.** Host DNS and open-web signals, RDAP for the
428 hosts with five or more links, Wayback, page facts and the "cites" graph from the
archive, kinds, and the first adapters (YouTube, GitHub, Wikipedia, Amazon books).

**3. Browse.** The topic vocabulary, the bulk classification, topic pages, embedding
neighbours, "similar".

**4. The Librarian.** The SQLite download, `links.json` in its final shape, and the
Librarian ingesting it (section "The Librarian"), and a links MCP of its own once
there is a consumer for it (section "Agents and the MCP"). The site itself stays
static.

## Decisions

Jamie, 2026-10-23, with the design's response:

| Question | Answer | Response |
| --- | --- | --- |
| Pinboard's 12-hex id as the permalink | Fine, if we can generate it ourselves | The API `hash` is md5 of the saved URL for all 16,882, so the id is ours to make. Pinboard's web `b:` ids are a different, private id (tested against Jamie's paste). Section "The id". |
| Results open the record | Agree | Done. |
| Which model classifies topics | Defer until the archive is in hand | Phase 3; the design does not depend on it. |
| Archived pages: facts plus an excerpt | Not even that; data only; "I don't want us to be a Wayback Machine" | Facts and the cites graph only; no excerpts anywhere. Section "The archive". |
| `_exclude` links and links with no text | Include them, but no landing page for a bare link; later, "I'm good with you exploring what works best" | The card that scales with what is known, explored in the spike with screenshots of both the rich and the bare case. Section "Links that are nothing but a link". |
| Deleted bookmarks | Tombstone, "that could be fun" | Done. |
| RDAP | "I don't know what that is", then "RDAP yes, for sure" | In, phase 2, for the 428 hosts with five or more links first, the rest after. |
| Joins the sites strip | 99% yes | Planned from the start; one registry line when done. |
| Where the weekly sync runs | Defer; consider the Librarian's timing | Deferred; the `links-published` dispatch settles the ordering either way. |
| A private Like, or a public count | "The kudos button (let's use that name instead of like) is of course public. That is how that feature of tinylytics works." | Named Kudos everywhere. The count shows: the embed's `?kudos=custom` writes it into a button the site draws, and `validate:site` fails a private one. `design/tinylytics.md`. |
| `llms-full.txt` at 36 MB | "Trim. Probably by year or even year month?" | By year: `/years/<yyyy>/llms.txt`, slim rows, 22 files and 10.6 MB together, the largest 0.8 MB, so no month split; `llms.txt` lists them with counts and sizes. A year past 4 MB fails validation and would split by month. |
| On this day | "I'm not sure on-this-day is meaningful for this data set?" | Removed: the 366 day pages, the grid, their checks and their helpers. |
| Checking that links still work | "You don't need to validate the links. They just are." | No page promises a check. The "Link rot, measured" and "Then and now" ideas are dropped; the liveness and "now at" parts of sections "Enrichment" and "Connections" and of phase 2 were brought in line the same day. |
| "Find it on Pinboard" on the record | "get rid of 'find it on pinboard' nobody needs to know pinboard exists." | Gone from every page, twin, feed and llms file; Elsewhere is the Wayback copy and the twins. The "Save to your Pinboard" idea is dropped. Maintainer docs still name Pinboard, as the source. |
| The front page | "very much like Google's front page, where it's just a search box. I think there should be topics, so if you don't know what you want to search, you could do topics. Should show how many pages are in the index. I probably at some point will add like a quote from me on how amazing the hyperlink is. Maybe we have a collection of some quotes like that." | Built: the wordmark, the box and the count above the fold at 500 and 1200 px; a row of ways in, with Topics to go first once topic pages exist; quotes in `content/quotes.md`, one a day, nothing shown while it is empty. The newest links moved to `/newest/`. |

Earlier, same day: the Librarian ingests the site; Tinylytics with kudos per link;
RSS and JSON Feed; model cost at build only, never at serving. The name is Linking
Things.

Later the same day: RDAP yes; a statistics page (section "Statistics"); the bare-link
treatment is left to the build to explore; build started with Opus 5.5 agents on
2026-10-23, the repository initialised locally on `main`.

Still open: which of the ideas beyond the brief earn a phase; creating the GitHub
repository and the Tinylytics site, both Jamie's go.

## Spike results (2026-10-23)

Phase 0 was built the same day by an Opus 5.5 agent and measured on this Mac:

| What | Measured |
| --- | --- |
| Build | 31 to 44 s (Astro 16 to 22 s, Pagefind 14 to 21 s) |
| Pages | 23,970 HTML (16,524 records, 7,064 hosts, 354 issues, 22 years) plus 33,048 JSON and Markdown twins; 284 MB |
| Record page | 8.1 KB mean, about 2.9 KB gzipped; one 14 KB stylesheet; 5 KB of script, on the search page only |
| Pagefind index | 12.5 MB in 16,687 files; 143 index chunks |
| One search | 340 to 400 KB, of which 308 KB is fixed start-up (`pf_meta` 148 KB, wasm 73 KB, script and worker 87 KB) |

Two Pagefind behaviours needed handling at this scale. A query with no words (a
filter alone, such as `wt:3`) loaded the whole 4 MB index; such queries now go to
the year or issue page instead and Pagefind loads only on the first worded search.
And an unmatched word falls back to a shorter prefix (a nonsense word found the ZX
Spectrum post); results are now kept only when the first three letters of each typed
word begin a word in the title, host or text. `pf_meta` grows with the record count
and is the number to watch.

**Bare links, decided:** every link keeps its record page. The bare card (title, host,
date, URL, then only the rows with content) was rendered beside the alternative of
sending bare rows straight to the destination on host pages; the alternative made one
list hold two kinds of row and lost the twin, the Librarian unit and the connections.
The bare example still had twelve links saved the same week. Enrichment rows go to
bare records first.

**Voice label:** the excerpt era is 2007 to 2016 after sampling, wider than the 2007
to 2011 first estimated. Counts: Jamie's words 6,084, mixed 2,270, excerpt 4,569, no
note 3,601. It is a label, never an assertion.

## Risks and unknowns

- **Pagefind at 17,000 records.** Measured in the spike: it holds, with the two
  behaviours above handled in the browser; `pf_meta` is the fixed cost that grows.
- **The archive format** is unknown until it lands. The adapter contains it.
- **Destinations change.** Links are not checked ("They just are", Jamie,
  2026-10-23), so no page says whether a destination works; every record carries its
  Wayback link.
- **Voice.** Old notes are excerpts, new ones commentary; a heuristic (quote mark,
  era, first person) labels them, and will be wrong sometimes.
- **Pinboard's API** allows `posts/all` once per five minutes and returns 11 MB; the
  sync calls `posts/update` first and pulls only when the stamp moved.
- **Copyright** of cached pages: facts only, by design.
- **Pinboard's web ids are private.** No "others saved this" unless the archive
  export carries the ids. Records do not link to Pinboard in any case.
