"""Ids and URL normalisation, exactly as docs/DATA.md defines them.

The id is md5 of the URL exactly as saved; normalisation is for joins only and
never forms an id. src/lib/data.ts reimplements normalise() from the same
contract, so every edge case decided here is listed in tools/README.md.
"""

import hashlib
from urllib.parse import unquote, urlsplit

# Query parameters dropped by name (exact, case-sensitive), plus any name that
# starts with "utm_".
TRACKING_PARAMS = frozenset({"ref", "source", "mc_cid", "mc_eid", "fbclid", "gclid"})


def md5_hex(text):
    """md5 of the UTF-8 bytes of text, as 32 lower-case hex characters."""
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def link_id(url):
    """The Linking Things id: the first 12 hex characters of md5(url as saved)."""
    return md5_hex(url)[:12]


def is_tracking_param(name):
    return name.startswith("utm_") or name in TRACKING_PARAMS


def normalise(url):
    """The join key for a URL (docs/DATA.md, "URL normalisation").

    1. Lower-case the host; drop a leading "www.".
    2. Drop the scheme.
    3. Percent-decode the path; drop trailing slashes (an empty path becomes "/").
    4. Drop tracking query parameters; keep the rest in their original order.
    5. Drop the fragment.
    """
    text = url.strip()
    try:
        parts = urlsplit(text)
    except ValueError:
        # Not parseable as a URL (an unclosed IPv6 bracket, say): it can only
        # join to a byte-identical URL.
        return text
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = unquote(parts.path).rstrip("/") or "/"
    kept = [
        param
        for param in parts.query.split("&")
        if param and not is_tracking_param(param.split("=", 1)[0])
    ]
    query = "?" + "&".join(kept) if kept else ""
    return host + path + query
