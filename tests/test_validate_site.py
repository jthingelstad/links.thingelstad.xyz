"""The built-site validator's microformats rule (tools/validate-site.py,
check_microformats), its llms.txt shape rule (llms_shape_problems) and its
check of the sky's two files, /sky/places.json and /sky/stars.json
(check_sky). Run:
python3 -m unittest discover -s tests -v

The rules are checked here on small pages and files, so each way they fail
stays pinned; npm run validate:site runs them on every built page and on the
built llms.txt."""

import importlib.util
import json
import tempfile
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


class Sky(unittest.TestCase):
    """The sky's two files against the links: two stars, one site, one topic.
    RECORD was saved 2026-10-25 02:37 UTC, still the 24th in Central. The
    places file holds the keys lib/sky.ts's PLACE_KEYS names; both hold the
    layout."""

    PLACES = {"layout", "day", "note", "topic", "meaning", "time", "topics", "families"}

    LINKS = [{"id": RECORD, "saved": SAVED[RECORD]}, {"id": OTHER, "saved": SAVED[OTHER]}]

    def stars(self, names_change=None, **change):
        names_change = names_change or {}
        day = 20750  # 2026-10-24
        sky = {
            "layout": 1,
            "ids": [RECORD, OTHER],
            "titles": ["One", "Two"],
            "hosts": ["example.com"],
            "host": [0, 0],
            "kind": [4, 7],
            "day": [day, day],
            "note": [1, 0],
            "topic": [0, 0],
            "meaning": [0, 0, 0, 1, 1, 1],
            "time": [0, 0, 1, 1],
            "neighbors": [[1], [0]],
            "issues": {"0": [350]},
            "topics": [{"name": "Things", "size": 2}],
            "families": [],
        }
        sky.update(change)
        places = {k: v for k, v in sky.items() if k in self.PLACES}
        names = {k: v for k, v in sky.items() if k not in self.PLACES or k == "layout"}
        names.update(names_change)
        with tempfile.TemporaryDirectory() as dist:
            (Path(dist) / "sky").mkdir()
            (Path(dist) / "sky/places.json").write_text(json.dumps(places))
            (Path(dist) / "sky/stars.json").write_text(json.dumps(names))
            before = validate_site.DIST
            validate_site.DIST = Path(dist)
            try:
                problems = []
                ids = validate_site.check_sky(self.LINKS, problems)
            finally:
                validate_site.DIST = before
        return ids, problems

    def test_stars_that_agree_pass_and_name_the_fragments(self):
        self.assertEqual(self.stars(), ({RECORD: [OTHER], OTHER: [RECORD]}, []))

    def test_a_link_without_a_star_yet_passes(self):
        ids, problems = self.stars(
            ids=[RECORD], titles=["One"], host=[0], kind=[4], day=[20750], note=[1], topic=[0],
            meaning=[0, 0, 0], time=[0, 0], neighbors=[[]], topics=[{"name": "Things", "size": 1}],
        )
        self.assertEqual((ids, problems), ({RECORD: []}, []))

    def test_a_star_that_is_no_record_fails(self):
        self.assertIn("no record", self.stars(ids=[RECORD, "ffffffffffff"])[1][0])

    def test_a_short_list_fails(self):
        self.assertIn("time holds 2, not 4", self.stars(time=[0, 0])[1][0])

    def test_a_neighbour_out_of_range_or_itself_fails(self):
        self.assertIn("neighbours", self.stars(neighbors=[[2], [0]])[1][0])
        self.assertIn("neighbours", self.stars(neighbors=[[0], [0]])[1][0])

    def test_a_utc_day_in_place_of_the_central_day_fails(self):
        self.assertIn("Central day", self.stars(day=[20751, 20750])[1][0])

    def test_topic_sizes_must_add_up(self):
        self.assertIn("sizes", self.stars(topics=[{"name": "Things", "size": 3}])[1][0])

    def test_files_of_different_layouts_fail(self):
        self.assertIn("different layouts", self.stars({"layout": 2})[1][0])

    def test_a_kind_short_or_out_of_range_fails(self):
        self.assertIn("kind holds 1, not 2", self.stars(kind=[4])[1][0])
        self.assertIn("kind out of range", self.stars(kind=[4, 8])[1][0])


class Nearest(unittest.TestCase):
    """A record page's "Nearest in meaning": its star's first five neighbours."""

    @staticmethod
    def page(ids):
        rows = "".join(f'<li><a class="title" href="/links/{i}/">x</a></li>' for i in ids)
        return (
            '<section class="section meaning"><h2>Nearest in meaning</h2>'
            f'<ul class="link-list compact">{rows}</ul>'
            '<p class="more"><a href="/sky/#aaaaaaaaaaaa">All 10 in the sky</a></p>'
            '</section><section class="section"><a href="/links/ffffffffffff/">y</a></section>'
        )

    def check(self, listed, near):
        problems = []
        validate_site.check_nearest({RECORD: listed}, {RECORD: near}, problems)
        return problems

    def test_reads_only_its_own_section(self):
        ids = [f"{n:012x}" for n in range(7)]
        self.assertEqual(validate_site.nearest_listed(self.page(ids[:5])), ids[:5])
        self.assertEqual(validate_site.nearest_listed("<main></main>"), [])

    def test_the_first_five_in_order_pass(self):
        near = [f"{n:012x}" for n in range(10)]
        self.assertEqual(self.check(near[:5], near), [])
        self.assertEqual(self.check(near[:2], near[:2]), [])

    def test_out_of_order_or_short_fails(self):
        near = [f"{n:012x}" for n in range(10)]
        self.assertIn("not its star's first 5", self.check(near[1:6], near)[0])
        self.assertIn("lists 4", self.check(near[:4], near)[0])

    def test_a_link_without_a_star_lists_none(self):
        self.assertEqual(self.check([], []), [])
        self.assertIn("first 0", self.check([OTHER], [])[0])


if __name__ == "__main__":
    unittest.main()
