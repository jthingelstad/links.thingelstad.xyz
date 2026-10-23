"""The Pinboard mirror: the API client, the public shards and the sync state.

docs/DATA.md, "data/links/<yyyy>.json". The token is only ever read from the
PINBOARD_API_TOKEN environment variable, and nothing this module raises or
prints carries it or a URL that contains it.
"""

import json
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

from . import jsonio
from .urls import md5_hex

API_BASE = "https://api.pinboard.in/v1/"
USER_AGENT = "links.thingelstad.xyz-sync/1 (+https://links.thingelstad.xyz/)"
CALL_SPACING_SECONDS = 3.0  # Pinboard: one request per three seconds.
POSTS_ALL_INTERVAL_SECONDS = 300  # Pinboard: posts/all at most once per five minutes.

# The fields of a links record, in the contract's order.
RECORD_FIELDS = ("id", "hash", "url", "title", "note", "saved", "tags", "toread", "meta")
# The fields posts/all returns for every bookmark.
POST_FIELDS = ("href", "description", "extended", "meta", "hash", "time", "shared", "toread", "tags")
STATE_FIELDS = ("updated", "fetched_at", "public", "total")

STAMP_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
HEX32_RE = re.compile(r"[0-9a-f]{32}")
YEAR_FILE_RE = re.compile(r"\d{4}\.json")


class PinboardError(Exception):
    """A failed API call. The message never contains the token."""


class SyncError(Exception):
    """The export or the state is not what the contract expects."""


def utc_stamp(when):
    """A datetime as YYYY-MM-DDTHH:MM:SSZ."""
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_stamp(text):
    if not isinstance(text, str) or not STAMP_RE.fullmatch(text):
        raise SyncError(f"not a UTC timestamp: {text!r}")
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def redact(text, token):
    """Remove the token, its secret half, and any auth_token value from text."""
    text = str(text)
    if token:
        text = text.replace(token, "[redacted]")
        secret = token.split(":", 1)[-1]
        if len(secret) >= 8:
            text = text.replace(secret, "[redacted]")
        quoted = quote(token, safe="")
        if quoted != token:
            text = text.replace(quoted, "[redacted]")
    return re.sub(r"(?i)(auth_token=)[^&\s'\"]*", r"\1[redacted]", text)


def _urllib_fetch(url, headers, timeout):
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


class PinboardClient:
    """Pinboard API v1, read-only, at most one call per three seconds.

    fetch(url, headers, timeout) -> bytes does the HTTP GET; tests pass a fake.
    """

    def __init__(self, token, *, fetch=_urllib_fetch, sleep=time.sleep, clock=time.monotonic):
        if not token:
            raise PinboardError("PINBOARD_API_TOKEN is not set")
        self._token = token
        self._fetch = fetch
        self._sleep = sleep
        self._clock = clock
        self._last_call = None
        self.calls = []  # endpoint names, in order, for the log and for tests

    def _get(self, endpoint, timeout):
        if self._last_call is not None:
            wait = CALL_SPACING_SECONDS - (self._clock() - self._last_call)
            if wait > 0:
                self._sleep(wait)
        url = f"{API_BASE}{endpoint}?format=json&auth_token={quote(self._token, safe=':')}"
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        self.calls.append(endpoint)
        try:
            return self._fetch(url, headers, timeout)
        except urllib.error.HTTPError as error:
            message = f"{endpoint}: HTTP {error.code} {error.reason}"
            retry_after = error.headers.get("Retry-After") if error.headers else None
            if retry_after:
                message += f" (Retry-After: {retry_after})"
            error.close()  # the error holds the open response body
        except Exception as error:  # noqa: BLE001 - every failure is reported the same safe way
            message = f"{endpoint}: {type(error).__name__}: {error}"
        finally:
            self._last_call = self._clock()
        # Raised here, outside the handler, so the new error carries no
        # reference to the original one (whose url attribute holds the token).
        raise PinboardError(redact(message, self._token))

    def posts_update(self):
        """The time of the account's most recent change, YYYY-MM-DDTHH:MM:SSZ."""
        body = self._get("posts/update", timeout=30)
        try:
            stamp = json.loads(body)["update_time"]
            parse_stamp(stamp)
        except (ValueError, KeyError, TypeError, SyncError):
            raise PinboardError("posts/update: unexpected response") from None
        return stamp

    def posts_all(self):
        """Every bookmark, public and private, as the raw response bytes."""
        return self._get("posts/all", timeout=180)


