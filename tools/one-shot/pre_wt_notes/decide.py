"""Decide each pool note's new text from the rules, the two model votes and
the page checks, and write the change file. One-shot, 2026-10.

  decide.py <export> <out_dir>

Writes changes.jsonl (one row per bookmark whose note changes), kept.jsonl
(notes left bare as Jamie's words), and summary.json. Nothing here writes to
Pinboard."""

import collections
import html
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pool import html_blockquote_notes, load_pool  # noqa: E402

MODELS = ("claude-sonnet-5-5", "claude-opus-5-5")
ELLIPSIS_RE = re.compile(r"(\.\.\.|…)\s*$")
CHROME_RE = re.compile(r"appeared first on|Play in new window", re.M)
TWEET_RE = re.compile(r"^(RT @|via @)|^@\w+")
# A handle or hashtag anywhere in a short note: a tweet of Jamie's, saved to
# Pinboard by the Twitter sync of 2008 to 2015.
HANDLE_RE = re.compile(r"(?<![\w/])[@#][A-Za-z_]\w+")
TWEET_MAX = 200
STRONGER = "claude-opus-5-5"
NOAPOS_RE = re.compile(r"\b(heres|theres|thats|whats|cant|dont|wont|isnt|doesnt|didnt|youre|theyre|wouldnt|couldnt|shouldnt)\b", re.I)
# Daring Fireball's permalink marker, in every Linked List feed item since 2009.
STAR = "\u2605"
QUOTED_RE = re.compile(r'^["“](.*)["”]$', re.S)
TAG_RE = re.compile(r"<[^>]+>")
# Share-button labels a bookmarklet copied along with the text.
CHROME_LINE_RE = re.compile(r"^[ \t]*(Tweet|Permalink|Share|Email|Print)[ \t]*$", re.M | re.I)
# A footer marker: everything from it to the end is the page's chrome.
FOOTER_RE = re.compile(r"^[ \t]*(Related|Comments?|Share this:|Like this:|[-_=*]{10,})[ \t]*$|^[ \t]*Read more\b", re.M | re.I)
# A byline the bookmarklet copied above the article.
BYLINE_RE = re.compile(r"\A\s*by [A-Z][^\n]{0,80}\n")
INDENT_RE = re.compile(r"[ \t]{2,}\S")
# A full-text feed item (TUAW, Engadget, Business Insider) pasted whole: the
# article's words between a "Filed under" header and a syndication footer.
FEED_RE = re.compile(r"^\s*Filed under:|originally appeared on|terms for use of feeds|Read\s*\|\s*Permalink"
                     r"|Continue reading|Join the conversation about this story|appeared first on", re.M)
PARA_SPLIT_RE = re.compile(r"\n[ \t\r]*\n")


# TUAW's categories, 2007 to 2010, learned from the pool: a "Filed under:" line
# often runs straight into the article on the same line, and only the vocabulary
# says where the categories stop.
TUAW_CATEGORIES = {
    "Accessories", "Analysis / Opinion", "App Store", "Apple", "Apple Corporate", "Apple History", "Beta Beat",
    "Bluetooth", "Cool tools", "Deals", "Developer", "Features", "First Look", "Freeware", "Gaming",
    "Graphic Design", "Hardware", "Internet", "Internet Tools", "Leopard", "Mac mini", "MacBook", "MacBook Air",
    "Macbook Pro", "Macworld", "Multimedia", "OS", "Odds and ends", "Open Source", "Other Events", "Peripherals",
    "Podcasting", "Productivity", "Retail", "Robots", "Rumors", "SDK", "SXSW", "Snow Leopard", "Software",
    "Software Update", "Switchers", "Terminal Tips", "The Woz", "Troubleshooting", "Video", "WWDC", "Wireless",
    "iPhone", "iPod Family", "iPod classic", "iPod touch", "iTS", "iTunes",
}


def strip_filed_under(note):
    """Drop the "Filed under: A, B" header; the article may share its line."""
    match = re.match(r"^\s*Filed under:[ \t]*([^\n]*)(\n?)", note)
    if not match:
        return note
    line, rest = match.group(1), note[match.end():]
    if match.group(2) and rest.strip():
        return rest  # the line was categories only
    newline = "\n" if match.group(2) else ""
    segments = line.split(", ")
    for index, segment in enumerate(segments):
        if segment.strip() in TUAW_CATEGORIES:
            continue
        # The first segment that is not a whole category: peel the category
        # it starts with, and the article begins right after it.
        words = segment.split()
        body = segment
        for count in range(min(4, len(words)), 0, -1):
            if " ".join(words[:count]) in TUAW_CATEGORIES:
                body = " ".join(words[count:])
                break
        return ", ".join([body] + segments[index + 1 :]) + newline + rest
    return rest


