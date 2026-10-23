#!/usr/bin/env python3
"""Validate the built site in dist/ (npm run validate:site, after npm run build).

Adapted from poap.thingelstad.xyz's validator. It checks:

- every page has a title, a canonical link to its own URL, and a main landmark;
- every internal href and src resolves to a built file, and every #fragment on
  an internal link names an id on the target page;
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
  page, and every page but the 404 is in the sitemap, once;
- every record page has its JSON and Markdown twins, the JSON names the same
  id, and there is one record per link in data/links (read, never written);
- Pagefind indexed exactly the record pages;
- the feeds: every feed.xml is well-formed RSS 2.0 and every feed.json is
  JSON Feed 1.1, newest first, with Central dates that carry their offset,
  each item a record; the site pair holds the newest 50 links; every host page
  has its pair;
- /links.json is every record exactly as data/links has it, plus its
  permalink; /hosts.json and /issues.json match the pages and the join;
- llms.txt follows llmstxt.org's shape and llms-full.txt is every Markdown
  twin, newest first; every URL on this site inside the feeds, the JSON files
  and the llms files resolves to a built file;
- the sitemap lists pages only (no feeds, JSON or text files).
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
SITE = "https://links.thingelstad.xyz"
# The one script from another host, production builds only (Analytics.astro).
TINYLYTICS = "https://tinylytics.app/embed/x4A9AVd_xma4hyT9xLZw.js?kudos=custom"
PRODUCTION = os.environ.get("PUBLIC_TINYLYTICS_ENABLED") == "true"
FEED_SIZE = 50
CENTRAL = ZoneInfo("America/Chicago")
# Pinboard's fields, in the mirror's order (docs/DATA.md).
MIRROR_FIELDS = ["id", "hash", "url", "title", "note", "saved", "tags", "toread", "meta"]
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
        self.main = False
        self.inline_urls = []
        self.alternates = []
        self.kudos = []
        self._inline = None

    def handle_starttag(self, tag, attrs):
        data = {key: value or "" for key, value in attrs}
        if data.get("id"):
            self.ids.add(data["id"])
        self.title |= tag == "title"
        self.main |= tag == "main"
        rels = set(data.get("rel", "").lower().split())
        if tag == "link" and "canonical" in rels:
            self.canonical = data.get("href")
        if tag == "link" and "alternate" in rels:
            self.alternates.append((data.get("type", ""), data.get("href", "")))
        if tag == "script" and not data.get("src"):
            self._inline = []
        if tag == "button" and "tinylytics_kudos" in data.get("class", "").split():
            self.kudos.append(data)
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

    def handle_data(self, data):
        if self._inline is not None:
            self._inline.append(data)

    def handle_endtag(self, tag):
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


def check_dataset(data_links, newest, host_pages, problems):
    """links.json is lossless and Pinboard-shaped; hosts and issues match."""
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
        if not same or list(row) != MIRROR_FIELDS + ["permalink"] or (
            row["permalink"] != f"{SITE}/links/{row['id']}/"
        ):
            problems.append(f"links.json: {row.get('id')} is not its record as data/links has it")

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


def check_llms(newest, problems):
    """llms.txt has llmstxt.org's shape (an H1, a blockquote, then sections of
    links) and its links resolve; llms-full.txt is every twin, newest first."""
    file = DIST / "llms.txt"
    llms = file.read_text() if file.exists() else ""
    lines = llms.splitlines()
    if not lines or not lines[0].startswith("# ") or not any(l.startswith("> ") for l in lines):
        problems.append("llms.txt: needs an H1 and a blockquote summary")
    for target in re.findall(r"\]\(([^)\s]+)\)", llms):
        path = target[len(SITE):] if target.startswith(SITE + "/") else None
        if path is None or not target_file(unquote(urlsplit(path).path)).exists():
            problems.append(f"llms.txt: {target} is not a built file on this site")
    file = DIST / "llms-full.txt"
    full = file.read_text() if file.exists() else ""
    body = "\n".join((DIST / "links" / f"{id}.md").read_text() for id in newest)
    if not full.startswith("# ") or not full.endswith(body) or len(full) - len(body) > 2000:
        problems.append("llms-full.txt: is not a short header and every twin, newest first")


def check_site_urls(problems):
    """Every URL on this site inside the feeds, the JSON files and the llms
    files names a built file."""
    names = ("links.json", "hosts.json", "issues.json", "llms.txt", "llms-full.txt")
    inside = set()
    for file in [DIST / name for name in names] + sorted(DIST.rglob("feed.*")):
        if file.exists():
            # A sentence may end just after a URL; no path here ends in . or ,
            inside.update(path.rstrip(".,") for path in SITE_URL.findall(file.read_text()))
    for path in sorted(inside):
        if not target_file(unquote(path)).exists():
            problems.append(f"{SITE}{path} is named in a feed or data file but not built")
    return inside


def main():
    problems = []
    sites = json.loads((ROOT / "shared/sites.json").read_text())
    allowed_off_site = {sites["owner"]["avatar"]}
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

    ids = {}
    links = []  # (page, ref, target url path, fragment)
    off_site_seen = set()
    alternates = {}  # page url to its <link rel="alternate"> (type, href)
    kudos = {}  # page url to its Kudos buttons
    listed_records = {}  # host pages to the records they list, in order
    loaders = 0
    for page in pages:
        rel = page.relative_to(DIST).as_posix()
        url = page_url(rel)
        text = page.read_text()
        parser = Page()
        parser.feed(text)
        ids[url] = parser.ids
        alternates[url] = parser.alternates
        kudos[url] = parser.kudos
        if url.startswith("/hosts/"):
            listed_records[url] = [
                record_id(ref) for ref in parser.refs if record_id(ref)
            ]
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
        if not target_file(path).exists():
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
        if url != "/404.html" and SITE + url not in seen:
            problems.append(f"{url} is not in the sitemap")

    # Records, twins and the data.
    records = sorted(p.parent.name for p in (DIST / "links").glob("*/index.html"))
    for record in records:
        twin = DIST / "links" / f"{record}.json"
        if not twin.exists():
            problems.append(f"links/{record}/: no JSON twin")
        elif json.loads(twin.read_text()).get("id") != record:
            problems.append(f"links/{record}.json: names another id")
        if not (DIST / "links" / f"{record}.md").exists():
            problems.append(f"links/{record}/: no Markdown twin")
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
        for link in sorted(data_links, key=lambda l: (l["saved"], l["id"]), reverse=True)
    ]
    host_pages = sorted((DIST / "hosts").glob("*/index.html"))
    feeds = check_feeds(newest, host_pages, alternates, listed_records, problems)
    check_dataset(data_links, newest, host_pages, problems)
    check_llms(newest, problems)
    inside = check_site_urls(problems)

    if problems:
        sys.exit(
            "\n".join(problems[:40])
            + (f"\n... {len(problems)} problems" if len(problems) > 40 else "")
        )
    print(
        f"{len(pages)} pages ({len(records)} records with twins), {len(links)} internal"
        f" links, {len(seen)} sitemap URLs; links, metadata and sitemap valid;"
        f" {feeds} feeds, links.json, hosts.json, issues.json, llms.txt and"
        f" llms-full.txt valid ({len(inside)} site URLs inside resolve);"
        f" Tinylytics {'on (production build)' if PRODUCTION else 'absent'}"
        + (" (a saved link names it; only fetches checked)" if content_names_tinylytics else "")
        + f"; off-site fetches: {', '.join(sorted(off_site_seen)) or 'none'}"
    )


if __name__ == "__main__":
    main()
