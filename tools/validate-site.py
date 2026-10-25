#!/usr/bin/env python3
"""Validate the built site in dist/ (npm run validate:site, after npm run build).

Adapted from poap.thingelstad.xyz's validator. It checks:

- every page has a title, a canonical link to its own URL, a main landmark,
  and as its og:image its record's card (src/lib/card.ts) on a record page
  and the one share image (tools/share-image.mjs) on every other;
- every internal href and src resolves to a built file (or to /mcp, which
  CloudFront sends to the MCP server), and every #fragment on an internal
  link names an id on the target page;
- nothing is fetched at serve time from another host (scripts, styles, fonts,
  images, frames, and URLs inside inline scripts), except owner.avatar from
  shared/sites.json, the photo the family's h-card contract names, and, in a
  production build only, the one Tinylytics script (design/tinylytics.md);
- Tinylytics: a build without PUBLIC_TINYLYTICS_ENABLED=true mentions
  tinylytics.app nowhere in dist/; a build with it (validate it with the same
  variable set) loads exactly that one script on every page and mentions
  tinylytics.app nowhere else; every record has one Kudos button keyed on its
  permalink, with a public count (no data-private, Jamie's call 2026-10-23);
- the sitemap index lists sitemaps that exist, every sitemap URL is a built
  page, and every page but the 404 and those marked noindex is in the
  sitemap, once; a noindex page is never in it, and only records, host
  pages and /surprise/ (a door to a random record) are marked noindex;
  robots.txt disallows no noindex page (a crawler has to fetch a page to
  read its noindex);
- every page's footer h-card names owner.url from shared/sites.json as
  its u-url (its u-photo stops the parser implying one from the link);
- microformats: a record is one h-entry whose u-url is its permalink (its
  u-bookmark-of is the saved link), with no h-feed or h-entry inside it; a
  page that lists records (/newest/, a host, kind, year or issue page) is an
  h-feed on its main, with the page as its u-url, of one h-entry per record
  row (p-name, u-url the record, dt-published its saved time); an issue
  with no saved link, and every other page, carries neither;
- every record page has its JSON and Markdown twins, the JSON names the same
  id, and there is one record per link in data/links (read, never written);
- Pagefind indexed exactly the record pages;
- the feeds: every feed.xml is well-formed RSS 2.0 and every feed.json is
  JSON Feed 1.1, newest first, with Central dates that carry their offset,
  each item a record; the site pair holds the newest 50 links; every host page
  has its pair;
- /links.json is every record exactly as data/links has it, plus its
  permalink and then its kind, the same as its JSON twin's; /hosts.json and
  /issues.json match the pages and the join;
- /search/suggest.json, what the search box suggests from, holds every host
  with its count as /hosts.json has them and its links in each Central year
  as its twins have them, every issue newest first with its
  title, Central date and the saved links it carried, and each year's and
  kind's count;
- llms.txt follows llmstxt.org's shape, the one its reference parser reads
  (prose only above the first ##, then one `- [name](url): notes` item per
  line, one link each), and links every year's
  /years/<yyyy>/llms.txt; the year files hold every record exactly once, each
  in the file of its Central year, and none passes 4 MB (past that a year is
  split by month); every URL on this site inside the feeds, the JSON files
  and the llms files resolves to a built file;
- /newest/ lists the newest 50 links, and the sitemap lists pages only (no
  feeds, JSON or text files);
- kinds (src/lib/kinds.ts): every JSON twin names a kind and its record page
  files it under the same one for Pagefind; /kinds/ gives each kind's count;
  each /kinds/<kind>/ lists that kind's newest links (at most 1,000), newest
  first, and has its feed pair of the newest 50;
- /about/ renders content/about.md (a title, its sections, links to
  /links.db and /llms.txt, no word of Pinboard), and every page's footer
  links it;
- /links.db is SQLite with the tables tools/build_db.py writes, one row per
  link, host, issue and appearance in data/, the enrichment rows the data
  holds, and no column that says whether a link works;
- no liveness reaches dist/ (Jamie, 2026-10-23: "You don't need to validate
  the links. They just are."): no twin carries a key such as alive, status,
  final_url, redirects, dns or https, and no file names final_url,
  redirects_http or an error the enrichment recorded, unless a saved link's
  own words do; every video player address waits in data-embed for a click
  (youtube-nocookie.com or player.vimeo.com, no iframe in a built page); and
  every image a twin's facts name is under /media/ and built. LINKS_ENRICHMENT
  names the shards the build read, as it does for the build.
"""

