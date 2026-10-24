"""A tiny Pinboard v1 client that can write: posts/get and posts/add (replace).
Separate from tools/linking/pinboard.py, which stays read-only by design. The
token is read from PINBOARD_API_TOKEN and never printed; errors are redacted.
One-shot, 2026-10."""

import json
import os
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

API = "https://api.pinboard.in/v1/"
UA = "links.thingelstad.xyz-cleanup/1 (+https://links.thingelstad.xyz/)"
SPACING = 3.0


class PinboardWriteError(Exception):
    pass


class Client:
    def __init__(self):
        self.token = os.environ.get("PINBOARD_API_TOKEN")
        if not self.token:
            raise PinboardWriteError("PINBOARD_API_TOKEN is not set")
        self.last = None

    def _redact(self, text):
        text = str(text).replace(self.token, "[redacted]")
        return re.sub(r"auth_token=[^&\s'\"]*", "auth_token=[redacted]", text)

    def _call(self, endpoint, params):
        if self.last is not None:
            wait = SPACING - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
        query = urlencode({**params, "format": "json", "auth_token": self.token})
        request = urllib.request.Request(f"{API}{endpoint}?{query}", headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise PinboardWriteError(f"{endpoint}: HTTP {code}") from None
        except Exception as error:  # noqa: BLE001
            raise PinboardWriteError(self._redact(f"{endpoint}: {type(error).__name__}: {error}")) from None
        finally:
            self.last = time.monotonic()
        try:
            return json.loads(body)
        except ValueError:
            raise PinboardWriteError(f"{endpoint}: not JSON") from None

    def all(self):
        """Every bookmark, as posts/all returns them (Pinboard allows this once every five minutes)."""
        data = self._call("posts/all", {})
        if not isinstance(data, list):
            raise PinboardWriteError("posts/all: unexpected shape")
        return data

    def get(self, url):
        """The bookmark for url as Pinboard holds it now, or None."""
        data = self._call("posts/get", {"url": url})
        posts = data.get("posts") or []
        return posts[0] if posts else None

    def replace(self, post, extended):
        """Rewrite one bookmark's note, every other field as it was."""
        params = {
            "url": post["href"],
            "description": post["description"],
            "extended": extended,
            "tags": post["tags"],
            "dt": post["time"],
            "replace": "yes",
            "shared": post["shared"],
            "toread": post["toread"],
        }
        data = self._call("posts/add", params)
        if data.get("result_code") != "done":
            raise PinboardWriteError(f"posts/add: {data.get('result_code', data)}")
        return data
