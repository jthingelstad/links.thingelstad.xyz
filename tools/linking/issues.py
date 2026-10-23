"""The join to The Weekly Thing: data/derived/issues.json (docs/DATA.md).

Each issue page on weekly.thingelstad.com carries its links in front matter.
Twenty-one issues of 2017 and 2018 (WT32 to WT52) were imported into WT Builder
as plain text and list no links there, so their links are read from the body.
Every issue link is matched to a saved link by normalised URL.
"""

import re
from pathlib import Path
from urllib.parse import urlsplit

from . import frontmatter, jsonio
from .urls import normalise

SOURCE = "weekly.thingelstad.com archive front matter, or the issue body where the front matter lists no links"
SITE = "https://weekly.thingelstad.com"
ISSUE_FIELDS = ("number", "slug", "title", "subject", "date", "url", "links")
LINK_FIELDS = ("position", "id", "url", "text", "section", "heading_context")
# 61 issues carry microseconds (2021-02-13T16:55:35.260587Z); they pass through as written.
DATE_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z")
PERMALINK_RE = re.compile(r"/archive/[^/\s]+/")
TITLE_PREFIX_RE = re.compile(r"^WT\d+\s*[—–-]\s*")
# A link item in an imported body is a Markdown link that is a whole line, with
# or without a heading marker (WT32 to WT41 used ### headings, WT42 to WT52 a
# plain line followed by the domain). Its section is the ## heading above it.
BODY_LINK_RE = re.compile(r"^(?:#{1,6}[ \t]+)?\[([^\]\n]*)\]\((https?://[^)\s]+)\)[ \t]*$", re.M)
SECTION_RE = re.compile(r"^##[ \t]+(.+?)[ \t]*$", re.M)
# Jamie's own posts (the Status and Blog sections) and the photo files are not
# links the issue shares.
OWN_HOST_RE = re.compile(r"^(?:[a-z0-9-]+\.)*thingelstad\.com$", re.I)


class IssueError(ValueError):
    """An issue file the join cannot read. The message names the file."""


def load_links(links_dir):
    """Every saved link in data/links/<yyyy>.json, as a list of records."""
    records = []
    for path in sorted(Path(links_dir).glob("*.json")):
        if re.fullmatch(r"\d{4}\.json", path.name):
            records.extend(jsonio.load(path))
    return records


class LinkIndex:
    """Saved links by normalised URL, each list ordered by saved then id."""

    def __init__(self, records):
        self._by_key = {}
        for record in sorted(records, key=lambda r: (r["saved"], r["id"])):
            self._by_key.setdefault(normalise(record["url"]), []).append(record)

    def match(self, url, issue_date):
        """The id of the saved link an issue link points at, or None.

        When several saved links normalise alike (the saved-twice pairs), the
        one saved under exactly this URL wins; otherwise the one saved most
        recently at or before the issue's date; otherwise the earliest saved.
        """
        candidates = self._by_key.get(normalise(url))
        if not candidates:
            return None
        for record in candidates:
            if record["url"] == url:
                return record["id"]
        before = [record for record in candidates if record["saved"] <= issue_date]
        return (before[-1] if before else candidates[0])["id"]


def body_text(text):
    """The issue body: everything after the front matter's closing ---."""
    lines = text.split("\n")
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                return "\n".join(lines[index + 1 :])
    return text


def body_links(body):
    """The link items of an imported body, in order, shaped like front matter rows."""
    events = [(m.start(), "section", m) for m in SECTION_RE.finditer(body)]
    events += [(m.start(), "link", m) for m in BODY_LINK_RE.finditer(body)]
    rows = []
    section = None
    for _, kind, match in sorted(events, key=lambda event: event[0]):
        if kind == "section":
            section = match.group(1)
            continue
        text, url = match.group(1).strip(), match.group(2)
        if not text or OWN_HOST_RE.match(urlsplit(url).hostname or ""):
            continue
        rows.append({"text": text, "url": url, "section": section, "heading_context": f"[{text}]({url})"})
    return rows


def _text(value):
    """A front matter field as JSON: a string, or None when YAML said null."""
    return value if value is None else str(value)


def issue_number(value):
    """The issue number as an int, or None for an issue without one (140-special)."""
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        return int(value)
    return None


def read_issue(path, index):
    """One issue file as an issues.json entry, fields in the contract's order."""
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    try:
        meta = frontmatter.parse_front_matter(text)
    except frontmatter.FrontMatterError as error:
        raise IssueError(f"{path.name}: {error}") from None
    subject = _text(meta.get("subject")) or ""
    date = meta.get("publish_date")
    if not isinstance(date, str) or not DATE_RE.fullmatch(date):
        raise IssueError(f"{path.name}: publish_date is not YYYY-MM-DDTHH:MM:SS[.ffffff]Z: {date!r}")
    slug = _text(meta.get("slug")) or path.stem
    permalink = meta.get("permalink")
    if permalink is None:
        permalink = f"/archive/{path.stem}/"
    if not isinstance(permalink, str) or not PERMALINK_RE.fullmatch(permalink):
        raise IssueError(f"{path.name}: permalink is not /archive/<segment>/: {permalink!r}")
    rows = meta.get("links") or []
    if not isinstance(rows, list):
        raise IssueError(f"{path.name}: links is not a list")
    if not rows:
        rows = body_links(body_text(text))
    links = []
    for row in rows:
        if not isinstance(row, dict):
            raise IssueError(f"{path.name}: a links entry is not a mapping")
        url = row.get("url")
        if not isinstance(url, str) or not url:
            continue
        links.append(
            {
                "position": len(links),
                "id": index.match(url, date),
                "url": url,
                "text": _text(row.get("text")),
                "section": _text(row.get("section")),
                "heading_context": _text(row.get("heading_context")),
            }
        )
    return {
        "number": issue_number(meta.get("number")),
        "slug": slug,
        "title": TITLE_PREFIX_RE.sub("", subject),
        "subject": subject,
        "date": date,
        "url": SITE + permalink,
        "links": links,
    }


def issue_files(archive_dir):
    """The issue pages: archive/<n>.md and the like. Templates (.njk) are not issues."""
    return sorted(Path(archive_dir).glob("*.md"))


def build(archive_dir, links_dir):
    """The whole issues.json document."""
    index = LinkIndex(load_links(links_dir))
    files = issue_files(archive_dir)
    if not files:
        raise IssueError(f"no issue files (*.md) in {archive_dir}")
    issues = [read_issue(path, index) for path in files]
    slugs = {}
    for issue in issues:
        if issue["slug"] in slugs:
            raise IssueError(f"two issues share the slug {issue['slug']!r}")
        slugs[issue["slug"]] = True
    issues.sort(key=lambda issue: (issue["date"], issue["slug"]))
    return {"source": SOURCE, "issues": issues}


def summary(document):
    rows = [link for issue in document["issues"] for link in issue["links"]]
    return {
        "issues": len(document["issues"]),
        "rows": len(rows),
        "unmatched": sum(1 for link in rows if link["id"] is None),
        "linked_ids": len({link["id"] for link in rows if link["id"]}),
    }