import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
SITE = "https://links.thingelstad.xyz"
SHARE_IMAGE = "/share.jpg"
# A record's card, from cards.thingelstad.com: /links/<id>/ draws at
# /links/links/<id>.png, at the v the page hashed from what the card shows.
RECORD_CARD = re.compile(r"https://cards\.thingelstad\.com/links/links/([0-9a-f]{12})\.png\?v=[0-9a-f]{10}")
# The one script from another host, production builds only (Analytics.astro).
TINYLYTICS = "https://tinylytics.app/embed/x4A9AVd_xma4hyT9xLZw.js?kudos=custom"
PRODUCTION = os.environ.get("PUBLIC_TINYLYTICS_ENABLED") == "true"
FEED_SIZE = 50
# A year's llms.txt past this would be split by month (src/lib/dataset.ts).
LLMS_YEAR_LIMIT = 4_000_000
CENTRAL = ZoneInfo("America/Chicago")
# Pinboard's fields, in the mirror's order (docs/DATA.md).
MIRROR_FIELDS = ["id", "hash", "url", "title", "note", "saved", "tags", "toread", "meta"]
# The enrichment shards the build read (src/lib/enrichment.ts).
ENRICHMENT = (
    Path(os.environ["LINKS_ENRICHMENT"]).resolve()
    if os.environ.get("LINKS_ENRICHMENT")
    else ROOT / "data/enrichment"
)
KINDS = ["video", "repository", "book", "paper", "article", "newsletter", "podcast", "page"]
KIND_PAGE_LIMIT = 1000
# Keys that would say whether a link or a host works; never in a twin.
LIVENESS_KEYS = {
    "alive", "status", "final_url", "redirects", "redirects_http", "reachable", "resolves",
    "dns", "https", "error", "rdap_error", "content_type",
}
# Words of the enrichment's liveness that no built file names.
LIVENESS_WORDS = {"final_url", "redirects_http", "rdap_error"}
PLAYERS = ("https://www.youtube-nocookie.com/embed/", "https://player.vimeo.com/video/")
DB_TABLES = {
    "links": ["id", "url", "title", "note", "saved", "tags", "meta", "year", "host"],
    "hosts": ["host", "links", "first", "last"],
    "issues": ["key", "number", "slug", "title", "date", "url"],
    "appearances": ["issue_key", "position", "id", "url", "text", "section"],
    "host_facts": ["host", "registered", "registrar", "expires", "home_title", "generator",
                   "hcard", "webmention", "feeds"],
    "wayback": ["id", "first", "last", "count", "count_capped"],
    "facts": ["id", "method", "kind", "json"],
    "meta": ["key", "value"],
}
# A URL on this site inside a feed, a JSON file or an llms file.
SITE_URL = re.compile(re.escape(SITE) + r"(/[^\s\"'<>()\[\]\\&]*)")
TEXT_SUFFIXES = {".html", ".js", ".css", ".json", ".xml", ".txt", ".md", ".svg"}
# Tags and attributes that a browser fetches when the page loads.
FETCHED = {
    "script": ("src",),
    "img": ("src", "srcset"),
    "iframe": ("src",),
    "frame": ("src",),
    "embed": ("src",),
    "object": ("data",),
    "video": ("src", "poster"),
    "audio": ("src",),
    "source": ("src", "srcset"),
    "track": ("src",),
}
FETCHED_LINK_RELS = {
    "stylesheet",
    "preload",
    "modulepreload",
    "prefetch",
    "icon",
    "apple-touch-icon",
    "manifest",
    "mask-icon",
}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.refs = []
        self.fetched = []
        self.ids = set()
        self.title = False
        self.canonical = None
        self.og_image = None
        self.noindex = False
        self.main = False
        self.inline_urls = []
        self.alternates = []
        self.kudos = []
        self.kind = None  # the record's Pagefind kind filter
        self.embeds = []
        self.iframes = 0
        self.kind_counts = {}  # /kinds/: data-kind to data-count
        self.lede_count = None
        self.h1 = 0
        self.h2 = 0
        self._inline = None
        # Microformats (check_microformats): the tags that are an h-feed,
        # each h-entry with what it carries, the u-url values in main outside
        # any entry (the feed's), and the record each list row's title opens.
        self.feeds = []
        self.entries = []
        self.feed_urls = []
        self.row_records = []
        self._entry_depth = 0
        self._in_main = False

    def handle_starttag(self, tag, attrs):
        data = {key: value or "" for key, value in attrs}
        if data.get("id"):
            self.ids.add(data["id"])
        self.title |= tag == "title"
        self.main |= tag == "main"
        rels = set(data.get("rel", "").lower().split())
        if tag == "link" and "canonical" in rels:
            self.canonical = data.get("href")
        if tag == "meta" and data.get("property") == "og:image":
            self.og_image = data.get("content")
        if tag == "meta" and data.get("name", "").lower() == "robots":
            self.noindex |= "noindex" in data.get("content", "").lower()
        if tag == "link" and "alternate" in rels:
            self.alternates.append((data.get("type", ""), data.get("href", "")))
        if tag == "script" and not data.get("src"):
            self._inline = []
        if tag == "button" and "tinylytics_kudos" in data.get("class", "").split():
            self.kudos.append(data)
        if data.get("data-pagefind-filter", "").startswith("kind["):
            self.kind = data.get("data-kind")
        if tag == "li" and "data-kind" in data and "data-count" in data:
            self.kind_counts[data["data-kind"]] = data["data-count"]
        if tag == "p" and "lede" in data.get("class", "").split() and "data-count" in data:
            self.lede_count = data["data-count"]
        if "data-embed" in data:
            self.embeds.append(data["data-embed"])
        self.microformats(tag, data)
        self.iframes += tag == "iframe"
        self.h1 += tag == "h1"
        self.h2 += tag == "h2"
        for key in ("href", "src", "data"):
            if data.get(key) and not (tag == "object" and key != "data"):
                self.refs.append(data[key])
        for key in ("srcset",):
            for candidate in data.get(key, "").split(","):
                if candidate.strip():
                    self.refs.append(candidate.split()[0])
        loads = [data.get(key, "") for key in FETCHED.get(tag, ())]
        if tag == "link" and rels & FETCHED_LINK_RELS:
            loads.append(data.get("href", ""))
        for value in loads:
            for candidate in value.split(",") if "," in value else [value]:
                if candidate.strip():
                    self.fetched.append(candidate.split()[0])

    def microformats(self, tag, data):
        classes = set(data.get("class", "").split())
        self._in_main |= tag == "main"
        if self._entry_depth and tag == self.entries[-1]["tag"]:
            self._entry_depth += 1
        if "h-feed" in classes:
            self.feeds.append(tag)
        if "h-entry" in classes:
            if self._entry_depth:
                self.entries[-1]["nested"] += 1
            else:
                self.entries.append(
                    {"tag": tag, "urls": [], "names": 0, "published": [], "nested": 0}
                )
                self._entry_depth = 1
        if self._entry_depth:
            entry = self.entries[-1]
            if "u-url" in classes:
                entry["urls"].append(data.get("value" if tag == "data" else "href"))
            entry["names"] += "p-name" in classes
            if "dt-published" in classes:
                entry["published"].append(data.get("datetime"))
        elif self._in_main and tag == "data" and "u-url" in classes:
            self.feed_urls.append(data.get("value"))
        if tag == "a" and "title" in classes and record_id(data.get("href", "")):
            self.row_records.append(record_id(data["href"]))

    def handle_data(self, data):
        if self._inline is not None:
            self._inline.append(data)

    def handle_endtag(self, tag):
        if tag == "main":
            self._in_main = False
        if self._entry_depth and tag == self.entries[-1]["tag"]:
            self._entry_depth -= 1
        # A URL written into an inline script is fetched as surely as a src.
        if tag == "script" and self._inline is not None:
            text = "".join(self._inline)
            self.inline_urls.extend(re.findall(r"""https?://[^\s'"`<>)]+""", text))
            self._inline = None


def page_url(rel):
    """The public URL of a built file: dir/index.html is /dir/."""
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def target_file(path):
    key = path.lstrip("/")
    if key == "" or key.endswith("/"):
        return DIST / key / "index.html"
    return DIST / key


