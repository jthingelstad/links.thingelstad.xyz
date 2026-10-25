"""Fetch Daring Fireball's monthly Linked List archive pages (titles, target
URLs and post text) for the pre-WT years. Read-only, paced, resumable."""
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(exist_ok=True)
UA = "links.thingelstad.xyz one-shot cleanup (jamie@thingelstad.com)"
months = []
y, m = 2005, 8
while (y, m) <= (2017, 6):
    months.append((y, m))
    m += 1
    if m == 13:
        y, m = y + 1, 1
posts = []
for y, m in months:
    cache = OUT / f"{y}-{m:02d}.html"
    if not cache.exists():
        req = urllib.request.Request(f"https://daringfireball.net/linked/{y}/{m:02d}/", headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                cache.write_bytes(r.read())
        except Exception as e:  # noqa: BLE001
            print(y, m, "ERR", e, file=sys.stderr)
            cache.write_text("")
        time.sleep(1.2)
    text = cache.read_text(encoding="utf-8", errors="replace")
    for dt, dd in re.findall(r"<dt[^>]*>(.*?)</dt>\s*<dd>(.*?)</dd>", text, re.S):
        link = re.search(r'<a href="([^"]+)">(.*?)</a>', dt, re.S)
        perma = re.search(r'href="(https?://daringfireball\.net/linked/(\d{4})/(\d{2})/(\d{2})/[^"]+)"', dt)
        if not link or not perma:
            continue
        body = html.unescape(re.sub(r"<[^>]+>", " ", dd))
        body = " ".join(body.split())
        posts.append({"title": html.unescape(re.sub(r"<[^>]+>", "", link.group(2))).strip(), "href": html.unescape(link.group(1)),
                      "permalink": perma.group(1), "date": f"{perma.group(2)}-{perma.group(3)}-{perma.group(4)}", "text": body[:600]})
(OUT / "df-linked.json").write_text(json.dumps(posts, ensure_ascii=False, indent=0))
print(len(posts), "posts from", len(months), "months")
