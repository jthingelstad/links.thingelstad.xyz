"""Vimeo videos: title, author and thumbnail from oEmbed (no key).

Applies to vimeo.com/<digits> and the forms that also name one video:
/m/<digits>, /channels/<name>/<digits>, /album/<n>/video/<digits>,
/groups/<name>/videos/<digits>, player.vimeo.com/video/<digits>.
"""

import re
from urllib.parse import urlencode, urlsplit

from .base import cached, get_json, save_image, text, web_url

METHOD = "vimeo"
KIND = "video"
VERSION = 1
FIELDS = ("video_id", "provider", "title", "author", "author_url", "image")
SHAPES = (FIELDS,)
MEDIA = "vimeo"

OEMBED = "https://vimeo.com/api/oembed.json"
PATHS = (
    re.compile(r"/(\d+)/?$"),
    re.compile(r"/m/(\d+)/?$"),
    re.compile(r"/channels/[^/]+/(\d+)/?$"),
    re.compile(r"/album/\d+/video/(\d+)/?$"),
    re.compile(r"/groups/[^/]+/videos/(\d+)/?$"),
)
PLAYER_RE = re.compile(r"/video/(\d+)/?$")


def match(url):
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    patterns = ()
    if host in ("vimeo.com", "www.vimeo.com"):
        patterns = PATHS
    elif host == "player.vimeo.com":
        patterns = (PLAYER_RE,)
    for pattern in patterns:
        found = pattern.match(parts.path)
        if found and len(found.group(1)) <= 12:
            return {"video_id": found.group(1)}
    return None


def fetch(link, ctx):
    video = match(link["url"])["video_id"]
    page = f"https://vimeo.com/{video}"
    doc = cached(ctx, (METHOD, video), lambda: get_json(ctx, OEMBED + "?" + urlencode({"url": page}))[0])
    image = save_image(ctx, doc.get("thumbnail_url"), MEDIA, video)
    return {
        "video_id": video,
        "provider": "vimeo",
        "title": text(doc.get("title")),
        "author": text(doc.get("author_name")),
        "author_url": web_url(doc.get("author_url")),
        "image": image,
    }
