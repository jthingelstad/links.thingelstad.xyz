"""Open-web signals from a host's home page: title, generator, feeds, h-card,
rel=me and a Webmention endpoint.

docs/DATA.md, "data/enrichment/hosts/<a-z0-9>.json", the home object. The
page is the same https://<host>/ response the HTTPS check makes (one request),
read up to 256 KB and parsed with the standard library's html.parser, which
never gives up on broken HTML. Nothing of the body is kept but these facts.
"""

import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from .web import redact_url

FEED_TYPES = {
    "application/rss+xml": "rss",
    "application/atom+xml": "atom",
    "application/feed+json": "json",
}
HTML_TYPES = ("text/html", "application/xhtml+xml")
MAX_TEXT = 300  # a title or a generator longer than this is cut
MAX_URL = 2000  # a longer URL is left out
MAX_FEEDS = 20
MAX_REL_ME = 50
CHARSET_RE = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)""", re.IGNORECASE)
LINK_HEADER_RE = re.compile(r"<([^>]*)>((?:\s*;\s*[^;,]*)*)")
REL_PARAM_RE = re.compile(r"""rel\s*=\s*(?:"([^"]*)"|([^\s;,"]+))""", re.IGNORECASE)


def _text(value):
    """Whitespace collapsed and cut to MAX_TEXT; None when nothing is left."""
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text[:MAX_TEXT] or None


class _Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = None
        self.generator = None
        self.feeds = []  # (type, href, title)
        self.hcard = False
        self.rel_me = []  # hrefs as written
        self.webmention = None
        self.base = None
        self._title_parts = None
        self._title_length = 0
        self._svg = 0

    def handle_starttag(self, tag, attrs):
        values = {}
        for name, value in attrs:
            values.setdefault(name.lower(), "" if value is None else value)
        if "h-card" in values.get("class", "").split():
            self.hcard = True
        if tag == "svg":
            self._svg += 1
        elif tag == "title" and self.title is None and self._title_parts is None and not self._svg:
            self._title_parts = []
        elif tag == "base" and self.base is None and values.get("href", "").strip():
            self.base = values["href"].strip()
        elif tag == "meta" and self.generator is None and values.get("name", "").strip().lower() == "generator":
            self.generator = _text(values.get("content"))
        if tag in ("link", "a") and "href" in values:
            rels = values.get("rel", "").lower().split()
            href = values["href"].strip()
            if tag == "link" and "alternate" in rels:
                kind = FEED_TYPES.get(values.get("type", "").split(";", 1)[0].strip().lower())
                if kind:
                    self.feeds.append((kind, href, _text(values.get("title"))))
            if "me" in rels:
                self.rel_me.append(href)
            if "webmention" in rels and self.webmention is None:
                self.webmention = href

    def handle_endtag(self, tag):
        if tag == "svg" and self._svg:
            self._svg -= 1
        elif tag == "title" and self._title_parts is not None:
            self._finish_title()

    def handle_data(self, data):
        if self._title_parts is not None and self._title_length < 4 * MAX_TEXT:
            self._title_parts.append(data)
            self._title_length += len(data)

    def _finish_title(self):
        self.title = _text("".join(self._title_parts))
        self._title_parts = None

    def close(self):
        super().close()
        if self._title_parts is not None:  # an unclosed <title>
            self._finish_title()


def charset_of(content_type, body):
    """The declared character set: the Content-Type header's, else a <meta> in the first 2 KB."""
    for param in (content_type or "").split(";")[1:]:
        name, _, value = param.partition("=")
        if name.strip().lower() == "charset" and value.strip().strip("\"'"):
            return value.strip().strip("\"'")
    match = CHARSET_RE.search(body[:2048])
    if match:
        return match.group(1).decode("ascii", "replace")
    return "utf-8"


def decode(body, content_type):
    charset = charset_of(content_type, body)
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _absolute(base, href):
    """An absolute http(s) URL, redacted, or None (other schemes, too long, unparseable)."""
    try:
        url = urljoin(base, href)
        scheme = urlsplit(url).scheme
    except ValueError:
        return None
    if scheme not in ("http", "https") or len(url) > MAX_URL:
        return None
    return redact_url(url)


def link_header_webmention(value, base):
    """The first rel="webmention" target in an HTTP Link header, absolute, or None."""
    for match in LINK_HEADER_RE.finditer(value or ""):
        target, params = match.group(1).strip(), match.group(2)
        for rel in REL_PARAM_RE.finditer(params):
            tokens = (rel.group(1) if rel.group(1) is not None else rel.group(2)).lower().split()
            if "webmention" in tokens:
                return _absolute(base, target)
    return None


def empty(checked, error=None):
    """A home object with nothing observed; error says why."""
    record = {
        "checked": checked,
        "title": None,
        "generator": None,
        "feeds": [],
        "hcard": False,
        "rel_me": [],
        "webmention": None,
    }
    if error is not None:
        record["error"] = error
    return record


def observe(checked, result, body, headers):
    """The home object from a web.fetch() of https://<host>/.

    result, body, headers are what fetch() returned. A Webmention endpoint in
    the Link header wins over one in the HTML, as the Webmention spec says.
    """
    final_url = result.get("final_url") or ""
    header_endpoint = link_header_webmention(headers.get("link"), final_url) if headers else None
    if not result.get("alive"):
        record = empty(checked, result.get("error") or "no response")
        record["webmention"] = header_endpoint
        return record
    kind = result.get("content_type")
    if kind is not None and kind not in HTML_TYPES:
        record = empty(checked, f"not HTML ({kind})")
        record["webmention"] = header_endpoint
        return record
    if not body:
        record = empty(checked, "empty body")
        record["webmention"] = header_endpoint
        return record
    parser = _Parser()
    try:
        parser.feed(decode(body, headers.get("content-type") if headers else None))
        parser.close()
    except Exception as error:  # noqa: BLE001 - html.parser is tolerant; anything else is recorded
        record = empty(checked, f"unparseable ({type(error).__name__})")
        record["webmention"] = header_endpoint
        return record
    base = _absolute(final_url, parser.base) if parser.base else None
    base = base or final_url
    feeds, seen = [], set()
    for kind, href, title in parser.feeds:
        url = _absolute(base, href)
        if url and url not in seen and len(feeds) < MAX_FEEDS:
            seen.add(url)
            feeds.append({"type": kind, "url": url, "title": title})
    rel_me = []
    for href in parser.rel_me:
        url = _absolute(base, href)
        if url and url not in rel_me and len(rel_me) < MAX_REL_ME:
            rel_me.append(url)
    webmention = header_endpoint
    if webmention is None and parser.webmention is not None:
        webmention = _absolute(base, parser.webmention)
    return {
        "checked": checked,
        "title": parser.title,
        "generator": parser.generator,
        "feeds": feeds,
        "hcard": parser.hcard,
        "rel_me": rel_me,
        "webmention": webmention,
    }