def strip_feed(note, title=""):
    """Drop a feed item's header and syndication footer, keeping the article."""
    text = strip_filed_under(note)
    marker = re.search(r"originally appeared on", text)
    if marker:
        cut = marker.start()
        title = title.strip()
        start = text.rfind(title, 0, cut) if title else -1
        if start >= 0 and not text[start + len(title) : cut].strip():
            cut = start
        elif "\n" in text[:cut]:
            cut = text.rfind("\n", 0, cut) + 1
        text = text[:cut]
    text = re.sub(r"Continue reading.*$", "", text, flags=re.S)
    text = re.sub(r"Join the conversation about this story.*$", "", text, flags=re.S)
    text = re.sub(r"^See Also:.*$", "", text, flags=re.S | re.M)
    text = re.sub(r"The post .{0,300}? appeared first on .*$", "", text, flags=re.S)
    text = re.sub(r"^[ \t]*(Source|Permalink\b.*|Read\s*\|.*)[ \t]*$", "", text, flags=re.M)
    # A "Read" link or the site label glued to the last sentence.
    text = re.sub(r"(?<=[.!?)\"\u201d])(Read|TUAW|Engadget)\s*$", "", text)
    return text


def strip_chrome(note, title=""):
    """Drop share-button labels, feed chrome, and everything from a footer marker on."""
    if FEED_RE.search(note):
        note = strip_feed(note, title)
    note = BYLINE_RE.sub("", note, count=1)
    footer = FOOTER_RE.search(note)
    text = note[: footer.start()] if footer else note
    return CHROME_LINE_RE.sub("", text)


def attribution_parts(note):
    """Paragraphs of a note in the linkblog form: a plain line ending in a
    colon ("Jesse Thorn:"), then the passage as indented paragraphs, sometimes
    a plain comment after; or a short "Author:" line then plain paragraphs.
    None when the note has neither shape. Whose line the attribution is (the
    page author's, on a linkblog like mjtsai.com, or Jamie's) is settled by
    the page check on the "attribution" probe."""
    parts = [p for p in PARA_SPLIT_RE.split(note.strip("\n")) if p.strip()]
    if len(parts) < 2:
        return None
    first = parts[0]
    if INDENT_RE.match(first) or not first.strip().endswith(":"):
        return None
    if any(INDENT_RE.match(p) for p in parts[1:]) or len(first.strip()) <= 80:
        return parts
    return None


def attribution_split(parts):
    """Plain paragraphs bare as Jamie's, indented ones quoted; without indents
    the first line stays bare and the rest is quoted."""
    if any(INDENT_RE.match(p) for p in parts[1:]):
        blocks, run = [], []
        for part in parts:
            if INDENT_RE.match(part):
                run.append(part)
                continue
            if run:
                blocks.append(quote("\n\n".join(run)))
                run = []
            blocks.append(" ".join(part.split()))
        if run:
            blocks.append(quote("\n\n".join(run)))
        return "\n\n".join(blocks)
    return " ".join(parts[0].split()) + "\n\n" + quote("\n\n".join(parts[1:]))


def probes(post):
    """Texts the page must settle for the rules, label -> text, for candidates.py.
    "attribution": the attribution line plus the opening of the passage; on the
    page as one sequence means the line is the page author's. "body": a feed
    item's article text; on the page means it is the page's words verbatim."""
    cleaned = strip_chrome(post["extended"], post["description"])
    out = {}
    if FEED_RE.search(post["extended"]):
        body = cleaned.strip()
        if len(body.split()) >= 12:
            out["body"] = body
    parts = attribution_parts(cleaned)
    if parts:
        passage = next((p for p in parts[1:] if INDENT_RE.match(p)), parts[1])
        out["attribution"] = " ".join(parts[0].split()) + " " + " ".join(passage.split()[:12])
    return out


def signature(note):
    s = note.strip()
    if ELLIPSIS_RE.search(s):
        return "truncated"
    if CHROME_RE.search(s):
        return "chrome"
    if TWEET_RE.search(s):
        return "tweet"
    if QUOTED_RE.match(s) and s.count('"') + s.count("“") + s.count("”") == 2:
        return "quoted"
    if re.search(r"\n{3,}", note):
        return "pasted"
    return ""


