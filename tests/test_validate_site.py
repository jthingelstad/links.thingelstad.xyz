"""The built-site validator's microformats rule (tools/validate-site.py,
check_microformats). Run: python3 -m unittest discover -s tests -v

The rule is checked here on small pages, so each way it fails stays pinned;
npm run validate:site runs it on every built page."""

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "validate_site", Path(__file__).resolve().parent.parent / "tools/validate-site.py"
)
validate_site = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validate_site)

SITE = validate_site.SITE
RECORD = "0123456789ab"
OTHER = "abcdefabcdef"
SAVED = {RECORD: "2026-10-25T02:37:37Z", OTHER: "2026-10-24T15:00:00Z"}
FOOTER = (
    '<footer><a class="h-card" href="https://www.thingelstad.com/" rel="me author">'
    '<span class="p-name">Jamie Thingelstad</span>'
    '<data class="u-url" value="https://www.thingelstad.com/"></data></a></footer>'
)


def record_page(u_url=f'<data class="u-url" value="{SITE}/links/{RECORD}/"></data>', row="<li>"):
    return (
        '<main id="main" class="site-main"><article class="record h-entry">'
        '<h1 class="record-title p-name"><a class="u-bookmark-of" href="https://example.com/">A page</a></h1>'
        f'{u_url}<data class="p-host" value="example.com"></data>'
        f'<time class="dt-published" datetime="{SAVED[RECORD]}">Saturday</time>'
        '<ul class="link-list compact">'
        f'{row}<a class="title" href="/links/{OTHER}/">Another</a>'
        '<span class="meta">example.com · Oct 24</span></li></ul>'
        f"</article></main>{FOOTER}"
    )


def row(record, published=None, entry=True):
    """A list row, as LinkList writes it with entries on (or off)."""
    stamp = SAVED[record] if published is None else published
    date = f'<time class="dt-published" datetime="{stamp}">Oct 24</time>' if stamp else "Oct 24"
    li, title = ('<li class="h-entry">', "title p-name u-url") if entry else ("<li>", "title")
    return (
        f'{li}<a class="{title}" href="/links/{record}/">A page</a>'
        f'<span class="meta">example.com · {date}</span></li>'
    )


def list_page(rows, main='<main id="main" class="site-main h-feed">', url="/newest/"):
    feed = (
        '<data class="p-name" value="Newest · Linking Things"></data>'
        f'<data class="u-url" value="{SITE}{url}"></data>'
    )
    return f'{main}<h1 class="page-title">Newest</h1><ul class="link-list">{"".join(rows)}</ul>{feed}</main>{FOOTER}'


def problems(url, html):
    page = validate_site.Page()
    page.feed(html)
    found = []
    validate_site.check_microformats("page.html", url, page, SAVED, found)
    return found


class Records(unittest.TestCase):
    def test_a_record_is_one_h_entry_with_its_permalink(self):
        self.assertEqual(problems(f"/links/{RECORD}/", record_page()), [])

    def test_a_record_without_its_u_url_fails(self):
        # The record before the open-web audit's G14: the u-bookmark-of
        # stops the parser implying one, so the entry had no url.
        self.assertTrue(problems(f"/links/{RECORD}/", record_page(u_url="")))

    def test_a_record_naming_another_u_url_fails(self):
        other = f'<data class="u-url" value="{SITE}/links/{OTHER}/"></data>'
        self.assertTrue(problems(f"/links/{RECORD}/", record_page(u_url=other)))

    def test_entries_inside_the_record_fail(self):
        # LinkList's rows inside the record's own h-entry (entries left on).
        found = problems(f"/links/{RECORD}/", record_page(row='<li class="h-entry">'))
        self.assertIn("page.html: an h-entry inside an h-entry", found)


class Lists(unittest.TestCase):
    def test_a_list_page_is_an_h_feed_of_its_records(self):
        self.assertEqual(problems("/newest/", list_page([row(RECORD), row(OTHER)])), [])

    def test_a_list_page_without_its_h_feed_fails(self):
        # The list pages before G15: plain rows, no feed.
        rows = [row(RECORD, entry=False), row(OTHER, entry=False)]
        self.assertEqual(
            len(problems("/years/2026/", list_page(rows, '<main id="main" class="site-main">', "/years/2026/"))),
            2,
        )

    def test_a_row_without_its_entry_fails(self):
        rows = [row(RECORD), row(OTHER, entry=False)]
        self.assertTrue(problems("/hosts/example.com/", list_page(rows, url="/hosts/example.com/")))

    def test_a_row_without_its_date_or_with_another_fails(self):
        self.assertTrue(problems("/kinds/video/", list_page([row(RECORD, published="")], url="/kinds/video/")))
        wrong = row(RECORD, published=SAVED[OTHER])
        self.assertTrue(problems("/kinds/video/", list_page([wrong], url="/kinds/video/")))

    def test_the_feed_names_its_own_page(self):
        self.assertTrue(problems("/issues/353/", list_page([row(RECORD)], url="/newest/")))


class OtherPages(unittest.TestCase):
    def test_a_page_listing_no_records_carries_neither(self):
        # An issue whose links are none of them saved, and /about/.
        self.assertTrue(problems("/issues/213/", list_page([], url="/issues/213/")))
        self.assertTrue(problems("/about/", list_page([row(RECORD)], url="/about/")))
        plain = f'<main id="main" class="site-main"><h1>About</h1></main>{FOOTER}'
        self.assertEqual(problems("/about/", plain), [])


if __name__ == "__main__":
    unittest.main()
