"""enrich_facts.py and the special-host adapters: which URLs each applies to,
the records they write, errors, the GitHub token and rate limit, and the
images under public/media/. Fake transports only; no network.

Run: python3 -I -m unittest discover -s tests -v
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import enrich_facts  # noqa: E402
from linking import adapters, jsonio, web  # noqa: E402
from linking import facts as fx  # noqa: E402
from linking.adapters import github, openlibrary, vimeo, wikipedia, youtube  # noqa: E402
from linking.adapters.base import AdapterError, Context, save_image  # noqa: E402
from linking.urls import md5_hex  # noqa: E402
from test_enrich_web import FakeClock, FakeTransport, public_resolver  # noqa: E402

START = datetime(2026, 10, 24, 2, 0, 0, tzinfo=timezone.utc)
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200


def record(url, saved):
    digest = md5_hex(url)
    return {"id": digest[:12], "hash": digest, "url": url, "title": "t", "note": "", "saved": saved,
            "tags": [], "toread": False, "meta": md5_hex("m" + url)}


def json_answer(value, status=200, headers=None):
    return (status, {"Content-Type": "application/json", **(headers or {})}, json.dumps(value).encode())


def yt_oembed(video):
    return "https://www.youtube.com/oembed?" + urlencode({"url": f"https://www.youtube.com/watch?v={video}", "format": "json"})


def vimeo_oembed(video):
    return "https://vimeo.com/api/oembed.json?" + urlencode({"url": f"https://vimeo.com/{video}"})


class MatchTest(unittest.TestCase):
    def test_youtube(self):
        cases = {
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ": "dQw4w9WgXcQ",
            "http://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10": "dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ": "dQw4w9WgXcQ",
            "http://www.youtube.com/watch_popup?v=1_kwxzU4wL4&vq=medium": "1_kwxzU4wL4",
            "https://www.youtube.com/embed/dQw4w9WgXcQ?start=3": "dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ": "dQw4w9WgXcQ",
            "https://www.youtube.com/v/dQw4w9WgXcQ": "dQw4w9WgXcQ",
            "https://www.youtube.com/live/sq8GBPUb3rk": "sq8GBPUb3rk",
            "https://youtu.be/nt00QzKuNVY": "nt00QzKuNVY",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ": "dQw4w9WgXcQ",
        }
        for url, video in cases.items():
            self.assertEqual(youtube.match(url), {"video_id": video}, url)
        for url in (
            "https://www.youtube.com/playlist?list=PLwtfwT1GnUQRaLki",
            "http://www.youtube.com/view_play_list?p=D19BCF9D57320E03",
            "http://www.youtube.com/ninjaunboxing2",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/watch",
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
            "http://[::1/a",
        ):
            self.assertIsNone(youtube.match(url), url)

    def test_vimeo(self):
        for url, video in {
            "http://vimeo.com/31009503": "31009503",
            "https://vimeo.com/134002940/": "134002940",
            "http://www.vimeo.com/m/108650530": "108650530",
            "http://vimeo.com/album/3137515/video/114017635": "114017635",
            "https://vimeo.com/channels/staffpicks/76979871": "76979871",
            "https://player.vimeo.com/video/76979871": "76979871",
        }.items():
            self.assertEqual(vimeo.match(url), {"video_id": video}, url)
        for url in ("http://www.Vimeo.com/blog:268", "http://vimeo.com/m/#/17419652", "https://vimeo.com/about"):
            self.assertIsNone(vimeo.match(url), url)

    def test_github(self):
        self.assertEqual(github.match("https://github.com/simonw/datasette"), {"owner": "simonw", "repo": "datasette"})
        self.assertEqual(github.match("https://github.com/jcf/git-tmbundle#readme"), {"owner": "jcf", "repo": "git-tmbundle"})
        self.assertEqual(github.match("https://github.com/a/b.git/"), {"owner": "a", "repo": "b"})
        self.assertEqual(
            github.match("https://gist.github.com/swalkinshaw/3a33e2d292b60e68fcebe12b62bbb3e2"),
            {"gist": "3a33e2d292b60e68fcebe12b62bbb3e2"},
        )
        for url in (
            "https://github.com/blog/2325-powerful-new-features",
            "https://github.com/features/actions",
            "https://github.com/ten",
            "https://github.com/arielf/weight-loss/blob/master/README.md",
            "https://github.com/klbostee/dumbo/wiki",
            "https://github.com/fish-shell/fish-shell/releases/tag/3.0.0",
            "https://gist.github.com/swalkinshaw",
            "https://api.github.com/repos/a/b",
        ):
            self.assertIsNone(github.match(url), url)

    def test_wikipedia(self):
        self.assertEqual(
            wikipedia.match("http://en.wikipedia.org/wiki/Fitts%27s_law"), {"lang": "en", "title": "Fitts's_law"}
        )
        self.assertEqual(
            wikipedia.match("https://en.wikipedia.org/wiki/Apache_Camel?wprov=sfti1"), {"lang": "en", "title": "Apache_Camel"}
        )
        self.assertEqual(wikipedia.match("https://de.m.wikipedia.org/wiki/Kubb#Regeln"), {"lang": "de", "title": "Kubb"})
        self.assertEqual(wikipedia.match("https://zh-yue.wikipedia.org/wiki/X")["lang"], "zh-yue")
        for url in (
            "http://nostalgia.wikipedia.org/wiki/HomePage",
            "http://test2.wikipedia.org/wiki/Wikipedia:Guide",
            "https://en.wikipedia.org/w/index.php?title=X",
            "https://en.wikipedia.org/wiki/",
            "https://en.wikipedia.org.evil.example/wiki/X",
        ):
            self.assertIsNone(wikipedia.match(url), url)

    def test_openlibrary(self):
        for url, isbn in {
            "http://www.amazon.com/Zen-Art-Motorcycle-Maintenance-Inquiry/dp/0060589469": "0060589469",
            "https://www.amazon.com/dp/080442957X/ref=sr_1_1": "080442957X",
            "https://smile.amazon.com/gp/product/0985567600?tag=x": "0985567600",
            "https://www.amazon.co.uk/exec/obidos/ASIN/1592407609/": "1592407609",
        }.items():
            self.assertEqual(openlibrary.match(url), {"isbn": isbn}, url)
        for url in (
            "https://www.amazon.com/dp/B09VPKZR3G",
            "http://www.amazon.com/Rebuilding-Blocks-Game-Kubb-Together-ebook/dp/B00QMD1HPQ/ref=tmm",
            "https://aws.amazon.com/dp/0060589469",
            "http://www.amazon.com/gp/feature.html/?docId=1000476231",
            "https://www.amazon.jobs/principles",
        ):
            self.assertIsNone(openlibrary.match(url), url)

    def test_at_most_one_adapter_applies(self):
        urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "http://vimeo.com/31009503", "https://github.com/a/b",
            "https://en.wikipedia.org/wiki/Kubb", "https://www.amazon.com/dp/0060589469",
        ]
        for url in urls:
            self.assertEqual(sum(1 for a in adapters.ADAPTERS if a.match(url)), 1, url)
        self.assertIsNone(adapters.for_link({"url": "https://example.com/"}))


class Harness:
    """A Context over a fake transport and a temporary media directory."""

    def __init__(self, script, token=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.media = Path(self.tmp.name) / "media"
        self.clock = FakeClock()
        self.transport = FakeTransport(script)
        self.web = web.Client(transport=self.transport, resolve=public_resolver(), sleep=self.clock.sleep, clock=self.clock)
        self.ctx = Context(self.web, self.media, github_token=token)

    def close(self):
        self.tmp.cleanup()


class AdapterTest(unittest.TestCase):
    def harness(self, script, token=None):
        h = Harness(script, token)
        self.addCleanup(h.close)
        return h

    def test_youtube_happy_path_and_the_image(self):
        h = self.harness({
            yt_oembed("dQw4w9WgXcQ"): json_answer({"title": "Never  Gonna", "author_name": "Rick Astley",
                                                   "author_url": "https://www.youtube.com/@RickAstley",
                                                   "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
                                                   "html": "<iframe></iframe>"}),
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg": (200, {"Content-Type": "image/jpeg"}, JPEG),
        })
        fields = youtube.fetch({"url": "http://youtu.be/dQw4w9WgXcQ"}, h.ctx)
        self.assertEqual(fields, {"video_id": "dQw4w9WgXcQ", "provider": "youtube", "title": "Never Gonna",
                                  "author": "Rick Astley", "author_url": "https://www.youtube.com/@RickAstley",
                                  "image": "/media/youtube/dQw4w9WgXcQ.jpg"})
        self.assertEqual((h.media / "youtube" / "dQw4w9WgXcQ.jpg").read_bytes(), JPEG)
        # The same video again: the oEmbed answer is cached and the file is not fetched twice.
        youtube.fetch({"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}, h.ctx)
        self.assertEqual(len(h.transport.calls), 2)
        self.assertEqual(h.transport.calls[0][1]["User-Agent"], web.USER_AGENT)
        self.assertEqual(h.transport.calls[0][2], 15)

    def test_an_existing_image_is_never_overwritten_or_fetched(self):
        h = self.harness({"https://i.ytimg.com/x.jpg": (200, {"Content-Type": "image/jpeg"}, JPEG)})
        (h.media / "youtube").mkdir(parents=True)
        (h.media / "youtube" / "abc.jpg").write_bytes(b"\xff\xd8\xffold")
        self.assertEqual(save_image(h.ctx, "https://i.ytimg.com/x.jpg", "youtube", "abc"), "/media/youtube/abc.jpg")
        self.assertEqual((h.media / "youtube" / "abc.jpg").read_bytes(), b"\xff\xd8\xffold")
        self.assertEqual(h.transport.calls, [])

    def test_a_missing_or_non_image_answer_records_no_image(self):
        h = self.harness({
            "https://img.example/html": (200, {"Content-Type": "text/html"}, b"<html>"),
            "https://img.example/png": (200, {"Content-Type": "image/png"}, PNG),
            "https://img.example/gone": (404, {}),
            "https://img.example/huge": (200, {"Content-Type": "image/jpeg"}, JPEG + b"\x00" * (1024 * 1024)),
        })
        for name in ("html", "png", "gone", "huge"):
            self.assertIsNone(save_image(h.ctx, f"https://img.example/{name}", "youtube", name), name)
        self.assertIsNone(save_image(h.ctx, None, "youtube", "none"))
        self.assertIsNone(save_image(h.ctx, "javascript:alert(1)", "youtube", "js"))
        self.assertFalse((h.media / "youtube").exists())
        with self.assertRaises(ValueError):
            save_image(h.ctx, "https://img.example/x", "youtube", "../escape")

    def test_youtube_error_path(self):
        h = self.harness({yt_oembed("dQw4w9WgXcQ"): (403, {"Content-Type": "application/json"})})
        with self.assertRaises(AdapterError) as caught:
            youtube.fetch({"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}, h.ctx)
        self.assertEqual((str(caught.exception), caught.exception.transient), ("HTTP 403", False))

    def test_a_timeout_is_transient(self):
        h = self.harness({vimeo_oembed("31009503"): TimeoutError("timed out")})
        with self.assertRaises(AdapterError) as caught:
            vimeo.fetch({"url": "https://vimeo.com/31009503"}, h.ctx)
        self.assertEqual((str(caught.exception), caught.exception.transient), ("timeout", True))

    def test_vimeo_happy_path(self):
        h = self.harness({
            vimeo_oembed("31009503"): json_answer({"title": "Republic, Lost", "author_name": "lessig",
                                                   "author_url": "https://vimeo.com/lessig",
                                                   "thumbnail_url": "https://i.vimeocdn.com/video/1_295x166"}),
            "https://i.vimeocdn.com/video/1_295x166": (200, {"Content-Type": "image/jpeg"}, JPEG),
        })
        fields = vimeo.fetch({"url": "http://vimeo.com/31009503"}, h.ctx)
        self.assertEqual(fields["image"], "/media/vimeo/31009503.jpg")
        self.assertEqual((fields["provider"], fields["title"], fields["author"]), ("vimeo", "Republic, Lost", "lessig"))
        self.assertTrue((h.media / "vimeo" / "31009503.jpg").exists())

    def test_github_repository_with_the_token(self):
        h = self.harness({
            "https://api.github.com/repos/simonw/datasette": json_answer({
                "full_name": "simonw/datasette", "description": "An open source multi-tool", "language": "Python",
                "stargazers_count": 10500, "license": {"spdx_id": "Apache-2.0"}, "archived": False,
                "pushed_at": "2026-10-20T01:02:03Z", "homepage": "https://datasette.io", "fork": False,
                "owner": {"login": "simonw"}, "topics": ["sqlite"],
            }),
        }, token="test-token-value")
        fields = github.fetch({"url": "https://github.com/simonw/datasette/"}, h.ctx)
        self.assertEqual(list(fields), list(github.REPO_FIELDS))
        self.assertEqual(fields, {"full_name": "simonw/datasette", "description": "An open source multi-tool",
                                  "language": "Python", "stars": 10500, "license": "Apache-2.0", "archived": False,
                                  "pushed": "2026-10-20T01:02:03Z", "homepage": "https://datasette.io", "fork": False})
        headers = h.transport.calls[0][1]
        self.assertEqual(headers["Authorization"], "Bearer test-token-value")
        self.assertEqual(headers["Accept"], "application/vnd.github+json")

    def test_the_token_never_leaves_api_github_com(self):
        h = self.harness({
            "https://api.github.com/repos/old/name": (301, {"Location": "https://api.github.com/repositories/42"}),
            "https://api.github.com/repositories/42": (302, {"Location": "https://elsewhere.example/r/42"}),
            "https://elsewhere.example/r/42": json_answer({"full_name": "new/name"}),
        }, token="test-token-value")
        github.fetch({"url": "https://github.com/old/name"}, h.ctx)
        sent = {urlsplit(url).hostname: headers.get("Authorization") for url, headers, _ in h.transport.calls}
        self.assertEqual(sent, {"api.github.com": "Bearer test-token-value", "elsewhere.example": None})

    def test_github_gist(self):
        gist = "3a33e2d292b60e68fcebe12b62bbb3e2"
        h = self.harness({
            f"https://api.github.com/gists/{gist}": json_answer({
                "description": "Notes", "files": {"a.md": {"language": "Markdown", "content": "a body"},
                                                   "b.py": {"language": "Python", "content": "print()"}},
            }),
        })
        fields = github.fetch({"url": f"https://gist.github.com/swalkinshaw/{gist}"}, h.ctx)
        self.assertEqual(fields, {"full_name": f"gist/{gist}", "description": "Notes", "files": ["a.md", "b.py"],
                                  "language": "Markdown"})
        self.assertNotIn("Authorization", h.transport.calls[0][1])  # no token, no header

    def test_wikipedia_never_keeps_the_extract_or_the_thumbnail(self):
        api = "https://en.wikipedia.org/api/rest_v1/page/summary/Fitts%27s_law"
        h = self.harness({api: json_answer({
            "title": "Fitts's law", "description": "Model of human movement", "lang": "en",
            "extract": "Fitts's law is a predictive model...", "thumbnail": {"source": "https://upload.wikimedia.org/x.png"},
            "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Fitts%27s_law"}},
        })})
        fields = wikipedia.fetch({"url": "http://en.wikipedia.org/wiki/Fitts%27s_law"}, h.ctx)
        self.assertEqual(fields, {"title": "Fitts's law", "description": "Model of human movement", "lang": "en",
                                  "url": "https://en.wikipedia.org/wiki/Fitts%27s_law"})
        self.assertNotIn("predictive", json.dumps(fields))

    def test_wikipedia_titles_with_a_slash_are_escaped(self):
        api = "https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC"
        h = self.harness({api: json_answer({"title": "AC/DC", "content_urls": {}})})
        fields = wikipedia.fetch({"url": "https://en.wikipedia.org/wiki/AC/DC"}, h.ctx)
        self.assertEqual((fields["title"], fields["description"], fields["url"]), ("AC/DC", None, None))

    def test_openlibrary_follows_the_isbn_redirect_works_and_authors(self):
        h = self.harness({
            "https://openlibrary.org/isbn/0060589469.json": (302, {"Location": "/books/OL1M.json"}),
            "https://openlibrary.org/books/OL1M.json": json_answer({
                "title": "Zen and the Art of Motorcycle Maintenance", "publish_date": "April 25, 2006",
                "works": [{"key": "/works/OL2W"}], "covers": [-1, 12345],
            }),
            "https://openlibrary.org/works/OL2W.json": json_answer({"authors": [{"author": {"key": "/authors/OL3A"}}]}),
            "https://openlibrary.org/authors/OL3A.json": json_answer({"name": "Robert M. Pirsig"}),
            "https://covers.openlibrary.org/b/id/12345-M.jpg": (302, {"Location": "https://archive.org/c/12345-M.jpg"}),
            "https://archive.org/c/12345-M.jpg": (200, {"Content-Type": "image/jpeg"}, JPEG),
        })
        fields = openlibrary.fetch({"url": "http://www.amazon.com/Zen/dp/0060589469"}, h.ctx)
        self.assertEqual(fields, {"isbn": "0060589469", "title": "Zen and the Art of Motorcycle Maintenance",
                                  "authors": ["Robert M. Pirsig"], "published": "April 25, 2006",
                                  "image": "/media/books/0060589469.jpg",
                                  "openlibrary_url": "https://openlibrary.org/isbn/0060589469"})
        self.assertEqual((h.media / "books" / "0060589469.jpg").read_bytes(), JPEG)

    def test_openlibrary_404_is_an_error_not_a_crash(self):
        h = self.harness({"https://openlibrary.org/isbn/0985567600.json": (404, {"Content-Type": "application/json"})})
        with self.assertRaises(AdapterError) as caught:
            openlibrary.fetch({"url": "https://www.amazon.com/dp/0985567600"}, h.ctx)
        self.assertEqual(str(caught.exception), "HTTP 404")


LINKS = {
    "2007": [
        record("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "2007-01-01T00:00:00Z"),
        record("http://vimeo.com/31009503", "2007-02-01T00:00:00Z"),
        record("https://example.com/plain", "2007-03-01T00:00:00Z"),
    ],
    "2015": [
        record("https://github.com/simonw/datasette", "2015-01-01T00:00:00Z"),
        record("https://github.com/gone/away", "2015-02-01T00:00:00Z"),
        record("https://youtu.be/dQw4w9WgXcQ", "2015-03-01T00:00:00Z"),
    ],
}
VIDEO, VIMEO, PLAIN = (link["id"] for link in LINKS["2007"])
REPO, GONE, VIDEO_AGAIN = (link["id"] for link in LINKS["2015"])

SCRIPT = {
    yt_oembed("dQw4w9WgXcQ"): json_answer({"title": "Never Gonna", "author_name": "Rick Astley",
                                           "author_url": "https://www.youtube.com/@RickAstley",
                                           "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"}),
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg": (200, {"Content-Type": "image/jpeg"}, JPEG),
    vimeo_oembed("31009503"): (404, {"Content-Type": "application/json"}),
    "https://api.github.com/repos/simonw/datasette": json_answer({"full_name": "simonw/datasette", "stargazers_count": 3}),
    "https://api.github.com/repos/gone/away": (404, {"Content-Type": "application/json"}),
}


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        for year, links in LINKS.items():
            jsonio.write_json(self.data / "links" / f"{year}.json", links)
        self.media = self.root / "public" / "media"
        self.clock = Clock()

    def tearDown(self):
        self.tmp.cleanup()

    def run_facts(self, *argv, script=None, environ=None):
        fake = FakeClock()
        transport = FakeTransport(script or SCRIPT)
        client = web.Client(transport=transport, resolve=public_resolver(), sleep=fake.sleep, clock=fake)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = enrich_facts.main(["--data", str(self.data), *argv], web_client=client, now=self.clock,
                                     environ=environ or {})
        return code, out.getvalue(), transport

    def shard(self, year):
        return jsonio.load(self.data / "enrichment" / "facts" / f"{year}.json")

    def test_records_by_year_saved_and_errors_with_no_other_fields(self):
        code, out, _ = self.run_facts()
        self.assertEqual(code, 0, out)
        y2007 = self.shard("2007")
        self.assertEqual(sorted(y2007), sorted([VIDEO, VIMEO]))  # the plain link has no adapter
        self.assertEqual(y2007[VIDEO], {"checked": "2026-10-24T02:00:00Z", "method": "youtube", "version": 1,
                                        "kind": "video", "video_id": "dQw4w9WgXcQ", "provider": "youtube",
                                        "title": "Never Gonna", "author": "Rick Astley",
                                        "author_url": "https://www.youtube.com/@RickAstley",
                                        "image": "/media/youtube/dQw4w9WgXcQ.jpg"})
        self.assertEqual(y2007[VIMEO], {"checked": "2026-10-24T02:00:00Z", "method": "vimeo", "version": 1,
                                        "kind": "video", "error": "HTTP 404"})
        y2015 = self.shard("2015")
        self.assertEqual(y2015[REPO]["kind"], "repository")
        self.assertEqual(y2015[GONE]["error"], "HTTP 404")
        self.assertEqual(y2015[VIDEO_AGAIN]["image"], "/media/youtube/dQw4w9WgXcQ.jpg")
        self.assertEqual(sorted(p.name for p in (self.media / "youtube").iterdir()), ["dQw4w9WgXcQ.jpg"])
        last = out.strip().splitlines()[-1]
        self.assertTrue(last.startswith("enrich_facts: done: asked about 5 link(s) (youtube 2 ok, 0 error; "
                                        "vimeo 0 ok, 1 error; github 1 ok, 1 error)"), last)
        self.assertIn("images 1 saved, 1 already there, 0 removed", last)

    def test_dry_run_touches_nothing(self):
        code, out, transport = self.run_facts("--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(transport.calls, [])
        self.assertFalse((self.data / "enrichment").exists())
        self.assertFalse(self.media.exists())
        self.assertIn(f"would ask youtube about {VIDEO} 2007 (unobserved)", out)
        self.assertIn("would ask about 5 of 5 applying links (youtube 2, vimeo 1, github 2, wikipedia 0, openlibrary 0)", out)

    def test_a_second_run_asks_nothing_until_due(self):
        self.run_facts()
        before = snapshot(self.root)
        code, out, transport = self.run_facts()
        self.assertEqual((code, transport.calls), (0, []))
        self.assertEqual(snapshot(self.root), before)
        self.clock.now += timedelta(days=31)  # errors come back after a month
        code, out, _ = self.run_facts("--dry-run")
        self.assertIn(f"would ask vimeo about {VIMEO} 2007 (error, checked 2026-10-24T02:00:00Z)", out)
        self.assertNotIn(f"about {VIDEO} ", out)
        self.clock.now += timedelta(days=60)  # facts after a quarter
        code, out, _ = self.run_facts("--dry-run")
        self.assertIn(f"would ask youtube about {VIDEO} 2007 (facts, checked 2026-10-24T02:00:00Z)", out)

    def test_a_transient_failure_keeps_the_earlier_facts(self):
        self.run_facts()
        self.clock.now += timedelta(days=100)
        script = dict(SCRIPT, **{"https://api.github.com/repos/simonw/datasette": (503, {})})
        code, out, _ = self.run_facts("--only-method", "github", script=script)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.shard("2015")[REPO]["full_name"], "simonw/datasette")
        self.assertIn("kept the earlier facts (HTTP 503)", out)

    def test_a_rate_limit_stops_github_and_says_so(self):
        limited = (403, {"Content-Type": "application/json", "x-ratelimit-remaining": "0"})
        script = dict(SCRIPT, **{"https://api.github.com/repos/simonw/datasette": limited})
        code, out, transport = self.run_facts(script=script)
        self.assertEqual(code, 1)
        last = out.strip().splitlines()[-1]
        self.assertIn("STOPPED github: GitHub rate limit reached without a token (set GITHUB_TOKEN)", last)
        self.assertIn("github 0 ok, 0 error, 2 not asked", last)
        self.assertNotIn(REPO, self.shard("2015"))  # nothing recorded for a rate limit
        hosts = [urlsplit(url).hostname for url, _, _ in transport.calls]
        self.assertEqual(hosts.count("api.github.com"), 1)  # stopped at the first 403
        self.assertIn(VIDEO, self.shard("2007"))  # the other methods carried on

    def test_the_token_comes_from_the_environment_and_is_never_printed(self):
        code, out, transport = self.run_facts("--only-method", "github", environ={"GITHUB_TOKEN": "secret-token-123"})
        self.assertEqual(code, 0, out)
        self.assertEqual(transport.calls[0][1]["Authorization"], "Bearer secret-token-123")
        self.assertNotIn("secret-token-123", out)
        for path in (self.data / "enrichment").rglob("*.json"):
            self.assertNotIn("secret-token-123", path.read_text())

    def test_a_link_made_private_loses_its_record_and_its_image(self):
        self.run_facts()
        self.assertTrue((self.media / "youtube" / "dQw4w9WgXcQ.jpg").exists())
        jsonio.write_json(self.data / "links" / "2007.json", [LINKS["2007"][1], LINKS["2007"][2]])
        jsonio.write_json(self.data / "links" / "2015.json", LINKS["2015"][:2])
        code, out, transport = self.run_facts("--limit", "0")
        self.assertEqual(transport.calls, [])
        self.assertNotIn(VIDEO, self.shard("2007"))
        self.assertFalse((self.media / "youtube" / "dQw4w9WgXcQ.jpg").exists())
        self.assertIn("1 removed", out.strip().splitlines()[-1])

    def test_ids_and_methods_are_checked(self):
        code, out, _ = self.run_facts("--ids", PLAIN)
        self.assertEqual(code, 1)
        self.assertIn("no adapter applies to", out)
        code, out, transport = self.run_facts("--ids", VIDEO, "--dry-run")
        self.assertIn(f"would ask youtube about {VIDEO} 2007 (named)", out)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            enrich_facts.parse_args(["--only-method", "myspace"])

    def test_due_rules(self):
        now = START
        fresh = {"checked": "2026-10-20T00:00:00Z", "method": "youtube", "version": 1, "kind": "video"}
        self.assertIsNone(fx.due(fresh, youtube, now))
        self.assertEqual(fx.due(None, youtube, now), "unobserved")
        self.assertEqual(fx.due(dict(fresh, method="vimeo"), youtube, now), "method vimeo, now youtube")
        self.assertEqual(fx.due(dict(fresh, version=0), youtube, now), "version 0, now 1")
        self.assertIsNone(fx.due(fresh, youtube, now, recheck_after=10))
        self.assertTrue(fx.due(fresh, youtube, now, recheck_after=1))


if __name__ == "__main__":
    unittest.main()