def normal(text):
    text = unicodedata.normalize("NFKC", html.unescape(text)).lower()
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def paragraphs(text):
    return [" ".join(p.split()) for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]


def quote(text):
    # Feed text arrived HTML-escaped ("View &gt; RPN"); a quoted note reads as text.
    text = html.unescape(text)
    return "\n>\n".join("> " + p for p in paragraphs(text))


def strip_quotes(text):
    match = QUOTED_RE.match(text.strip())
    return match.group(1).strip() if match else text.strip()


def split_note(note, jamie_text):
    """Jamie's part bare, the rest quoted; None when the split is not verbatim."""
    note = note.strip()
    jamie_text = jamie_text.strip()
    index = note.find(jamie_text)
    if not jamie_text or index < 0:
        return None
    before, after = note[:index].strip(), note[index + len(jamie_text) :].strip()
    parts = []
    if before:
        parts.append(quote(before))
    parts.append(" ".join(p for p in paragraphs(jamie_text)) if "\n" not in jamie_text else "\n\n".join(paragraphs(jamie_text)))
    if after:
        parts.append(quote(after))
    return "\n\n".join(parts)


def verbatim(note, text, min_words=12):
    text = (text or "").strip()
    return bool(text) and text in note and len(text.split()) >= min_words


def html_to_markdown_quote(note):
    """Replace each <blockquote>...</blockquote> with Markdown quote lines."""

    def replace(match):
        inner = html.unescape(TAG_RE.sub("", match.group(1)))
        return "\n\n" + quote(inner) + "\n\n"

    text = re.sub(r"<blockquote[^>]*>(.*?)</blockquote>", replace, note, flags=re.S | re.I)
    text = html.unescape(TAG_RE.sub("", text)) if "<" in text else text
    return "\n\n".join(paragraphs(text)) if "\n>\n" not in text else re.sub(r"\n{3,}", "\n\n", text).strip()


def nurl(url):
    url = (url or "").strip().lower()
    url = re.sub(r"^https?://(www\.)?", "", url).split("#")[0]
    return url.rstrip("/")


class LinkblogIndex:
    """Daring Fireball's Linked List, 2005 to 2017 (df-linked.json, fetched from
    the monthly archive pages): a note whose text is a DF post is John Gruber's
    framing and commentary, pasted along with the link, never Jamie's words.
    Matched on the text, not the link: Jamie saved many links from DF with notes
    of his own. Apostrophes are dropped before comparing, because the feed that
    carried the posts into Pinboard stripped them ("Its a good acquisition")."""

    SHINGLE = 8

    def __init__(self, posts):
        self.by_href, self.by_title, self.by_prefix = {}, {}, {}
        for post in posts:
            text = self.normal(post.get("text", ""))
            if not text:
                continue
            post = dict(post, _text=text, _shingles=self.shingles(text))
            self.by_href.setdefault(nurl(post["href"]), []).append(post)
            self.by_title.setdefault(self.normal(post["title"]), []).append(post)
            self.by_prefix.setdefault(text[:60], post)

    @staticmethod
    def normal(text):
        text = unicodedata.normalize("NFKC", html.unescape(text or "")).lower()
        text = re.sub(r"[\u2019'`]", "", text)
        return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())

    @classmethod
    def shingles(cls, text):
        words = text.split()
        return {" ".join(words[i:i + cls.SHINGLE]) for i in range(len(words) - cls.SHINGLE + 1)}

    def match(self, post, note):
        n = self.normal(note)
        if len(n) < 12:
            return None
        candidates = self.by_href.get(nurl(post["href"]), []) + self.by_title.get(self.normal(post["description"]), [])
        own = self.shingles(n)
        for candidate in candidates:
            t = candidate["_text"]
            if n[:80] in t or (len(t) >= 12 and t[:80] in n) or (own and own & candidate["_shingles"]):
                return candidate
        if len(n) >= 40:
            return self.by_prefix.get(n[:60])
        return None


def load_linkblog(out_dir):
    path = out_dir / "df-linked.json"
    if not path.exists():
        return None
    return LinkblogIndex(json.loads(path.read_text(encoding="utf-8")))


def read_jsonl(path):
    rows = {}
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["hash"]] = row
    return rows


def page_verdicts(check):
    """label -> on_page for a page-check row (None when unchecked)."""
    if not check:
        return {}
    return {t["label"]: t.get("on_page") for t in check.get("texts", [])}


