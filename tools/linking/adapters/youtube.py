"""YouTube videos: title, channel and thumbnail from oEmbed (no key).

Applies to youtube.com (www., m.), youtube-nocookie.com and youtu.be URLs
that name a video: watch?v=<id> (and watch_popup), /embed/<id>, /shorts/<id>,
/v/<id>, /live/<id>, youtu.be/<id>. The video id is the record's key fact, so
one video saved under two URLs shares one thumbnail file.
"""

import re
from urllib.parse import parse_qs, urlencode, urlsplit

from .base import cached, get_json, save_image, text, web_url

METHOD = "youtube"
KIND = "video"
VERSION = 1
FIELDS = ("video_id", "provider", "title", "author", "author_url", "image")
SHAPES = (FIELDS,)
MEDIA = "youtube"

OEMBED = "https://www.youtube.com/oembed"
HOSTS = {"youtube.com", "m.youtube.com", "youtube-nocookie.com"}
ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
PATH_RE = re.compile(r"/(?:embed|shorts|v|live)/([^/]+)/?$")


def _host(parts):
    host = (parts.hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def match(url):
    try:
        parts = urlsplit(url.strip())
        host = _host(parts)
    except ValueError:
        return None
    video = None
    if host == "youtu.be":
        video = parts.path.strip("/")
    elif host in HOSTS:
        if parts.path.rstrip("/") in ("/watch", "/watch_popup"):
            video = (parse_qs(parts.query).get("v") or [None])[0]
        else:
            found = PATH_RE.match(parts.path)
            video = found.group(1) if found else None
    if video and ID_RE.fullmatch(video):
        return {"video_id": video}
    return None


def fetch(link, ctx):
    video = match(link["url"])["video_id"]
    watch = f"https://www.youtube.com/watch?v={video}"
    doc = cached(ctx, (METHOD, video), lambda: get_json(ctx, OEMBED + "?" + urlencode({"url": watch, "format": "json"}))[0])
    image = save_image(ctx, doc.get("thumbnail_url"), MEDIA, video)
    return {
        "video_id": video,
        "provider": "youtube",
        "title": text(doc.get("title")),
        "author": text(doc.get("author_name")),
        "author_url": web_url(doc.get("author_url")),
        "image": image,
    }
