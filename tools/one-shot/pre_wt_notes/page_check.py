"""Is a note's text on the page it bookmarks? Checks the Wayback capture
nearest the save date, then the live page. One-shot, 2026-10.

  page_check.py <candidates.jsonl> <out.jsonl>

Each candidate: {"hash", "url", "saved": "YYYY-MM-DD", "texts": [{"label", "text"}]}.
Each output row adds "source" (wayback:<timestamp> | live | none) and, per text,
"on_page": true | false | null (null when no page text could be read).
Resumable: hashes already in out.jsonl are skipped. Paced: six seconds between
requests to the archive, one second per other host."""

import html
import json
import re
import sys
import time
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urlsplit
import urllib.error
import urllib.request

UA = "LinkingThings/0.1 (+https://links.thingelstad.xyz)"
AVAILABLE = "https://archive.org/wayback/available"
CAP = 1024 * 1024
TIMEOUT = 20
SPACING = {"archive": 6.0}
_last = {}


def pace_key(host):
    archive = host == "archive.org" or host.endswith(".archive.org")
    return "archive" if archive else host


def paced(host):
    host = pace_key(host)
    wait = SPACING.get(host, 1.0) - (time.monotonic() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)


def fetch(url, accept="text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5"):
    host = urlsplit(url).hostname or ""
    paced(host)
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read(CAP)
            return response.status, body
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        return code, b""
    except Exception as error:  # noqa: BLE001
        return None, str(error)[:120].encode()
    finally:
        _last[pace_key(host)] = time.monotonic()


class Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.depth = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if not self.depth:
            self.parts.append(data)


def page_text(body):
    try:
        raw = body.decode("utf-8")
    except UnicodeDecodeError:
        raw = body.decode("latin-1", errors="replace")
    parser = Text()
    try:
        parser.feed(raw)
    except Exception:  # noqa: BLE001
        pass
    return " ".join(parser.parts)


def normal(text):
    text = unicodedata.normalize("NFKC", html.unescape(text)).lower()
    text = re.sub(r"[^0-9a-z]+", " ", text)
    return " ".join(text.split())


def on_page(text, page):
    words = normal(text).split()
    if not words or not page:
        return False
    if len(words) <= 12:
        return " ".join(words) in page
    windows = []
    step = max(1, (len(words) - 10) // 4)
    for start in range(0, len(words) - 9, step):
        windows.append(" ".join(words[start : start + 10]))
        if len(windows) == 5:
            break
    found = sum(1 for window in windows if window in page)
    return found * 10 >= len(windows) * 6  # three of five windows


def wayback_page(url, saved):
    status, body = fetch(AVAILABLE + "?" + urlencode({"url": url, "timestamp": saved.replace("-", "")}), accept="application/json")
    if status != 200:
        return None, None
    try:
        closest = json.loads(body).get("archived_snapshots", {}).get("closest") or {}
    except ValueError:
        return None, None
    stamp = closest.get("timestamp")
    if not stamp or not closest.get("available"):
        return None, None
    status, body = fetch(f"https://web.archive.org/web/{stamp}id_/{url}")
    if status != 200 or not body:
        return None, stamp
    return page_text(body), stamp


def live_page(url):
    status, body = fetch(url)
    if status != 200 or not body:
        return None
    return page_text(body)


def check(candidate):
    text, stamp = wayback_page(candidate["url"], candidate["saved"])
    source = f"wayback:{stamp}" if text is not None else None
    if text is None:
        text = live_page(candidate["url"])
        source = "live" if text is not None else "none"
    page = normal(text) if text else ""
    row = dict(candidate)
    row["source"] = source
    row["page_chars"] = len(page)
    for item in row["texts"]:
        item["on_page"] = on_page(item["text"], page) if page else None
    return row


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    # Resume by hash AND labels: a candidate that gained a text since its last
    # check (the second model's vote landed) is checked again, and the later
    # row wins when decide.py reads the file.
    done = {}
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done.setdefault(row["hash"], set()).update(t["label"] for t in row["texts"])
    candidates = [json.loads(line) for line in src.read_text(encoding="utf-8").splitlines() if line.strip()]
    todo = [c for c in candidates if {t["label"] for t in c["texts"]} - done.get(c["hash"], set())]
    print(f"{len(candidates)} candidates, {len(done)} done, {len(todo)} to check", flush=True)
    with out.open("a", encoding="utf-8") as handle:
        for index, candidate in enumerate(todo, 1):
            row = check(candidate)
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            verdicts = ",".join(str(t["on_page"]) for t in row["texts"])
            print(f"{index}/{len(todo)} {row['hash'][:8]} {row['source']} {verdicts}", flush=True)


if __name__ == "__main__":
    main()
