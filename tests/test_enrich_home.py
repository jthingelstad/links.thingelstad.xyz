"""The home object: open-web signals parsed from a host's home page with
html.parser, tolerant of broken HTML, with nothing of the body kept. No network.

Run: python3 -I -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import home  # noqa: E402

CHECKED = "2026-10-24T02:00:00Z"


def ok(final_url="https://example.com/", content_type="text/html"):
    return {"status": 200, "alive": True, "final_url": final_url, "redirects": [], "content_type": content_type}


def observe(body, *, headers=None, result=None):
    if isinstance(body, str):
        body = body.encode("utf-8")
    return home.observe(CHECKED, result or ok(), body, headers or {"content-type": "text/html; charset=utf-8"})


class SignalsTest(unittest.TestCase):
    def test_a_full_indieweb_home_page(self):
        page = """<!DOCTYPE html>
        <html><head>
          <title>  Example &amp; Friends
          </title>
          <meta name="Generator" content="Hugo 0.140">
          <link rel="alternate" type="application/rss+xml" title="RSS" href="/index.xml">
          <link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
          <link rel="alternate" type="application/feed+json" title="JSON Feed" href="feed.json">
          <link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/2">
          <link rel="alternate" hreflang="de" href="/de/">
          <link rel="me" href="https://github.com/example">
          <link rel="webmention" href="/webmention">
        </head><body>
          <header class="site h-card p-author"><a class="u-url" rel="me noopener" href="https://mastodon.example/@e">e</a></header>
          <a rel="me" href="mailto:e@example.com">mail</a>
          <a rel="me" href="https://github.com/example">again</a>
        </body></html>"""
        self.assertEqual(
            observe(page),
            {
                "checked": CHECKED,
                "title": "Example & Friends",
                "generator": "Hugo 0.140",
                "feeds": [
                    {"type": "rss", "url": "https://example.com/index.xml", "title": "RSS"},
                    {"type": "atom", "url": "https://example.com/atom.xml", "title": None},
                    {"type": "json", "url": "https://example.com/feed.json", "title": "JSON Feed"},
                ],
                "hcard": True,
                "rel_me": ["https://github.com/example", "https://mastodon.example/@e"],
                "webmention": "https://example.com/webmention",
            },
        )

    def test_a_plain_page_has_empty_signals_and_no_error(self):
        record = observe("<html><head><title>Hi</title></head><body><p class='card'>x</p></body></html>")
        self.assertEqual(record, {**home.empty(CHECKED), "title": "Hi"})
        self.assertNotIn("error", record)

    def test_broken_html_still_parses(self):
        page = '<p><b>Unclosed<title>Broken</title><link rel=alternate type="application/rss+xml" href=/rss><div class="h-card"><a rel=me href=https://x.example/>me'
        record = observe(page)
        self.assertEqual(record["title"], "Broken")
        self.assertEqual(record["feeds"], [{"type": "rss", "url": "https://example.com/rss", "title": None}])
        self.assertTrue(record["hcard"])
        self.assertEqual(record["rel_me"], ["https://x.example/"])

    def test_an_unclosed_title_is_cut(self):
        record = observe("<html><title>" + "word " * 500)
        self.assertLessEqual(len(record["title"]), home.MAX_TEXT)
        self.assertTrue(record["title"].startswith("word word"))

    def test_an_svg_title_is_not_the_page_title(self):
        record = observe("<html><body><svg><title>icon</title></svg><title>Real</title></body></html>")
        self.assertEqual(record["title"], "Real")

    def test_relative_urls_follow_the_final_url_and_base(self):
        record = observe(
            '<link rel="alternate" type="application/rss+xml" href="feed">',
            result=ok("https://www.example.com/blog/"),
        )
        self.assertEqual(record["feeds"][0]["url"], "https://www.example.com/blog/feed")
        record = observe('<base href="https://cdn.example.net/site/"><link rel="alternate" type="application/atom+xml" href="a.xml">')
        self.assertEqual(record["feeds"][0]["url"], "https://cdn.example.net/site/a.xml")

    def test_an_empty_webmention_href_is_the_page_itself(self):
        self.assertEqual(observe('<link rel="webmention" href="">')["webmention"], "https://example.com/")

    def test_the_link_header_webmention_wins(self):
        headers = {
            "content-type": "text/html",
            "link": '<https://example.com/wp-json/>; rel="https://api.w.org/", </wm>; rel="webmention"',
        }
        record = observe('<link rel="webmention" href="/other">', headers=headers)
        self.assertEqual(record["webmention"], "https://example.com/wm")

    def test_link_header_parsing(self):
        base = "https://example.com/"
        self.assertEqual(home.link_header_webmention('<https://wm.example/e>; rel=webmention', base), "https://wm.example/e")
        self.assertEqual(home.link_header_webmention('<https://wm.example/e>; rel="me webmention"', base), "https://wm.example/e")
        self.assertIsNone(home.link_header_webmention('<https://example.com/feed>; rel="alternate"', base))
        self.assertIsNone(home.link_header_webmention(None, base))

    def test_credential_values_are_blanked_in_recorded_urls(self):
        record = observe('<link rel="alternate" type="application/rss+xml" href="/feed?token=abc123">')
        self.assertEqual(record["feeds"][0]["url"], "https://example.com/feed?token=REDACTED")

    def test_caps_keep_records_small(self):
        links = "".join(f'<a rel="me" href="https://p{n}.example/">p</a>' for n in range(80))
        feeds = "".join(f'<link rel="alternate" type="application/rss+xml" href="/f{n}">' for n in range(40))
        record = observe(feeds + links + '<a rel="me" href="https://x.example/' + "a" * 3000 + '">long</a>')
        self.assertEqual(len(record["rel_me"]), home.MAX_REL_ME)
        self.assertEqual(len(record["feeds"]), home.MAX_FEEDS)
        record = observe('<meta name="generator" content="' + "g" * 1000 + '">')
        self.assertEqual(len(record["generator"]), home.MAX_TEXT)


class CharsetTest(unittest.TestCase):
    def test_header_then_meta_then_utf8(self):
        latin = "<title>Café</title>".encode("latin-1")
        self.assertEqual(observe(latin, headers={"content-type": "text/html; charset=ISO-8859-1"})["title"], "Café")
        meta = b'<meta charset="iso-8859-1"><title>Caf\xe9</title>'
        self.assertEqual(observe(meta, headers={"content-type": "text/html"})["title"], "Café")
        self.assertEqual(observe("<title>Café</title>", headers={"content-type": "text/html"})["title"], "Café")

    def test_an_unknown_charset_falls_back_to_utf8(self):
        record = observe("<title>Ok</title>", headers={"content-type": "text/html; charset=x-nonsense"})
        self.assertEqual(record["title"], "Ok")


class NotReadTest(unittest.TestCase):
    def test_an_error_response_is_recorded_with_the_reason(self):
        result = {"status": 403, "alive": False, "final_url": "https://example.com/", "redirects": [],
                  "content_type": "text/html", "error": "HTTP 403 (Cloudflare challenge)"}
        record = home.observe(CHECKED, result, b"", {"cf-mitigated": "challenge"})
        self.assertEqual(record, home.empty(CHECKED, "HTTP 403 (Cloudflare challenge)"))
        self.assertEqual(list(record)[-1], "error")

    def test_a_page_that_is_not_html(self):
        record = observe(b'{"a": 1}', result=ok(content_type="application/json"), headers={"content-type": "application/json"})
        self.assertEqual(record["error"], "not HTML (application/json)")

    def test_an_empty_body(self):
        self.assertEqual(observe(b"")["error"], "empty body")

    def test_the_webmention_header_is_kept_when_the_body_is_not_read(self):
        record = observe(b"", headers={"link": "<https://wm.example/>; rel=webmention"})
        self.assertEqual((record["error"], record["webmention"]), ("empty body", "https://wm.example/"))


if __name__ == "__main__":
    unittest.main()
