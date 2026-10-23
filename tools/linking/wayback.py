"""Wayback Machine captures of a saved URL, from the CDX API.

docs/DATA.md, "Enrichment (phase 2)". One request per link, at the strict
six-second pace the web client keeps for web.archive.org (bursts get the IP
blocked): the capture timestamps of the URL, oldest first, up to ROW_LIMIT
rows. first is the first row, last the last, count the number of rows. Only
when a URL has ROW_LIMIT captures or more (a busy home page) does a second
request (limit=-1) fetch the true latest capture; count then says
ROW_LIMIT and count_capped is true. A 429 that survives the one retry, or a
refused connection, means the archive wants us to stop: Blocked is raised and
the caller ends Wayback lookups for the run.
"""

import json
import re
from urllib.parse import urlencode

CDX = "https://web.archive.org/cdx/search/cdx"
ROW_LIMIT = 10000
CDX_CAP = 2 * 1024 * 1024  # 10,000 timestamp rows are about 190 KB
CDX_TIMEOUT_SECONDS = 30  # the CDX server is slow on big answers
TIMESTAMP_RE = re.compile(r"\d{14}")


class Blocked(Exception):
    """The archive refused us (429 after the retry, or a refused connection)."""


class LookupFailed(Exception):
    """This URL's lookup failed; others may still work."""


def cdx_url(url, limit):
    return CDX + "?" + urlencode({"url": url, "output": "json", "fl": "timestamp", "limit": str(limit)})


def parse_cdx(body):
    """Capture timestamps from a CDX JSON answer (header row first), in order.

    An empty body and [] both mean no captures.
    """
    text = body.decode("utf-8").strip() if isinstance(body, bytes) else str(body).strip()
    if not text:
        return []
    rows = json.loads(text)
    if not isinstance(rows, list):
        raise ValueError("a CDX answer is a JSON array")
    if not rows:
        return []
    header = rows[0]
    if not (isinstance(header, list) and "timestamp" in header):
        raise ValueError("a CDX answer starts with its field names")
    column = header.index("timestamp")
    stamps = []
    for row in rows[1:]:
        if isinstance(row, list) and len(row) > column and TIMESTAMP_RE.fullmatch(str(row[column])):
            stamps.append(str(row[column]))
    return stamps


def iso(timestamp):
    """20260701101112 -> 2026-07-01T10:11:12Z"""
    t = timestamp
    return f"{t[0:4]}-{t[4:6]}-{t[6:8]}T{t[8:10]}:{t[10:12]}:{t[12:14]}Z"


def _fetch(web, url):
    result, body = web.follow(url, cap=CDX_CAP, accept="application/json", timeout=CDX_TIMEOUT_SECONDS)
    if result["alive"]:
        try:
            return parse_cdx(body)
        except (ValueError, UnicodeDecodeError):
            raise LookupFailed("the CDX answer is not JSON rows") from None
    error = result.get("error") or "no response"
    if result["status"] == 429 or error in ("connection refused", "connection reset"):
        raise Blocked(error)
    raise LookupFailed(error)


def observe(web, url):
    """The wayback object (without checked) for url."""
    stamps = _fetch(web, cdx_url(url, ROW_LIMIT))
    if not stamps:
        return {"first": None, "last": None, "count": 0}
    record = {"first": iso(stamps[0]), "last": iso(stamps[-1]), "count": len(stamps)}
    if len(stamps) >= ROW_LIMIT:
        latest = _fetch(web, cdx_url(url, -1))
        if latest:
            record["last"] = iso(latest[-1])
        record["count_capped"] = True
    return record
