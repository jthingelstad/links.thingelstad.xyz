"""The contract every special-host adapter keeps, and the helpers they share.

docs/DATA.md, "data/enrichment/facts/<yyyy>.json". An adapter is a module in
this package with:

    METHOD   the record's method, the module's name ("youtube")
    KIND     the record's kind ("video", "repository", "article", "book")
    VERSION  bumped when the fields change; a record at a lower one is due
    SHAPES   the field lists a record can carry after checked, method,
             version and kind, in order (most adapters have one)
    MEDIA    the public/media/ subdirectory it writes images to, or None
    match(url)        -> dict of what the URL names (a video id, an ISBN), or
                         None when the adapter does not apply; host and path
                         only, no network
    fetch(link, ctx)  -> the fields, in the order of one of SHAPES, or raise
                         AdapterError (recorded as the record's error) or
                         StopMethod (nothing recorded; the method stops for
                         the run)

Requests go through ctx.web, the shared paced client (one request a second
per host, the LinkingThings user agent, 15 second timeout, one retry of a 429
or 5xx). Images go through save_image(), which never overwrites a file.
"""

import json
import re
from pathlib import Path

from .. import jsonio

MAX_TEXT = 500  # a title or description longer than this is cut
MAX_URL = 2000
JSON_CAP = 1024 * 1024
IMAGE_CAP = 1024 * 1024  # a thumbnail or cover bigger than this is not kept
IMAGE_ACCEPT = "image/jpeg,image/*;q=0.8"
JPEG_MAGIC = b"\xff\xd8\xff"
MEDIA_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


class AdapterError(Exception):
    """The facts could not be had. str() is the reason the record carries.

    transient: a timeout, a network failure, a 429 or a 5xx; a record that
    already holds facts keeps them rather than trade them for this error.
    status and headers describe the response, if one came back; they are for
    the adapter (a rate limit check) and never recorded.
    """

    def __init__(self, reason, *, transient=False, status=None, headers=None):
        super().__init__(reason)
        self.reason = reason
        self.transient = transient
        self.status = status
        self.headers = headers or {}


class StopMethod(Exception):
    """Stop this method for the rest of the run (a rate limit, a refused token)."""


class Context:
    """What a run hands every adapter: the web client, the media directory,
    the GitHub token (or None), and a per-run cache."""

    def __init__(self, web, media_dir, *, github_token=None):
        self.web = web
        self.media_dir = Path(media_dir)
        self.github_token = github_token
        self.cache = {}
        self.images_saved = 0
        self.images_kept = 0


def text(value, limit=MAX_TEXT):
    """A string with whitespace collapsed, cut to limit; None for nothing."""
    if not isinstance(value, str):
        return None
    collapsed = " ".join(value.split())
    return collapsed[:limit] or None


def web_url(value):
    """value when it is an http(s) URL of sensible length, else None."""
    if isinstance(value, str) and re.match(r"https?://", value) and len(value) <= MAX_URL:
        return value
    return None


def get_json(ctx, url, *, accept="application/json", headers=None, cap=JSON_CAP):
    """GET url and parse JSON. Returns (document, response headers); raises AdapterError."""
    result, body, response_headers = ctx.web.fetch(url, cap=cap, accept=accept, extra_headers=headers)
    if not result["alive"]:
        status = result["status"]
        transient = status is None or status == 429 or 500 <= status <= 599
        raise AdapterError(
            result.get("error") or "no response", transient=transient, status=status, headers=response_headers
        )
    if len(body) >= cap:
        raise AdapterError("the answer is larger than the tool reads")
    try:
        return json.loads(body.decode("utf-8")), response_headers
    except (ValueError, UnicodeDecodeError):
        raise AdapterError("the answer is not JSON") from None


def cached(ctx, key, compute):
    """compute() once per run per key; a raised AdapterError is cached too."""
    if key not in ctx.cache:
        try:
            ctx.cache[key] = ("ok", compute())
        except AdapterError as error:
            ctx.cache[key] = ("error", error)
    state, value = ctx.cache[key]
    if state == "error":
        raise value
    return value


def media_path(subdir, name):
    """The site path of an image, /media/<subdir>/<name>.jpg."""
    return f"/media/{subdir}/{name}.jpg"


def save_image(ctx, url, subdir, name):
    """Download a JPEG once to <media>/<subdir>/<name>.jpg; the site path, or None.

    An existing file is never overwritten (or fetched again). A missing URL,
    an error, a response that is not a JPEG image, or one over IMAGE_CAP
    gives None.
    """
    if not MEDIA_NAME_RE.fullmatch(name) or not MEDIA_NAME_RE.fullmatch(subdir):
        raise ValueError(f"not a media file name: {subdir}/{name}")
    path = ctx.media_dir / subdir / f"{name}.jpg"
    if path.exists():
        ctx.images_kept += 1
        return media_path(subdir, name)
    url = web_url(url)
    if url is None:
        return None
    result, body, _headers = ctx.web.fetch(url, cap=IMAGE_CAP + 1, accept=IMAGE_ACCEPT)
    kind = result.get("content_type") or ""
    if not result["alive"] or not kind.startswith("image/") or len(body) > IMAGE_CAP:
        return None
    if not body.startswith(JPEG_MAGIC):
        return None
    jsonio.write_bytes_atomic(path, body)
    ctx.images_saved += 1
    return media_path(subdir, name)
