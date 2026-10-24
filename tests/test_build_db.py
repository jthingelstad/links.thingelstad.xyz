"""tools/build_db.py: public/links.db from data/, facts only, deterministic.

Run: npm test (python3 -m unittest discover -s tests -p 'test_*.py').
"""

import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import build_db  # noqa: E402


def link_id(url):
    return hashlib.md5(url.encode()).hexdigest()[:12]


def link(url, saved, **extra):
    return {
        "id": link_id(url),
        "hash": hashlib.md5(url.encode()).hexdigest(),
        "url": url,
        "title": extra.get("title", url),
        "note": extra.get("note", ""),
        "saved": saved,
        "tags": extra.get("tags", []),
        "toread": False,
        "meta": "0" * 32,
    }


VIDEO = "https://www.youtube.com/watch?v=1YLQPJd9OtU"
REPO = "https://github.com/Homebrew/BrewUI"
POST = "https://www.kottke.org/26/01/a-post"
# 03:00 UTC on New Year's Day is still the old year in Central.
NEW_YEAR = "https://example.com/new-year"
LINKS = {
    "2025": [link(POST, "2025-06-01T12:00:00Z", tags=["web", "links"])],
    "2026": [
        link(NEW_YEAR, "2026-01-01T03:00:00Z"),
        link(VIDEO, "2026-03-01T12:00:00Z"),
        link(REPO, "2026-10-01T12:00:00Z"),
    ],
}
ISSUES = {
    "source": "fixture",
    "issues": [
        {
            "number": 352,
            "slug": "352",
            "title": "Three Fifty Two",
            "subject": "WT352",
            "date": "2026-10-03T12:00:00Z",
            "url": "https://weekly.thingelstad.com/archive/352/",
            "links": [
                {"position": 1, "id": link_id(REPO), "url": REPO, "text": "BrewUI",
                 "section": "Notable", "heading_context": None},
                {"position": 0, "id": None, "url": "https://never.saved/", "text": None,
                 "section": None, "heading_context": None},
            ],
        },
        {
            "number": None,
            "slug": "140-special",
            "title": "A special issue",
            "subject": "Special",
            "date": "2021-01-01T12:00:00Z",
            "url": "https://weekly.thingelstad.com/archive/140-special/",
            "links": [],
        },
    ],
}
LIVE = {"status": 200, "alive": True, "final_url": "https://example.com/moved", "redirects": []}
HOSTS = {
    "k.json": {
        "kottke.org": {
            "checked": "2026-10-23T21:00:00Z", "method": "enrich_hosts", "version": 2,
            "dns": {"resolves": True}, "https": {"reachable": True, "status": 200},
            "rdap": {"domain": "kottke.org", "registrar": "Registrar", "registered": "1998-12-26",
                     "expires": "2027-12-26"},
            "home": {"title": "kottke.org", "generator": "WordPress", "hcard": True, "rel_me": [],
                     "webmention": "https://kottke.org/webmention",
                     "feeds": [{"type": "rss", "url": "https://kottke.org/feed", "title": None},
                               {"type": "bogus", "url": "https://kottke.org/x"}]},
        }
    },
    "e.json": {
        # Nothing but liveness, and a home page that answered with an error.
        "example.com": {
            "checked": "2026-10-23T21:00:00Z", "method": "enrich_hosts", "version": 2,
            "dns": {"resolves": False},
            "home": {"title": "Access Denied", "error": "does not resolve", "feeds": []},
        }
    },
}
PAGES = {
    "2026.json": {
        link_id(VIDEO): {"checked": "2026-10-23T21:45:00Z", "method": "enrich_pages", **LIVE,
                         "wayback": {"first": "2026-03-14T18:02:11Z", "last": "2026-09-01T04:00:00Z",
                                     "count": 3}},
        link_id(REPO): {"checked": "2026-10-23T21:46:00Z", "method": "enrich_pages", **LIVE,
                        "wayback": {"first": None, "last": None, "count": 10000,
                                    "count_capped": True}},
        link_id(NEW_YEAR): {"checked": "2026-10-23T21:47:00Z", "method": "enrich_pages",
                            "alive": False, "wayback": {"first": None, "last": None, "count": 0}},
        "000000000000": {"checked": "2026-10-23T21:48:00Z", "wayback": {"count": 9}},
    }
}
FACTS = {
    "2026.json": {
        link_id(VIDEO): {"checked": "2026-10-23T22:00:00Z", "method": "youtube", "version": 1,
                         "kind": "video", "video_id": "1YLQPJd9OtU", "provider": "youtube",
                         "title": "Watt Window", "image": "/media/youtube/1YLQPJd9OtU.jpg",
                         "alive": True, "final_url": "https://example.com/gone"},
        link_id(REPO): {"checked": "2026-10-23T22:59:00Z", "method": "github", "version": 1,
                        "kind": "repository", "error": "HTTP 404"},
        "000000000000": {"checked": "2026-10-23T22:00:00Z", "method": "github", "version": 1,
                         "kind": "repository", "full_name": "someone/private"},
    }
}


