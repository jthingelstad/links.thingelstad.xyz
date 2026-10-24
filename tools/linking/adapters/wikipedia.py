"""Wikipedia articles: title, short description, language and canonical URL
from the REST summary endpoint.

Applies to <lang>.wikipedia.org/wiki/<title> (and the mobile
<lang>.m.wikipedia.org). The summary's extract and thumbnail are never
stored: no excerpts on this site, and image licences vary.
"""

import re
from urllib.parse import quote, unquote, urlsplit

from .base import AdapterError, cached, get_json, text, web_url

METHOD = "wikipedia"
KIND = "article"
VERSION = 1
FIELDS = ("title", "description", "lang", "url")
SHAPES = (FIELDS,)
MEDIA = None

HOST_RE = re.compile(r"((?:[a-z]{2,3}(?:-[a-z0-9]{2,8})*)|simple)(?:\.m)?\.wikipedia\.org")


def match(url):
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    found = HOST_RE.fullmatch(host)
    if not found or not parts.path.startswith("/wiki/"):
        return None
    title = unquote(parts.path[len("/wiki/") :])
    if not title.strip() or len(title) > 255:
        return None
    return {"lang": found.group(1), "title": title}


def fetch(link, ctx):
    found = match(link["url"])
    lang, title = found["lang"], found["title"]
    api = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(title, safe='')}"
    doc = cached(ctx, (METHOD, lang, title), lambda: get_json(ctx, api)[0])
    if not isinstance(doc, dict) or not isinstance(doc.get("title"), str):
        raise AdapterError("not a page summary")
    desktop = ((doc.get("content_urls") or {}).get("desktop") or {}) if isinstance(doc.get("content_urls"), dict) else {}
    return {
        "title": text(doc["title"]),
        "description": text(doc.get("description")),
        "lang": text(doc.get("lang"), 20) or lang,
        "url": web_url(desktop.get("page")),
    }
