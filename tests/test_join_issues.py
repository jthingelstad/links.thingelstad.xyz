"""The join to The Weekly Thing. Run: python3 -m unittest discover -s tests -v"""

import contextlib
import io
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import join_issues  # noqa: E402
from linking import jsonio  # noqa: E402
from linking.issues import IssueError, LinkIndex, build, read_issue  # noqa: E402
from linking.urls import link_id, md5_hex  # noqa: E402


def record(url, saved):
    return {
        "id": link_id(url),
        "hash": md5_hex(url),
        "url": url,
        "title": "t",
        "note": "",
        "saved": saved,
        "tags": [],
        "toread": False,
        "meta": md5_hex("m" + url),
    }


SAVED = [
    record("https://www.example.com/post/", "2020-01-01T00:00:00Z"),
    record("http://twice.example/", "2017-05-28T21:13:27Z"),
    record("https://twice.example/", "2020-10-20T02:20:48Z"),
    record("https://three.example/x", "2019-01-01T00:00:00Z"),
    record("http://three.example/x/", "2021-01-01T00:00:00Z"),
    record("https://three.example/x?utm_source=y", "2023-01-01T00:00:00Z"),
]
ID = {r["url"]: r["id"] for r in SAVED}


def issue_file(directory, name, front_matter):
    path = Path(directory) / name
    path.write_text("---\n" + textwrap.dedent(front_matter).lstrip("\n") + "---\nBody\n", encoding="utf-8")
    return path


class MatchTest(unittest.TestCase):
    def setUp(self):
        self.index = LinkIndex(SAVED)

    def test_normalised_match(self):
        self.assertEqual(
            self.index.match("http://example.com/post?utm_campaign=wt#top", "2020-02-01T12:00:00Z"),
            ID["https://www.example.com/post/"],
        )

    def test_not_saved(self):
        self.assertIsNone(self.index.match("https://elsewhere.example/", "2020-02-01T12:00:00Z"))

    def test_saved_twice_prefers_the_exact_url(self):
        # WT4 linked the http form in 2017; the https form was saved in 2020.
        self.assertEqual(self.index.match("http://twice.example/", "2017-06-03T12:00:00Z"), ID["http://twice.example/"])
        self.assertEqual(self.index.match("https://twice.example/", "2020-10-24T12:00:00Z"), ID["https://twice.example/"])

    def test_saved_twice_without_exact_url_takes_the_latest_saved_before_the_issue(self):
        self.assertEqual(
            self.index.match("https://three.example/x/#a", "2022-01-01T12:00:00Z"), ID["http://three.example/x/"]
        )
        self.assertEqual(
            self.index.match("https://three.example/x/#a", "2020-01-01T12:00:00Z"), ID["https://three.example/x"]
        )

    def test_saved_twice_all_after_the_issue_takes_the_earliest(self):
        self.assertEqual(
            self.index.match("https://three.example/x/#a", "2018-01-01T12:00:00Z"), ID["https://three.example/x"]
        )


class ReadIssueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.index = LinkIndex(SAVED)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_numbered_issue(self):
        path = issue_file(
            self.dir,
            "350.md",
            """
            number: 350
            subject: WT350 — Builders Puzzlers And Agents
            publish_date: '2026-09-19T12:00:00Z'
            slug: '350'
            links:
            - text: 'It''s a post'
              url: https://example.com/post
              domain: example.com
              heading_context: '[It''s a post](https://example.com/post)'
              section: Notable
            - text: No URL here
              url: ''
            - text: "Not saved"
              url: "https://elsewhere.example/"
              heading_context: null
              section: null
            permalink: /archive/350/
            """,
        )
        issue = read_issue(path, self.index)
        self.assertEqual(list(issue), ["number", "slug", "title", "subject", "date", "url", "links"])
        self.assertEqual(issue["number"], 350)
        self.assertEqual(issue["slug"], "350")
        self.assertEqual(issue["title"], "Builders Puzzlers And Agents")
        self.assertEqual(issue["subject"], "WT350 — Builders Puzzlers And Agents")
        self.assertEqual(issue["url"], "https://weekly.thingelstad.com/archive/350/")
        self.assertEqual(
            issue["links"],
            [
                {
                    "position": 0,
                    "id": ID["https://www.example.com/post/"],
                    "url": "https://example.com/post",
                    "text": "It's a post",
                    "section": "Notable",
                    "heading_context": "[It's a post](https://example.com/post)",
                },
                {
                    "position": 1,
                    "id": None,
                    "url": "https://elsewhere.example/",
                    "text": "Not saved",
                    "section": None,
                    "heading_context": None,
                },
            ],
        )

    def test_the_special_issue_and_a_slug_that_is_not_the_path(self):
        path = issue_file(
            self.dir,
            "140-special.md",
            """
            number: 140-special
            subject: 'Special Thing #140 / Matching Donations to Second Harvest!'
            publish_date: '2020-03-23T23:00:00Z'
            slug: special-thing-140-matching-donations-to-second
            links: []
            permalink: /archive/140-special/
            """,
        )
        issue = read_issue(path, self.index)
        self.assertIsNone(issue["number"])
        self.assertEqual(issue["slug"], "special-thing-140-matching-donations-to-second")
        self.assertEqual(issue["title"], "Special Thing #140 / Matching Donations to Second Harvest!")
        # The issue's own page, not the /archive/<slug>/ redirect to it.
        self.assertEqual(issue["url"], "https://weekly.thingelstad.com/archive/140-special/")
        self.assertEqual(issue["links"], [])

    def test_quoted_number_and_microsecond_dates(self):
        path = issue_file(
            self.dir,
            "173.md",
            """
            number: "173"
            subject: "Weekly Thing #173 / Things"
            publish_date: '2021-02-13T16:55:35.260587Z'
            slug: weekly-thing-173-things
            links: []
            permalink: /archive/173/
            """,
        )
        issue = read_issue(path, self.index)
        self.assertEqual(issue["number"], 173)
        self.assertEqual(issue["date"], "2021-02-13T16:55:35.260587Z")
        self.assertEqual(issue["title"], "Weekly Thing #173 / Things")

    def test_bad_files_are_named(self):
        path = issue_file(self.dir, "9.md", "number: 9\npublish_date: yesterday\n")
        with self.assertRaises(IssueError) as caught:
            read_issue(path, self.index)
        self.assertIn("9.md", str(caught.exception))
        (self.dir / "10.md").write_text("no front matter\n")
        with self.assertRaises(IssueError) as caught:
            read_issue(self.dir / "10.md", self.index)
        self.assertIn("10.md", str(caught.exception))


class BuildTest(unittest.TestCase):
    def test_build_sorts_by_date_then_slug_and_skips_templates(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            archive.mkdir()
            for name, date, slug in (
                ("2.md", "2017-05-20T13:00:00Z", "b-second"),
                ("1.md", "2017-05-13T13:00:00Z", "z-first"),
                ("3.md", "2017-05-20T13:00:00Z", "a-same-day"),
            ):
                issue_file(
                    archive,
                    name,
                    f"number: {name[0]}\nsubject: S\npublish_date: '{date}'\nslug: {slug}\nlinks: []\n"
                    f"permalink: /archive/{name[0]}/\n",
                )
            (archive / "archive.njk").write_text("---\nlayout: x\n---\n")
            (archive / "redirects.njk").write_text("---\npagination: {}\n---\n")
            links = Path(tmp) / "links"
            jsonio.write_json(links / "2020.json", [SAVED[0]])
            document = build(archive, links)
            self.assertEqual(list(document), ["source", "issues"])
            self.assertEqual([i["slug"] for i in document["issues"]], ["z-first", "a-same-day", "b-second"])

            out = Path(tmp) / "derived" / "issues.json"
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                code = join_issues.main(["--archive", str(archive), "--links", str(links), "--out", str(out)])
            self.assertEqual(code, 0)
            self.assertEqual(out.read_text(encoding="utf-8"), jsonio.dumps(document))
            self.assertIn("3 issues", printed.getvalue())

    def test_duplicate_slugs_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("1.md", "2.md"):
                issue_file(tmp, name, "subject: S\npublish_date: '2017-05-13T13:00:00Z'\nslug: same\n")
            with self.assertRaises(IssueError):
                build(tmp, Path(tmp) / "links")


if __name__ == "__main__":
    unittest.main()