def decide(post, votes, check, linkblog=None):
    cleaned = strip_chrome(post["extended"], post["description"])
    note = cleaned.strip()
    feed = bool(FEED_RE.search(post["extended"]))
    sig = signature(note)
    kinds = {m: (votes.get(m) or {}).get("kind") for m in MODELS}
    confs = {m: (votes.get(m) or {}).get("confidence") for m in MODELS}
    verdicts = page_verdicts(check)
    source = (check or {}).get("source")
    present = [k for k in kinds.values() if k]
    agreed = present[0] if len(present) == 2 and present[0] == present[1] else None
    signals = {"signature": sig, "votes": kinds, "confidence": confs, "page": verdicts, "page_source": source,
               "chrome_stripped": cleaned != post["extended"], "feed": feed}

    def result(action, new, why):
        return {"action": action, "new": new, "why": why, "signals": signals}

    # Deterministic rules first.
    # A Daring Fireball link post: Gruber's words, pasted with the link. The
    # star is DF's permalink marker; the text match reads the DF archive.
    if STAR in note:
        return result("quote", quote(note), "rule: a linkblog post (the star marker), quoted")
    linked = linkblog.match(post, note) if linkblog else None
    if linked:
        signals["linkblog"] = linked["permalink"]
        return result("quote", quote(note), "rule: a Daring Fireball link post, quoted")
    # A tweet of Jamie's, saved by the Twitter sync: Jamie's words, kept. A
    # page's own text that happens to open with a handle has both votes on
    # "page" and no tweet shape beyond the handle.
    tweetish = sig == "tweet" or "tweet" in present or (len(note) <= TWEET_MAX and HANDLE_RE.search(note))
    if tweetish and agreed != "page" and ({"tweet", "jamie", "mixed"} & set(present)):
        return result("keep", note, "rule: a tweet of Jamie's, kept")
    if sig == "tweet":
        return result("quote", quote(note), "rule: a tweet-shaped note both models call the page's words")
    if sig == "quoted":
        return result("quote", quote(strip_quotes(note)), "rule: wrapped in quotation marks")
    if not note:
        return result("blank", "", "rule: nothing but share buttons or a footer")
    if feed:
        if len(note.split()) < 12:
            return result("blank", "", "rule: a feed item with no article text left")
        if verdicts.get("body") is False:
            return result("blank", "", "rule: a feed item whose text is not on the page")
        return result("quote", quote(note), "rule: a feed item's article text, quoted"
                      + ("; confirmed on the page" if verdicts.get("body") else "; page unreadable"))
    parts = attribution_parts(cleaned)
    if parts:
        on_page = verdicts.get("attribution")
        if on_page is True:
            return result("quote", quote(note), "rule: attribution line and passage are both on the page; the page's words")
        if on_page is False and ("jamie" in present or "mixed" in present):
            return result("split", attribution_split(parts), "rule: an attribution line of Jamie's, then the passage")
        if on_page is False:
            return result("quote", quote(note), "rule: an attribution line not on the page, but no model saw Jamie's words; quoted whole")
        if "jamie" in present or "mixed" in present:
            return result("split", attribution_split(parts), "rule: an attribution line; page unreadable, a model saw Jamie's words")
        return result("quote", quote(note), "rule: an attribution line; page unreadable, no model saw Jamie's words; quoted whole")
    if sig in ("truncated", "chrome") and "jamie" not in present and "mixed" not in present:
        salvage = max((v.get("page_text", "") for v in votes.values() if v), key=len, default="")
        if verbatim(note, salvage):
            return result("quote", quote(salvage), f"rule: {sig}; kept the passage a model found inside")
        return result("blank", "", f"rule: {sig}")

    # Agreement.
    if agreed == "page":
        return result("quote", quote(note), "both models: the page's words")
    if agreed in ("tweet", "quoted"):
        return result("quote", quote(strip_quotes(note) if agreed == "quoted" else note), f"both models: {agreed}")
    if agreed == "tool":
        salvage = max((v.get("page_text", "") for v in votes.values() if v), key=len, default="")
        if verbatim(note, salvage):
            return result("quote", quote(salvage), "both models: tool text; kept the passage inside")
        return result("blank", "", "both models: tool text")
    if agreed == "jamie":
        if verdicts.get("note") is True:
            return result("quote", quote(note), "both models said Jamie, but the text is on the page")
        return result("keep", note, "both models: Jamie's words; not found on the page" if verdicts.get("note") is False else "both models: Jamie's words; page unreadable")
    if agreed == "mixed":
        jamie_texts = {m: (votes[m] or {}).get("jamie_text", "").strip() for m in MODELS}
        if any(verdicts.get(f"jamie:{m}") is True for m in MODELS):
            return result("quote", quote(note), "both models said mixed, but the part called Jamie's is on the page")
        chosen = None
        for m in MODELS:
            if verdicts.get(f"page:{m}") is True and jamie_texts[m]:
                chosen = jamie_texts[m]
                break
        if chosen is None:
            texts = [t for t in jamie_texts.values() if t]
            chosen = min(texts, key=len) if texts else ""
        split = split_note(note, chosen)
        if split:
            return result("split", split, "both models: mixed; Jamie's part bare, the rest quoted")
        return result("quote", quote(note), "both models: mixed, but no verbatim split; quoted whole")

    # Disagreement or a missing vote: the page settles what it can, else quote.
    jamie_ish = [m for m in MODELS if kinds[m] in ("jamie", "mixed")]
    if jamie_ish:
        labels = ["note"] + [f"jamie:{m}" for m in MODELS]
        if any(verdicts.get(label) is True for label in labels):
            return result("quote", quote(note), "models disagree; the text called Jamie's is on the page")
        if len(present) == 1 and present[0] == "jamie" and verdicts.get("note") is False:
            return result("keep", note, "one vote only: Jamie's words, not on the page")
        if len(jamie_ish) == 2:
            return result("keep", note, "models disagree only on how much is Jamie's; nothing found on the page; kept")
        # A short note the stronger model called Jamie's: the one-line
        # descriptors of 2005 to 2011. When only the weaker model saw Jamie,
        # the note is usually the page's own tagline or dek, so it is quoted.
        # Dropped apostrophes ("heres", "thats") mark text pasted from a feed.
        if (len(note) <= TWEET_MAX and sig != "pasted" and kinds[STRONGER] in ("jamie", "mixed")
                and not NOAPOS_RE.search(note)):
            return result("keep", note, "models disagree; a short note not on the page, kept as Jamie's")
        return result("quote", quote(note), "models disagree and the page cannot settle it; quoted")
    if "tool" in present and sig in ("truncated", "chrome", "pasted"):
        salvage = max((v.get("page_text", "") for v in votes.values() if v), key=len, default="")
        if verbatim(note, salvage):
            return result("quote", quote(salvage), "one model: tool text, and the note carries a tool signature; kept the passage inside")
        return result("blank", "", "one model: tool text, and the note carries a tool signature")
    return result("quote", quote(note), "models disagree between the page's words and tool text; quoted")