# Routes CloudFront sends to another origin, so no built file stands behind
# them: /mcp is the MCP server (infra/site.json, src/mcp/).
ROUTED_ELSEWHERE = {"/mcp"}


def built(path):
    """A path on this site that resolves: a built file, or a route served by
    another origin."""
    return path in ROUTED_ELSEWHERE or target_file(path).exists()


def off_site(ref):
    parts = urlsplit(ref)
    if ref.startswith("//"):
        return True
    return bool(parts.scheme) and parts.scheme in ("http", "https") and (
        f"{parts.scheme}://{parts.netloc}" != SITE
    )


RECORD_PATH = re.compile(r"^/links/([0-9a-f]{12})/$")


def record_id(url):
    """The id of a record permalink (absolute or a path), or None."""
    path = url[len(SITE):] if url.startswith(SITE + "/") else url
    match = RECORD_PATH.match(path)
    return match and match.group(1)


# The pages that list records, and so are an h-feed of them.
FEED_PAGE = re.compile(r"/newest/|/(hosts|kinds|years|issues)/[^/]+/")


def check_microformats(rel, url, parser, saved, problems):
    """A record is one h-entry with its permalink as u-url; a page listing
    records is an h-feed (its main) of one h-entry per record row; no other
    page has either. saved maps a record id to its saved time."""
    if any(entry["nested"] for entry in parser.entries):
        problems.append(f"{rel}: an h-entry inside an h-entry")
    if record_id(url):
        if parser.feeds or [e["urls"] for e in parser.entries] != [[SITE + url]]:
            problems.append(f"{rel}: the record is not one h-entry with its permalink as u-url")
        return
    rows = parser.row_records
    if not (FEED_PAGE.fullmatch(url) and rows):
        if parser.feeds or parser.entries:
            problems.append(f"{rel}: an h-feed or h-entry on a page that lists no records")
        return
    if parser.feeds != ["main"] or parser.feed_urls != [SITE + url]:
        problems.append(f"{rel}: main is not its one h-feed, with the page as u-url")
    entries = [(e["urls"], e["names"], e["published"]) for e in parser.entries]
    expected = [([f"/links/{record}/"], 1, [saved.get(record)]) for record in rows]
    if entries != expected:
        problems.append(
            f"{rel}: not one h-entry per listed record"
            " (p-name, u-url the record, dt-published its saved time)"
        )


def central_moment(moment):
    """True when an aware datetime carries the offset Central had then."""
    return moment is not None and moment.tzinfo is not None and (
        moment.utcoffset() == moment.astimezone(CENTRAL).utcoffset()
    )


def rss_items(path, problems):
    """An RSS 2.0 feed's items as (link, moment); None when it is not RSS."""
    rel = path.relative_to(DIST).as_posix()
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        problems.append(f"{rel}: not well-formed XML ({error})")
        return None
    channel = root.find("channel")
    if root.tag != "rss" or root.get("version") != "2.0" or channel is None:
        problems.append(f"{rel}: not an RSS 2.0 document")
        return None
    for name in ("title", "link", "description"):
        if not (channel.findtext(name) or "").strip():
            problems.append(f"{rel}: the channel has no {name}")
    selves = [
        link.get("href")
        for link in channel.findall("{http://www.w3.org/2005/Atom}link")
        if link.get("rel") == "self"
    ]
    if selves != [SITE + "/" + rel]:
        problems.append(f"{rel}: atom:link rel=self is {selves}, not {SITE}/{rel}")
    items = []
    for item in channel.findall("item"):
        link = (item.findtext("link") or "").strip()
        guid = item.find("guid")
        if guid is None or guid.text != link or guid.get("isPermaLink") != "true":
            problems.append(f"{rel}: item {link} has no permalink guid equal to its link")
        for name in ("title", "description"):
            if not (item.findtext(name) or "").strip():
                problems.append(f"{rel}: item {link} has no {name}")
        try:
            moment = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            moment = None
        if not central_moment(moment):
            problems.append(f"{rel}: item {link} pubDate is not RFC 822, Central")
        items.append((link, moment))
    return items


def json_feed_items(path, problems):
    """A JSON Feed 1.1's items as (url, moment); None when it is not one."""
    rel = path.relative_to(DIST).as_posix()
    try:
        feed = json.loads(path.read_text())
    except ValueError as error:
        problems.append(f"{rel}: not JSON ({error})")
        return None
    if feed.get("version") != "https://jsonfeed.org/version/1.1":
        problems.append(f"{rel}: not JSON Feed 1.1")
        return None
    if not feed.get("title") or not str(feed.get("home_page_url", "")).startswith(SITE + "/"):
        problems.append(f"{rel}: no title or home_page_url")
    if feed.get("feed_url") != SITE + "/" + rel:
        problems.append(f"{rel}: feed_url is {feed.get('feed_url')}, not {SITE}/{rel}")
    items = []
    for item in feed.get("items", []):
        url = item.get("url", "")
        if item.get("id") != url or not item.get("external_url"):
            problems.append(f"{rel}: item {url} needs id equal to url, and external_url")
        if not item.get("title") or not (item.get("content_html") and item.get("content_text")):
            problems.append(f"{rel}: item {url} has no title, content_html or content_text")
        tags = item.get("tags", [])
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            problems.append(f"{rel}: item {url} tags are not a list of strings")
        try:
            moment = datetime.fromisoformat(item.get("date_published", ""))
        except (TypeError, ValueError):
            moment = None
        if not central_moment(moment):
            problems.append(f"{rel}: item {url} date_published is not RFC 3339, Central")
        items.append((url, moment))
    return items


def check_feed_pair(folder, expected, problems):
    """The feed.xml and feed.json in folder: valid, alike, and the expected ids."""
    rel = folder.relative_to(DIST).as_posix() + "/" if folder != DIST else ""
    rss = jsn = None
    if (folder / "feed.xml").exists():
        rss = rss_items(folder / "feed.xml", problems)
    if (folder / "feed.json").exists():
        jsn = json_feed_items(folder / "feed.json", problems)
    if rss is None or jsn is None:
        problems.append(f"{rel}feed.xml and feed.json: missing or invalid")
        return
    if rss != jsn:
        problems.append(f"{rel}feed.xml and feed.json carry different items")
    ids = [record_id(link) for link, _ in rss]
    if ids != expected:
        problems.append(f"{rel}feed.xml: its items are not the newest {len(expected)} links")
    moments = [m for _, m in rss if m]
    if any(a < b for a, b in zip(moments, moments[1:])):
        problems.append(f"{rel}feed.xml: items are not newest first")