def make_root(base):
    root = Path(base) / "repo"
    (root / "data/links").mkdir(parents=True)
    (root / "data/derived").mkdir()
    for year, links in LINKS.items():
        (root / f"data/links/{year}.json").write_text(json.dumps(links))
    (root / "data/derived/issues.json").write_text(json.dumps(ISSUES))
    for folder, shards in (("hosts", HOSTS), ("pages", PAGES), ("facts", FACTS)):
        (root / "data/enrichment" / folder).mkdir(parents=True)
        for name, shard in shards.items():
            (root / "data/enrichment" / folder / name).write_text(json.dumps(shard))
    return root


def build(root, out):
    with redirect_stdout(io.StringIO()):
        build_db.main(["--root", str(root), "--out", str(out)])


class BuildDbTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = make_root(self.temp.name)
        self.out = self.root / "public/links.db"
        build(self.root, self.out)
        self.db = sqlite3.connect(self.out)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.db.close)

    def rows(self, sql):
        return self.db.execute(sql).fetchall()

    def test_tables_and_columns(self):
        tables = {
            name: [column[1] for column in self.rows(f"PRAGMA table_info({name})")]
            for (name,) in self.rows("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        self.assertEqual(
            tables,
            {
                "links": ["id", "url", "title", "note", "saved", "tags", "meta", "year", "host"],
                "hosts": ["host", "links", "first", "last"],
                "issues": ["key", "number", "slug", "title", "date", "url"],
                "appearances": ["issue_key", "position", "id", "url", "text", "section"],
                "host_facts": ["host", "registered", "registrar", "expires", "home_title",
                               "generator", "hcard", "webmention", "feeds"],
                "wayback": ["id", "first", "last", "count", "count_capped"],
                "facts": ["id", "method", "kind", "json"],
                "meta": ["key", "value"],
            },
        )

    def test_links_hosts_and_the_central_year(self):
        links = {row[0]: row for row in self.rows("SELECT * FROM links")}
        self.assertEqual(len(links), 4)
        post = links[link_id(POST)]
        self.assertEqual(json.loads(post[5]), ["web", "links"])
        self.assertEqual(post[8], "kottke.org")  # one leading www. dropped
        self.assertEqual(links[link_id(NEW_YEAR)][7], 2025)
        self.assertEqual(
            self.rows("SELECT host, links, first, last FROM hosts WHERE host = 'kottke.org'"),
            [("kottke.org", 1, "2025-06-01T12:00:00Z", "2025-06-01T12:00:00Z")],
        )
        self.assertEqual(self.rows("SELECT count(*) FROM hosts"), [(4,)])

    def test_issues_and_appearances(self):
        self.assertEqual(
            self.rows("SELECT key, number FROM issues ORDER BY key"),
            [("140-special", None), ("352", 352)],
        )
        self.assertEqual(
            self.rows("SELECT issue_key, position, id, section FROM appearances"),
            [("352", 0, None, None), ("352", 1, link_id(REPO), "Notable")],
        )

    def test_host_facts_without_liveness(self):
        rows = self.rows("SELECT * FROM host_facts")
        self.assertEqual(len(rows), 1)  # example.com shows nothing
        host, registered, registrar, expires, title, generator, hcard, webmention, feeds = rows[0]
        self.assertEqual((host, registered, expires, title, hcard), ("kottke.org", "1998-12-26",
                                                                   "2027-12-26", "kottke.org", 1))
        self.assertEqual(json.loads(feeds), [{"type": "rss", "url": "https://kottke.org/feed"}])

    def test_wayback_and_facts(self):
        self.assertEqual(
            self.rows("SELECT id, count, count_capped FROM wayback ORDER BY id"),
            sorted([(link_id(VIDEO), 3, 0), (link_id(REPO), 10000, 1), (link_id(NEW_YEAR), 0, 0)]),
        )
        facts = self.rows("SELECT id, method, kind, json FROM facts")
        self.assertEqual([row[:3] for row in facts], [(link_id(VIDEO), "youtube", "video")])
        record = json.loads(facts[0][3])
        self.assertEqual(record["video_id"], "1YLQPJd9OtU")
        self.assertNotIn("alive", record)
        self.assertNotIn("final_url", record)

    def test_no_liveness_anywhere(self):
        self.db.close()
        data = self.out.read_bytes()
        for word in (b"final_url", b"alive", b"reachable", b"resolves", b"does not resolve",
                     b"Access Denied", b"redirects", b"HTTP 404", b"example.com/moved"):
            self.assertNotIn(word, data, word)

    def test_meta(self):
        meta = dict(self.rows("SELECT key, value FROM meta"))
        # The newest moment in the data: the failed facts check at 22:59.
        self.assertEqual(meta["built_at"], "2026-10-23T22:59:00Z")
        self.assertEqual(meta["method"], "build_db")
        self.assertEqual(meta["count.links"], "4")
        self.assertEqual(meta["count.appearances"], "2")

    def test_deterministic(self):
        first = self.out.read_bytes()
        build(self.root, self.out)  # over the existing file
        self.assertEqual(self.out.read_bytes(), first)
        other = Path(self.temp.name) / "other.db"
        build(self.root, other)
        self.assertEqual(other.read_bytes(), first)
        self.assertFalse((self.out.parent / "links.db.tmp").exists())


if __name__ == "__main__":
    unittest.main()
