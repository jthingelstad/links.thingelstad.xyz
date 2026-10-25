"""The cleanup pool: bookmarks saved before WT1 (2017-05-13) whose note is bare
text, neither an HTML nor a Markdown blockquote. One-shot, 2026-10. Reads the
posts/all export; writes nothing."""

import hashlib
import json
import re
import sys

WT1 = "2017-05-13"
BLOCKQUOTE_RE = re.compile(r"<blockquote|^>\s", re.M)
HEAD, TAIL, LIMIT = 3000, 1000, 6000


def load_pool(export_path, include_private=True):
    posts = json.load(open(export_path, encoding="utf-8"))
    pool = []
    for post in posts:
        if post["time"][:10] >= WT1 or not post["extended"].strip():
            continue
        if BLOCKQUOTE_RE.search(post["extended"]):
            continue
        if post["shared"] != "yes" and not include_private:
            continue
        pool.append(post)
    pool.sort(key=lambda p: p["time"])
    return posts, pool


def html_blockquote_notes(posts):
    return [p for p in posts if p["time"][:10] < WT1 and "<blockquote" in p["extended"]]


def clipped(note):
    """The note as the model sees it: whole when short, else head and tail."""
    if len(note) <= LIMIT:
        return note
    omitted = len(note) - HEAD - TAIL
    return note[:HEAD] + f"\n[... {omitted} characters omitted ...]\n" + note[-TAIL:]


def check_hashes(posts):
    bad = [p["href"] for p in posts if hashlib.md5(p["href"].encode("utf-8")).hexdigest() != p["hash"]]
    return bad


if __name__ == "__main__":
    posts, pool = load_pool(sys.argv[1])
    private = sum(1 for p in pool if p["shared"] != "yes")
    chars = sum(len(p["extended"]) for p in pool)
    sent = sum(len(clipped(p["extended"])) for p in pool)
    print(f"pool {len(pool)} notes ({private} private); {chars:,} chars, {sent:,} sent after clipping; html blockquote notes {len(html_blockquote_notes(posts))}; hash mismatches {len(check_hashes(posts))}")
