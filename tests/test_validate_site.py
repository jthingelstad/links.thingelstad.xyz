"""The built-site validator's microformats rule (tools/validate-site.py,
check_microformats) and its llms.txt shape rule (llms_shape_problems). Run:
python3 -m unittest discover -s tests -v

The rules are checked here on small pages and files, so each way they fail
stays pinned; npm run validate:site runs them on every built page and on the
built llms.txt."""

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


# An llms.txt the reference parser reads: prose only above the first section,
# then one `- [name](url): notes` item per line.
LLMS = f"""# Linking Things

> Every public link Jamie Thingelstad has saved since 2005.

Prose is allowed here, above the first section.

## Data

- [Every link]({SITE}/links.json): newest first
- [RSS]({SITE}/feed.xml)

## Every record, by year

- [2026]({SITE}/years/2026/llms.txt): 633 links, 358 KB
"""


def llms_problems(text):
    return validate_site.llms_shape_problems(text)


class LlmsShape(unittest.TestCase):
    def test_the_shape_the_parser_reads_passes(self):
        self.assertEqual(llms_problems(LLMS), [])

    def test_a_line_without_a_link_fails(self):
        # The intro that sat under "Every record, by year" until 2026-10-25:
        # the reference parser stops with an AttributeError on it.
        text = LLMS.replace("## Every record, by year\n", "## Every record, by year\n\nEach file holds a year.\n")
        self.assertEqual(len(llms_problems(text)), 1)

    def test_two_links_on_a_line_fail(self):
        two = f"- [JSON Feed]({SITE}/feed.json) and [RSS]({SITE}/feed.xml): the newest 50"
        self.assertEqual(len(llms_problems(LLMS.replace(f"- [RSS]({SITE}/feed.xml)", two))), 1)
        three = f"- [Kinds]({SITE}/kinds/): [videos]({SITE}/kinds/video/) (352)"
        self.assertEqual(len(llms_problems(LLMS.replace(f"- [RSS]({SITE}/feed.xml)", three))), 1)

    def test_a_name_with_a_bracket_or_a_bad_item_fails(self):
        for line in (
            f"- [The [first] link]({SITE}/links/0123456789ab/)",
            "- [Every link](/links.json): a relative URL",
            f"* [Every link]({SITE}/links.json): another bullet",
            f"- [Every link]({SITE}/links.json) newest first",
            f"- [Every link]({SITE}/links.json):",
        ):
            text = LLMS.replace(f"- [Every link]({SITE}/links.json): newest first", line)
            self.assertEqual(len(llms_problems(text)), 1, line)

    def test_a_deeper_heading_is_a_section_too(self):
        # "###" starts a section for the parser, so prose under it breaks it.
        text = LLMS.replace("## Data\n", "## Data\n\n### Files\n\nThe data files.\n")
        self.assertEqual(len(llms_problems(text)), 1)

    def test_a_heading_above_the_sections_or_a_repeated_section_fails(self):
        self.assertTrue(llms_problems(LLMS.replace("Prose is allowed", "# Prose is allowed")))
        self.assertTrue(llms_problems(LLMS + "\n## Data\n\n- [Hosts](" + SITE + "/hosts.json)\n"))
        self.assertTrue(llms_problems("Linking Things\n\n## Data\n"))


if __name__ == "__main__":
    unittest.main()
