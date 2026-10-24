"""Books saved as Amazon links: title, authors, date and cover from Open Library.

Applies to Amazon store URLs (amazon.<tld>, www. or smile.) whose ASIN, in
/dp/<ASIN>, /gp/product/<ASIN> or /exec/obidos/ASIN/<ASIN>, is an ISBN-10
(ten characters, nine digits then a digit or X): only a book's ASIN is its
ISBN. A Kindle or product ASIN (B0...) does not apply. A 404 from Open
Library is recorded as the record's error.
"""

import re
from urllib.parse import urlsplit

from .base import AdapterError, cached, get_json, save_image, text

METHOD = "openlibrary"
KIND = "book"
VERSION = 1
FIELDS = ("isbn", "title", "authors", "published", "image", "openlibrary_url")
SHAPES = (FIELDS,)
MEDIA = "books"

OPEN_LIBRARY = "https://openlibrary.org"
COVERS = "https://covers.openlibrary.org/b/id/{cover}-M.jpg"
HOST_RE = re.compile(r"(?:www\.|smile\.)?amazon(?:\.[a-z]{2,3}){1,2}")
PATH_RE = re.compile(r"/(?:dp|gp/product|exec/obidos/ASIN)/([0-9A-Za-z]{10})(?=[/?;]|$)")
ISBN10_RE = re.compile(r"\d{9}[\dX]")
AUTHOR_KEY_RE = re.compile(r"/authors/OL\d+A")
WORK_KEY_RE = re.compile(r"/works/OL\d+W")
MAX_AUTHORS = 5


def match(url):
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    if not HOST_RE.fullmatch(host):
        return None
    found = PATH_RE.search(parts.path)
    if not found:
        return None
    asin = found.group(1).upper()
    return {"isbn": asin} if ISBN10_RE.fullmatch(asin) else None


def _author_keys(ctx, edition):
    keys = [a.get("key") for a in edition.get("authors") or [] if isinstance(a, dict)]
    keys = [key for key in keys if isinstance(key, str) and AUTHOR_KEY_RE.fullmatch(key)]
    if keys:
        return keys
    works = [w.get("key") for w in edition.get("works") or [] if isinstance(w, dict)]
    works = [key for key in works if isinstance(key, str) and WORK_KEY_RE.fullmatch(key)]
    if not works:
        return []
    work = cached(ctx, (METHOD, works[0]), lambda: get_json(ctx, f"{OPEN_LIBRARY}{works[0]}.json")[0])
    for entry in work.get("authors") or [] if isinstance(work, dict) else []:
        author = entry.get("author") if isinstance(entry, dict) else None
        key = author.get("key") if isinstance(author, dict) else None
        if isinstance(key, str) and AUTHOR_KEY_RE.fullmatch(key):
            keys.append(key)
    return keys


def _book(ctx, isbn):
    edition = get_json(ctx, f"{OPEN_LIBRARY}/isbn/{isbn}.json")[0]
    if not isinstance(edition, dict) or not isinstance(edition.get("title"), str):
        raise AdapterError("not an Open Library edition")
    authors = []
    for key in _author_keys(ctx, edition)[:MAX_AUTHORS]:
        author = cached(ctx, (METHOD, key), lambda key=key: get_json(ctx, f"{OPEN_LIBRARY}{key}.json")[0])
        name = text(author.get("name")) if isinstance(author, dict) else None
        if name and name not in authors:
            authors.append(name)
    covers = [c for c in edition.get("covers") or [] if isinstance(c, int) and not isinstance(c, bool) and c > 0]
    image = save_image(ctx, COVERS.format(cover=covers[0]) if covers else None, MEDIA, isbn)
    return {
        "isbn": isbn,
        "title": text(edition["title"]),
        "authors": authors,
        "published": text(edition.get("publish_date"), 40),
        "image": image,
        "openlibrary_url": f"{OPEN_LIBRARY}/isbn/{isbn}",
    }


def fetch(link, ctx):
    isbn = match(link["url"])["isbn"]
    return cached(ctx, (METHOD, isbn), lambda: _book(ctx, isbn))