def main():
    export, out_dir = sys.argv[1], Path(sys.argv[2])
    posts, pool = load_pool(export)
    votes = {m: read_jsonl(out_dir / f"model-{m}.jsonl") for m in MODELS}
    checks = read_jsonl(out_dir / "page-checks.jsonl")
    linkblog = load_linkblog(out_dir)
    changes, kept = [], []
    actions, whys = collections.Counter(), collections.Counter()
    for post in pool:
        decision = decide(post, {m: votes[m].get(post["hash"]) for m in MODELS}, checks.get(post["hash"]), linkblog)
        row = {"hash": post["hash"], "url": post["href"], "saved": post["time"], "shared": post["shared"], "title": post["description"],
               "action": decision["action"], "why": decision["why"], "signals": decision["signals"],
               "old": post["extended"], "new": decision["new"]}
        actions[decision["action"]] += 1
        whys[decision["why"]] += 1
        (kept if decision["action"] == "keep" else changes).append(row)
    for post in html_blockquote_notes(posts):
        new = html_to_markdown_quote(post["extended"])
        if new != post["extended"]:
            changes.append({"hash": post["hash"], "url": post["href"], "saved": post["time"], "shared": post["shared"], "title": post["description"],
                            "action": "markdown", "why": "HTML blockquote to the Markdown form", "signals": {}, "old": post["extended"], "new": new})
            actions["markdown"] += 1
    changes.sort(key=lambda r: r["saved"])
    for name, rows in (("changes.jsonl", changes), ("kept.jsonl", kept)):
        with (out_dir / name).open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    summary = {"pool": len(pool), "changes": len(changes), "kept": len(kept), "actions": dict(actions), "reasons": dict(whys.most_common())}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(json.dumps(summary, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