def parse_posts(raw):
    """Decode a posts/all export and check its shape. Returns the list of posts."""
    try:
        posts = json.loads(raw)
    except ValueError:
        raise SyncError("the export is not JSON") from None
    if not isinstance(posts, list):
        raise SyncError("the export is not a JSON array of bookmarks")
    if not posts:
        raise SyncError("the export holds no bookmarks")
    for index, post in enumerate(posts):
        if not isinstance(post, dict):
            raise SyncError(f"bookmark {index} is not an object")
        missing = [field for field in POST_FIELDS if field not in post]
        if missing:
            raise SyncError(f"bookmark {index} lacks {', '.join(missing)}")
        for field in POST_FIELDS:
            if not isinstance(post[field], str):
                raise SyncError(f"bookmark {index}: {field} is not a string")
        if not STAMP_RE.fullmatch(post["time"]):
            raise SyncError(f"bookmark {index}: time is not YYYY-MM-DDTHH:MM:SSZ")
    return posts


def is_public(post):
    """Only shared=yes is public. Anything else, or no value, stays private."""
    return post.get("shared") == "yes"


def to_record(post):
    """A public bookmark as a links record, fields in the contract's order."""
    return {
        "id": post["hash"][:12],
        "hash": post["hash"],
        "url": post["href"],
        "title": post["description"],
        "note": post["extended"],
        "saved": post["time"],
        "tags": post["tags"].split(),
        "toread": post["toread"] == "yes",
        "meta": post["meta"],
    }


def shard(posts):
    """Public bookmarks grouped by year saved, each year sorted by saved then id.

    Returns {"2005": [record, ...], ...}. Private bookmarks never reach a record.
    """
    years = {}
    seen = {}
    bad_hash = []
    for post in posts:
        if not is_public(post):
            continue
        if md5_hex(post["href"]) != post["hash"] or not HEX32_RE.fullmatch(post["hash"]):
            bad_hash.append(post["hash"][:12])
            continue
        record = to_record(post)
        if record["id"] in seen:
            raise SyncError(f"two public bookmarks share the id {record['id']}")
        seen[record["id"]] = True
        years.setdefault(record["saved"][:4], []).append(record)
    if bad_hash:
        raise SyncError(
            f"{len(bad_hash)} public bookmark(s) whose hash is not md5 of href: "
            + ", ".join(bad_hash[:10])
        )
    for records in years.values():
        records.sort(key=lambda record: (record["saved"], record["id"]))
    return dict(sorted(years.items()))


def write_shards(links_dir, years):
    """Write data/links/<yyyy>.json for every year and remove years now empty.

    Returns (changed, removed): the year files rewritten and those deleted.
    """
    changed, removed = [], []
    links_dir.mkdir(parents=True, exist_ok=True)
    for year, records in years.items():
        if jsonio.write_json(links_dir / f"{year}.json", records):
            changed.append(year)
    for path in sorted(links_dir.iterdir()):
        if YEAR_FILE_RE.fullmatch(path.name) and path.stem not in years:
            path.unlink()
            removed.append(path.stem)
    return changed, removed


def read_state(path):
    """data/sync.json, or an empty state when it does not exist yet."""
    try:
        state = jsonio.load(path)
    except FileNotFoundError:
        return {field: None for field in STATE_FIELDS}
    if not isinstance(state, dict) or list(state) != list(STATE_FIELDS):
        raise SyncError(f"{path} must hold exactly {', '.join(STATE_FIELDS)}")
    return state


def write_state(path, updated, fetched_at, public, total):
    state = {"updated": updated, "fetched_at": fetched_at, "public": public, "total": total}
    jsonio.write_json(path, state)
    return state


def last_posts_all_call(state, marker_path):
    """The latest known posts/all call: the state's fetched_at or the local marker."""
    times = []
    if state.get("fetched_at"):
        times.append(parse_stamp(state["fetched_at"]))
    try:
        times.append(parse_stamp(marker_path.read_text(encoding="utf-8").strip()))
    except (FileNotFoundError, SyncError):
        pass
    return max(times) if times else None


def posts_all_wait(state, marker_path, now):
    """Seconds to wait before posts/all is allowed again (0 when allowed now)."""
    last = last_posts_all_call(state, marker_path)
    if last is None:
        return 0
    elapsed = (now - last).total_seconds()
    return max(0, int(POSTS_ALL_INTERVAL_SECONDS - elapsed + 0.999))
