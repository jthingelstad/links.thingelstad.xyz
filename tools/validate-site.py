#!/usr/bin/env python3
"""Validate the built site in dist/ (npm run validate:site, after npm run build).

Adapted from poap.thingelstad.xyz's validator. It checks:

- every page has a title, a canonical link to its own URL, and a main landmark;
- every internal href and src resolves to a built file, and every #fragment on
  an internal link names an id on the target page;
- nothing is fetched at serve time from another host (scripts, styles, fonts,
  images, frames), except owner.avatar from shared/sites.json, the photo the
  family's h-card contract names;
- the sitemap index lists sitemaps that exist, every sitemap URL is a built
  page, and every page but the 404 is in the sitemap, once;
- every record page has its JSON and Markdown twins, the JSON names the same
  id, and there is one record per link in data/links (read, never written);
- Pagefind indexed exactly the record pages.
"""

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
SITE = "https://links.thingelstad.xyz"
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

    def handle_starttag(self, tag, attrs):
        data = {key: value or "" for key, value in attrs}
        if data.get("id"):
            self.ids.add(data["id"])
        self.title |= tag == "title"
        self.main |= tag == "main"
        rels = set(data.get("rel", "").lower().split())
        if tag == "link" and "canonical" in rels:
            self.canonical = data.get("href")
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


def main():
    problems = []
    sites = json.loads((ROOT / "shared/sites.json").read_text())
    allowed_off_site = {sites["owner"]["avatar"]}
    pages = sorted(DIST.rglob("*.html"))
    if not pages:
        sys.exit("No pages in dist/. Run npm run build first.")

    ids = {}
    links = []  # (page, ref, target url path, fragment)
    off_site_seen = set()
    for page in pages:
        rel = page.relative_to(DIST).as_posix()
        url = page_url(rel)
        parser = Page()
        parser.feed(page.read_text())
        ids[url] = parser.ids
        for flag, name in ((parser.title, "title"), (parser.main, "main")):
            if not flag:
                problems.append(f"{rel}: no {name}")
        if rel != "404.html":
            if not parser.canonical:
                problems.append(f"{rel}: no canonical")
            elif parser.canonical != SITE + url:
                problems.append(f"{rel}: canonical {parser.canonical} is not {SITE + url}")
        for ref in parser.fetched:
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
    saved = [
        link["id"]
        for file in sorted((ROOT / "data/links").glob("[0-9][0-9][0-9][0-9].json"))
        for link in json.loads(file.read_text())
    ]
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

    if problems:
        sys.exit(
            "\n".join(problems[:40])
            + (f"\n... {len(problems)} problems" if len(problems) > 40 else "")
        )
    print(
        f"{len(pages)} pages ({len(records)} records with twins), {len(links)} internal"
        f" links, {len(seen)} sitemap URLs; links, metadata and sitemap valid;"
        f" off-site fetches: {', '.join(sorted(off_site_seen)) or 'none'}"
    )


if __name__ == "__main__":
    main()