def check_tinylytics(records, kudos, loaders, content_names_tinylytics, problems):
    """Kudos on every record; tinylytics.app in no file but the pages."""
    for record in records:
        buttons = [(b.get("data-path"), b.get("data-private")) for b in kudos[f"/links/{record}/"]]
        if buttons != [(f"/links/{record}/", None)]:
            problems.append(
                f"links/{record}/: needs one public Kudos button keyed on its permalink"
                " (no data-private)"
            )
    if not content_names_tinylytics:
        for file in sorted(DIST.rglob("*")):
            if file.suffix in TEXT_SUFFIXES - {".html"} and file.is_file():
                if b"tinylytics.app" in file.read_bytes():
                    problems.append(f"{file.relative_to(DIST)}: mentions tinylytics.app")
    if not PRODUCTION and loaders:
        # First, so it survives the cut to 40 lines.
        problems.insert(
            0,
            f"{loaders} pages load Tinylytics: this build was made with"
            " PUBLIC_TINYLYTICS_ENABLED=true; validate it with the same setting",
        )


def check_feeds(newest, host_pages, alternates, listed_records, problems):
    """The site's pair holds the newest links; every host page has its pair."""
    check_feed_pair(DIST, newest[:FEED_SIZE], problems)
    kinds = (("application/rss+xml", "feed.xml"), ("application/feed+json", "feed.json"))
    for page in host_pages:
        url = page_url(page.relative_to(DIST).as_posix())
        for kind, name in kinds:
            if (kind, url + name) not in alternates[url]:
                problems.append(f"{url}: does not advertise its {name}")
        # The host page lists its links newest first.
        check_feed_pair(page.parent, listed_records[url][:FEED_SIZE], problems)
    for feed in DIST.rglob("feed.*"):
        if not (feed.parent / "index.html").exists():
            problems.append(f"{feed.relative_to(DIST)}: a feed with no page")
    return 2 * (1 + len(host_pages))


def load_json(name, problems):
    try:
        return json.loads((DIST / name).read_text())
    except (OSError, ValueError) as error:
        problems.append(f"{name}: missing or not JSON ({error})")
        return {}


def check_dataset(data_links, newest, host_pages, twin_kinds, problems):
    """links.json is lossless and Pinboard-shaped, then permalink and kind;
    hosts and issues match."""
    by_id = {link["id"]: link for link in data_links}
    everything = load_json("links.json", problems)
    rows = everything.get("links", [])
    if everything.get("site") != SITE or everything.get("count") != len(data_links):
        problems.append(f"links.json: site or count wrong ({len(rows)} rows)")
    if [row.get("id") for row in rows] != newest:
        problems.append("links.json: not every record, newest first")
    for row in rows:
        link = by_id.get(row.get("id"))
        same = link is not None and all(row.get(f) == link[f] for f in MIRROR_FIELDS)
        if not same or list(row) != MIRROR_FIELDS + ["permalink", "kind"] or (
            row["permalink"] != f"{SITE}/links/{row['id']}/"
        ):
            problems.append(f"links.json: {row.get('id')} is not its record as data/links has it")
        elif row["kind"] != twin_kinds.get(row["id"]):
            problems.append(
                f"links.json: {row['id']} has kind {row['kind']!r},"
                f" its twin {twin_kinds.get(row['id'])!r}"
            )

    hosts = load_json("hosts.json", problems).get("hosts", [])
    if len(hosts) != len(host_pages) or sum(h.get("count", 0) for h in hosts) != len(by_id):
        problems.append(f"hosts.json: {len(hosts)} hosts for {len(host_pages)} host pages")
    for host in hosts:
        if list(host) != ["host", "count", "first", "last", "url"] or (
            host["url"] != f"{SITE}/hosts/{host['host']}/"
        ):
            problems.append(f"hosts.json: {host.get('host')} is not host, count, first, last, url")

    derived = json.loads((ROOT / "data/derived/issues.json").read_text())["issues"]
    joined = load_json("issues.json", problems).get("issues", [])
    if len(joined) != len(derived):
        problems.append(f"issues.json: {len(joined)} issues for {len(derived)} in the join")
    for issue, source in zip(joined, derived):
        plain = {k: v for k, v in issue.items() if k not in ("page", "links")}
        plain["links"] = [
            {k: v for k, v in row.items() if k != "permalink"} for row in issue.get("links", [])
        ]
        if plain != source or not str(issue.get("page", "")).startswith(SITE + "/issues/"):
            problems.append(f"issues.json: issue {source['slug']} differs from the join")
        for row in issue.get("links", []):
            if row.get("permalink") != (f"{SITE}/links/{row['id']}/" if row.get("id") else None):
                problems.append(f"issues.json: {source['slug']} link {row.get('position')}")


def central_year(saved):
    return datetime.fromisoformat(saved.replace("Z", "+00:00")).astimezone(CENTRAL).year


def check_suggest(data_links, twin_kinds, twin_hosts, problems):
    """/search/suggest.json agrees with /hosts.json, /issues.json, the
    Central years and the kinds; each host's years are its twins' Central
    years, from its first to its last."""
    suggest = load_json("search/suggest.json", problems)
    if list(suggest) != ["hosts", "issues", "years", "kinds"]:
        problems.append("search/suggest.json: not hosts, issues, years, kinds")
        return
    hosts = load_json("hosts.json", problems).get("hosts", [])
    if [row[:2] for row in suggest["hosts"]] != [[h["host"], h["count"]] for h in hosts]:
        problems.append("search/suggest.json: hosts are not /hosts.json's, in its order")
    by_host = {}
    for link in data_links:
        counts = by_host.setdefault(twin_hosts.get(link["id"]), {})
        year = central_year(link["saved"])
        counts[year] = counts.get(year, 0) + 1
    for row in suggest["hosts"]:
        counts = by_host.get(row[0], {})
        first, last = (min(counts), max(counts)) if counts else (0, -1)
        if len(row) != 3 or row[2] != [first] + [counts.get(y, 0) for y in range(first, last + 1)]:
            problems.append(f"search/suggest.json: {row[0]}'s years are not its links' Central years")
            break
    joined = sorted(
        load_json("issues.json", problems).get("issues", []),
        key=lambda issue: issue["date"],
        reverse=True,
    )
    expected = []
    for issue in joined:
        day = datetime.fromisoformat(issue["date"].replace("Z", "+00:00")).astimezone(CENTRAL)
        key = issue["page"].removeprefix(f"{SITE}/issues/").rstrip("/")
        carried = len({row["id"] for row in issue["links"] if row.get("id")})
        expected.append([key, issue["title"], f"{day:%b} {day.day}, {day.year}", carried])
    if suggest["issues"] != expected:
        rows = zip(suggest["issues"], expected)
        first = next((a for a, b in rows if a != b), f"{len(suggest['issues'])} of {len(expected)}")
        problems.append(f"search/suggest.json: issues differ from /issues.json (first {first})")
    years = {}
    for link in data_links:
        year = central_year(link["saved"])
        years[year] = years.get(year, 0) + 1
    if suggest["years"] != [[y, years[y]] for y in sorted(years, reverse=True)]:
        problems.append("search/suggest.json: years are not each Central year's count, newest first")
    kinds = [[kind, sum(1 for k in twin_kinds.values() if k == kind)] for kind in KINDS]
    if suggest["kinds"] != kinds:
        problems.append("search/suggest.json: kinds are not each kind's count, in order")
    return len(suggest["hosts"]), len(suggest["issues"])


RECORD_LINE = re.compile(r"^- Record: (\S+)$", re.M)

# llmstxt.org's reference parser (the llms-txt package, parse_llms_file) splits
# the file at every line that starts "##" (so "###" too) and reads each
# non-empty line under one as a `- [name](url): notes` item. A line with no
# link breaks the whole parse; a second link on a line is silently dropped;
# a name ends at its first "]". Above the first "##" go the "# " title, an
# optional "> " summary and prose, with no headings.
LLMS_ITEM = re.compile(r"^- \[[^\[\]]+\]\(https?:[^)\s]+\)(: \S.*)?$")


def llms_shape_problems(text, name="llms.txt"):
    """Every way llms.txt strays from what the reference parser reads."""
    found = []
    head, *rest = re.split(r"^##\s*(.*?$)", text, flags=re.M)
    lines = head.strip().splitlines()
    if not lines or not lines[0].startswith("# "):
        found.append(f"{name}: does not open with a '# ' title")
    for line in lines[1:]:
        if line.startswith("#"):
            found.append(f"{name}: a heading above the first section: {line[:60]}")
    if not rest:
        found.append(f"{name}: no sections")
    headings = rest[0::2]
    for heading in sorted({h for h in headings if headings.count(h) > 1}):
        found.append(f"{name}: two sections named '{heading}'; the parser keeps one")
    for heading, body in zip(rest[0::2], rest[1::2]):
        for line in body.splitlines():
            if line.strip() and (not LLMS_ITEM.match(line) or line.count("](") != 1):
                found.append(
                    f"{name}: under '{heading}', not one '- [name](url): notes' item: {line[:80]}"
                )
    return found


def year_llms_files():
    return sorted(DIST.glob("years/*/llms.txt"))


def check_llms(data_links, problems):
    """llms.txt has llmstxt.org's shape (an H1, a blockquote, then sections of
    one-link items the reference parser reads), its links resolve and it links
    every year file; the year files hold every record once, each in its own
    Central year, newest first."""
    file = DIST / "llms.txt"
    llms = file.read_text() if file.exists() else ""
    lines = llms.splitlines()
    if not lines or not lines[0].startswith("# ") or not any(line.startswith("> ") for line in lines):
        problems.append("llms.txt: needs an H1 and a blockquote summary")
    problems += llms_shape_problems(llms)
    targets = re.findall(r"\]\(([^)\s]+)\)", llms)
    for target in targets:
        path = target[len(SITE):] if target.startswith(SITE + "/") else None
        if path is None or not built(unquote(urlsplit(path).path)):
            problems.append(f"llms.txt: {target} is not a built file on this site")
    if (DIST / "llms-full.txt").exists():
        problems.append("llms-full.txt: replaced by the year files; it should not be built")

    saved = {link["id"]: link["saved"] for link in data_links}
    years = {
        datetime.fromisoformat(moment.replace("Z", "+00:00")).astimezone(CENTRAL).year
        for moment in saved.values()
    }
    files = year_llms_files()
    if {int(f.parent.name) for f in files} != years:
        problems.append(f"years/*/llms.txt: {len(files)} files for {len(years)} years with links")
    seen = {}
    for f in files:
        rel = f.relative_to(DIST).as_posix()
        if SITE + "/" + rel not in targets:
            problems.append(f"llms.txt: does not link {rel}")
        text = f.read_text()
        if len(text.encode()) > LLMS_YEAR_LIMIT:
            problems.append(f"{rel}: over {LLMS_YEAR_LIMIT // 1_000_000} MB; split the year by month")
        if not text.startswith("# ") or "\n> " not in text:
            problems.append(f"{rel}: needs an H1 and a blockquote summary")
        ids = [record_id(url) for url in RECORD_LINE.findall(text)]
        if None in ids:
            problems.append(f"{rel}: a Record line that is not a record permalink")
        ids = [i for i in ids if i]
        year = int(f.parent.name)
        for i in ids:
            seen[i] = seen.get(i, 0) + 1
            moment = saved.get(i)
            if moment is None:
                problems.append(f"{rel}: {i} is not a saved link")
            elif datetime.fromisoformat(moment.replace("Z", "+00:00")).astimezone(CENTRAL).year != year:
                problems.append(f"{rel}: {i} was not saved in {year}")
        moments = [saved[i] for i in ids if i in saved]
        if moments != sorted(moments, reverse=True):
            problems.append(f"{rel}: records are not newest first")
    missing = sorted(set(saved) - set(seen))
    twice = sorted(i for i, n in seen.items() if n > 1)
    if missing or twice:
        problems.append(
            f"years/*/llms.txt: {len(missing)} records missing (first {missing[:3]}),"
            f" {len(twice)} listed more than once (first {twice[:3]})"
        )
    return files


def check_site_urls(problems):
    """Every URL on this site inside the feeds, the JSON files and the llms
    files names a built file."""
    names = ("links.json", "hosts.json", "issues.json", "llms.txt")
    inside = set()
    files = [DIST / name for name in names] + year_llms_files() + sorted(DIST.rglob("feed.*"))
    for file in files:
        if file.exists():
            # A sentence may end just after a URL; no path here ends in . or ,
            inside.update(path.rstrip(".,") for path in SITE_URL.findall(file.read_text()))
    for path in sorted(inside):
        if not built(unquote(path)):
            problems.append(f"{SITE}{path} is named in a feed or data file but not built")
    return inside


def check_newest(newest, listed_records, problems):
    """/newest/ lists the newest links, the site feed's, in order."""
    if listed_records.get("/newest/") != newest[:FEED_SIZE]:
        problems.append(f"/newest/: does not list the newest {FEED_SIZE} links, newest first")


def walk_keys(value):
    """Every key at any depth of a JSON value."""
    if isinstance(value, dict):
        for key, inner in value.items():
            yield key
            yield from walk_keys(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from walk_keys(inner)


def liveness_words(data_links):
    """The words no built file may hold: the enrichment's liveness field names
    and every error it recorded, less any a saved link's own words use."""
    words = set(LIVENESS_WORDS)
    for folder in ("hosts", "pages", "facts"):
        for shard in sorted((ENRICHMENT / folder).glob("*.json")):
            for record in json.loads(shard.read_text()).values():
                if not isinstance(record, dict):
                    continue
                home = record.get("home") if isinstance(record.get("home"), dict) else {}
                for value in (record.get("error"), record.get("rdap_error"), home.get("error")):
                    if isinstance(value, str) and len(value.strip()) >= 6:
                        words.add(value.strip())
    saved = "\n".join(
        f"{link['url']} {link['title']} {link['note']} {' '.join(link['tags'])}" for link in data_links
    )
    return sorted(word for word in words if word not in saved)


def check_kinds(twin_kinds, record_kinds, newest, kind_pages, alternates, listed_records, problems):
    """Every record has one kind, the same on its page; /kinds/ counts each;
    each kind page lists its newest links and has its feed pair."""
    by_kind = {kind: [] for kind in KINDS}
    for record in newest:
        kind = twin_kinds.get(record)
        if kind not in by_kind:
            problems.append(f"links/{record}.json: kind {kind!r} is not one of the kinds")
            continue
        by_kind[kind].append(record)
        if record_kinds.get(record) != kind:
            problems.append(f"links/{record}/: its Pagefind kind is not its twin's, {kind}")
    built = {p.name for p in (DIST / "kinds").iterdir() if p.is_dir()} if (DIST / "kinds").exists() else set()
    if built != set(KINDS):
        problems.append(f"kinds/: pages for {sorted(built)}, not {KINDS}")
    index = kind_pages.get("/kinds/")
    counts = index.kind_counts if index else {}
    if list(counts) != KINDS:
        problems.append(f"/kinds/: lists {list(counts)}, not every kind in order")
    kinds_feeds = (("application/rss+xml", "feed.xml"), ("application/feed+json", "feed.json"))
    for kind, records in by_kind.items():
        url = f"/kinds/{kind}/"
        page = kind_pages.get(url)
        if counts.get(kind) != str(len(records)) or not page or page.lede_count != str(len(records)):
            problems.append(f"{url}: does not count its {len(records)} links")
        if listed_records.get(url) != records[:KIND_PAGE_LIMIT]:
            problems.append(
                f"{url}: does not list the newest {min(len(records), KIND_PAGE_LIMIT)} links"
                " of the kind, newest first"
            )
        for type_, name in kinds_feeds:
            if (type_, url + name) not in alternates.get(url, []):
                problems.append(f"{url}: does not advertise its {name}")
        check_feed_pair(DIST / "kinds" / kind, records[:FEED_SIZE], problems)
    return {kind: len(records) for kind, records in by_kind.items()}


def check_about(about, without_about, problems):
    """/about/ renders content/about.md, and every page's footer links it."""
    file = DIST / "about/index.html"
    if about is None or not file.exists():
        problems.append("/about/: not built")
        return
    if about.h1 != 1 or about.h2 < 1:
        problems.append(f"/about/: {about.h1} titles and {about.h2} sections")
    for target in ("/links.db", "/llms.txt"):
        if target not in about.refs:
            problems.append(f"/about/: does not link {target}")
    words = re.sub(r"<[^>]+>", " ", file.read_text()).lower()
    if "pinboard" in words:
        problems.append("/about/: names Pinboard")
    if without_about:
        problems.append(
            f"{len(without_about)} pages do not link /about/ from the footer"
            f" (first {without_about[:3]})"
        )


def check_db(data_links, problems):
    """/links.db: the tables tools/build_db.py writes, its rows those of data/
    and the enrichment the build read, and no liveness column."""
    path = DIST / "links.db"
    if not path.exists():
        problems.append("links.db: not built (npm run db)")
        return {}
    sys.path.insert(0, str(ROOT / "tools"))
    import build_db  # noqa: PLC0415 - tools/build_db.py, the file's maker

    expected = build_db.rows(build_db.load(ROOT, ENRICHMENT))
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = {
            name: [column[1] for column in db.execute(f"PRAGMA table_info({name})")]
            for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if tables != DB_TABLES:
            problems.append(f"links.db: tables {sorted(tables)} are not tools/build_db.py's")
        for name, columns in tables.items():
            if LIVENESS_KEYS & set(columns):
                problems.append(f"links.db: {name} has a liveness column")
        counts = {
            name: db.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
            for name in DB_TABLES
            if name in tables
        }
        ids = {row[0] for row in db.execute("SELECT id FROM links")} if "links" in tables else set()
        meta = dict(db.execute("SELECT key, value FROM meta")) if "meta" in tables else {}
    finally:
        db.close()
    derived = json.loads((ROOT / "data/derived/issues.json").read_text())["issues"]
    independent = {
        "links": len(data_links),
        "issues": len(derived),
        "appearances": sum(len(issue["links"]) for issue in derived),
    }
    for name, n in {**{k: len(v) for k, v in expected.items()}, **independent}.items():
        if counts.get(name) != n:
            problems.append(f"links.db: {counts.get(name)} rows in {name}, not {n}")
        if name != "meta" and meta.get(f"count.{name}") != str(n):
            problems.append(f"links.db: meta count.{name} is not {n}")
    if ids != {link["id"] for link in data_links}:
        problems.append("links.db: its links are not the saved links")
    return counts


def robots_rules(text):
    """The Allow and Disallow paths robots.txt gives every crawler (User-agent: *)."""
    rules, agents, in_rules = [], set(), False
    for line in text.splitlines():
        key, _, value = line.split("#", 1)[0].partition(":")
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            if in_rules:
                agents, in_rules = set(), False
            agents.add(value)
        elif key in ("allow", "disallow"):
            in_rules = True
            if "*" in agents and value:
                rules.append((key == "allow", value))
    return rules


def robots_allows(rules, path):
    """RFC 9309: the longest matching path wins, and Allow wins a tie. Python's
    urllib.robotparser takes the first match instead, so this site's leading
    Allow: / would hide every Disallow from it. No rule here uses * or $."""
    matches = [(len(rule), allow) for allow, rule in rules if path.startswith(rule)]
    return max(matches, default=(0, True))[1]


def main():
    problems = []
    if not (DIST / SHARE_IMAGE.lstrip("/")).is_file():
        problems.append(f"{SHARE_IMAGE} is missing: run npm run share-image")
    sites = json.loads((ROOT / "shared/sites.json").read_text())
    allowed_off_site = {sites["owner"]["avatar"]}
    owner_u_url = f'<data class="u-url" value="{sites["owner"]["url"]}"></data>'
    if PRODUCTION:
        allowed_off_site.add(TINYLYTICS)
    pages = sorted(DIST.rglob("*.html"))
    if not pages:
        sys.exit("No pages in dist/. Run npm run build first.")
    data_links = [
        link
        for file in sorted((ROOT / "data/links").glob("[0-9][0-9][0-9][0-9].json"))
        for link in json.loads(file.read_text())
    ]
    # A saved link about Tinylytics would put its name in the content; then
    # only the fetch checks apply, and this says so.
    content_names_tinylytics = any(
        "tinylytics.app" in (link["url"] + link["title"] + link["note"]).lower()
        for link in data_links
    )
    saved_at = {link["id"]: link["saved"] for link in data_links}
    feed_pages = 0

    ids = {}
    links = []  # (page, ref, target url path, fragment)
    off_site_seen = set()
    alternates = {}  # page url to its <link rel="alternate"> (type, href)
    kudos = {}  # page url to its Kudos buttons
    record_kinds = {}  # record id to its Pagefind kind
    kind_pages = {}  # /kinds/ and each kind page, parsed
    about = None
    without_about = []
    words = liveness_words(data_links)
    listed_records = {}  # host pages and /newest/ to the records they list, in order
    loaders = 0
    noindex = set()  # pages marked noindex, by URL
    for page in pages:
        rel = page.relative_to(DIST).as_posix()
        url = page_url(rel)
        text = page.read_text()
        parser = Page()
        parser.feed(text)
        ids[url] = parser.ids
        if parser.noindex and rel != "404.html":
            noindex.add(url)
            if not re.fullmatch(r"/(links|hosts)/[^/]+/|/surprise/", url):
                problems.append(f"{rel}: marked noindex, but only records, host pages and /surprise/ may be")
        alternates[url] = parser.alternates
        kudos[url] = parser.kudos
        if url.startswith(("/hosts/", "/kinds/")) or url == "/newest/":
            listed_records[url] = [
                record_id(ref) for ref in parser.refs if record_id(ref)
            ]
        if record_id(url):
            record_kinds[record_id(url)] = parser.kind
        if url.startswith("/kinds/"):
            kind_pages[url] = parser
        if url == "/about/":
            about = parser
        if "/about/" not in parser.refs:
            without_about.append(url)
        card = re.search(r'<a class="h-card".*?</a>', text, re.S)
        if not card or owner_u_url not in card.group():
            problems.append(f"{rel}: the footer h-card does not carry owner.url as its u-url")
        check_microformats(rel, url, parser, saved_at, problems)
        feed_pages += parser.feeds == ["main"]
        for embed in parser.embeds:
            if not embed.startswith(PLAYERS):
                problems.append(f"{rel}: a video player at {embed}")
        if parser.iframes:
            problems.append(f"{rel}: an iframe in the built page (players load on a click)")
        for word in words:
            if word in text:
                problems.append(f"{rel}: names {word!r}, which says whether a link works")
        mentions = text.count("tinylytics.app")
        loaded = parser.inline_urls.count(TINYLYTICS)
        loaders += loaded
        if PRODUCTION and loaded != 1:
            problems.append(f"{rel}: loads the Tinylytics script {loaded} times, not once")
        if mentions and not content_names_tinylytics and (
            not PRODUCTION or mentions != text.count(TINYLYTICS) or mentions != loaded
        ):
            problems.append(
                f"{rel}: mentions tinylytics.app"
                + (" beyond the one script" if PRODUCTION else " in a non-production build")
            )
        for flag, name in ((parser.title, "title"), (parser.main, "main")):
            if not flag:
                problems.append(f"{rel}: no {name}")
        record = re.fullmatch(r"/links/([0-9a-f]{12})/", url)
        if record:
            card = RECORD_CARD.fullmatch(parser.og_image or "")
            if not card or card.group(1) != record.group(1):
                problems.append(f"{rel}: og:image {parser.og_image} is not its card")
        elif parser.og_image != SITE + SHARE_IMAGE:
            problems.append(f"{rel}: og:image {parser.og_image} is not {SITE + SHARE_IMAGE}")
        if rel != "404.html":
            if not parser.canonical:
                problems.append(f"{rel}: no canonical")
            elif parser.canonical != SITE + url:
                problems.append(f"{rel}: canonical {parser.canonical} is not {SITE + url}")
        for ref in parser.fetched + parser.inline_urls:
            if off_site(ref):
                if ref in allowed_off_site:
                    off_site_seen.add(ref)
                else:
                    problems.append(f"{rel}: fetches {ref} from another host")
        for ref in parser.refs:
            parts = urlsplit(ref)
            if parts.scheme or ref.startswith(("//", "data:", "mailto:")):
                if ref.startswith(SITE + "/"):
                    parts = urlsplit(ref[len(SITE):])
                else:
                    continue
            if ref.startswith("#"):
                if ref[1:] and unquote(ref[1:]) not in parser.ids:
                    problems.append(f"{rel}: no id for {ref}")
                continue
            path = unquote(parts.path)
            if not path.startswith("/"):
                base = url if url.endswith("/") else url.rsplit("/", 1)[0] + "/"
                path = base + path
            links.append((rel, ref, path, unquote(parts.fragment)))

    for rel, ref, path, fragment in links:
        if not built(path):
            problems.append(f"{rel}: broken link {ref}")
        elif fragment and path in ids and fragment not in ids[path]:
            problems.append(f"{rel}: {ref} names an id the page does not have")

    # Sitemaps.
    loc = re.compile(r"<loc>([^<]+)</loc>")
    index = DIST / "sitemap-index.xml"
    listed = []
    if not index.exists():
        problems.append("no sitemap-index.xml")
    else:
        for sitemap in loc.findall(index.read_text()):
            file = DIST / sitemap.removeprefix(SITE + "/")
            if not sitemap.startswith(SITE + "/") or not file.exists():
                problems.append(f"sitemap index lists {sitemap}, which is not built")
                continue
            listed.extend(loc.findall(file.read_text()))
    seen = set()
    for entry in listed:
        if entry in seen:
            problems.append(f"sitemap lists {entry} twice")
        seen.add(entry)
        if not entry.startswith(SITE + "/"):
            problems.append(f"sitemap URL {entry} is not on {SITE}")
        elif not target_file(unquote(urlsplit(entry).path)).exists():
            problems.append(f"sitemap URL {entry} is not built")
    for page in pages:
        url = page_url(page.relative_to(DIST).as_posix())
        if url == "/404.html":
            continue
        if url in noindex and SITE + url in seen:
            problems.append(f"{url} is marked noindex but is in the sitemap")
        elif url not in noindex and SITE + url not in seen:
            problems.append(f"{url} is not in the sitemap")
    robots = robots_rules((DIST / "robots.txt").read_text())
    for url in sorted(noindex):
        if not robots_allows(robots, url):
            problems.append(f"{url} is marked noindex but robots.txt disallows it")

    # Records, twins and the data.
    records = sorted(p.parent.name for p in (DIST / "links").glob("*/index.html"))
    twin_kinds = {}
    twin_hosts = {}
    images = 0
    for record in records:
        twin = DIST / "links" / f"{record}.json"
        markdown = DIST / "links" / f"{record}.md"
        if not twin.exists():
            problems.append(f"links/{record}/: no JSON twin")
            continue
        twin_text = twin.read_text()
        doc = json.loads(twin_text)
        if doc.get("id") != record:
            problems.append(f"links/{record}.json: names another id")
        twin_kinds[record] = doc.get("kind")
        twin_hosts[record] = doc.get("host")
        live = sorted(LIVENESS_KEYS & set(walk_keys(doc)))
        if live:
            problems.append(f"links/{record}.json: carries {live}")
        image = (doc.get("facts") or {}).get("image")
        if image:
            images += 1
            if not image.startswith(SITE + "/media/") or not target_file(image[len(SITE):]).exists():
                problems.append(f"links/{record}.json: its image {image} is not built under /media/")
        md_text = markdown.read_text() if markdown.exists() else None
        if md_text is None:
            problems.append(f"links/{record}/: no Markdown twin")
        for word in words:
            if word in twin_text or (md_text and word in md_text):
                problems.append(f"links/{record}: a twin names {word!r}")
    saved = [link["id"] for link in data_links]
    if sorted(saved) != records:
        missing = sorted(set(saved) - set(records))[:5]
        extra = sorted(set(records) - set(saved))[:5]
        problems.append(
            f"{len(records)} record pages for {len(saved)} links"
            f" (missing {missing}, extra {extra})"
        )

    # Pagefind.
    entry = DIST / "pagefind/pagefind-entry.json"
    if not entry.exists():
        problems.append("no Pagefind index (pagefind/pagefind-entry.json)")
    else:
        indexed = sum(
            language["page_count"]
            for language in json.loads(entry.read_text())["languages"].values()
        )
        if indexed != len(records):
            problems.append(f"Pagefind indexed {indexed} pages for {len(records)} records")

    # Sitemaps list pages only: nothing that is a feed, JSON or text.
    for entry in seen:
        if not entry.endswith("/"):
            problems.append(f"sitemap lists {entry}, which is not a page")

    check_tinylytics(records, kudos, loaders, content_names_tinylytics, problems)
    newest = [
        link["id"]
        for link in sorted(data_links, key=lambda r: (r["saved"], r["id"]), reverse=True)
    ]
    host_pages = sorted((DIST / "hosts").glob("*/index.html"))
    feeds = check_feeds(newest, host_pages, alternates, listed_records, problems)
    check_dataset(data_links, newest, host_pages, twin_kinds, problems)
    suggested = check_suggest(data_links, twin_kinds, twin_hosts, problems) or (0, 0)
    year_files = check_llms(data_links, problems)
    inside = check_site_urls(problems)
    check_newest(newest, listed_records, problems)
    kind_counts = check_kinds(
        twin_kinds, record_kinds, newest, kind_pages, alternates, listed_records, problems
    )
    check_about(about, without_about, problems)
    db_counts = check_db(data_links, problems)
    for file in [DIST / "llms.txt", *year_llms_files(), *sorted(DIST.rglob("feed.*"))]:
        if file.exists():
            body = file.read_text()
            for word in words:
                if word in body:
                    problems.append(f"{file.relative_to(DIST)}: names {word!r}")

    if problems:
        sys.exit(
            "\n".join(problems[:40])
            + (f"\n... {len(problems)} problems" if len(problems) > 40 else "")
        )
    print(
        f"{len(pages)} pages ({len(records)} records with twins), {len(links)} internal"
        f" links, {len(seen)} sitemap URLs ({len(noindex)} thin pages noindex);"
        f" links, metadata and sitemap valid; {len(records)} record h-entries and"
        f" {feed_pages} list h-feeds;"
        f" {feeds + 2 * len(kind_counts)} feeds, links.json, hosts.json, issues.json,"
        f" search/suggest.json ({suggested[0]} hosts, {suggested[1]} issues), llms.txt and"
        f" {len(year_files)} year llms files valid ({len(inside)} site URLs inside resolve);"
        f" /newest/ lists the newest {FEED_SIZE};"
        f" kinds {', '.join(f'{k} {n}' for k, n in kind_counts.items())};"
        f" /about/ renders; links.db {', '.join(f'{n} {t}' for t, n in db_counts.items())};"
        f" no liveness ({len(words)} words checked), {images} facts images built;"
        f" Tinylytics {'on (production build)' if PRODUCTION else 'absent'}"
        + (" (a saved link names it; only fetches checked)" if content_names_tinylytics else "")
        + f"; off-site fetches: {', '.join(sorted(off_site_seen)) or 'none'}"
    )


if __name__ == "__main__":
    main()
