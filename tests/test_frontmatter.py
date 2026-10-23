"""The stdlib YAML front matter reader. Run: python3 -m unittest discover -s tests -v"""

import sys
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking.frontmatter import FrontMatterError, parse, parse_front_matter, split_front_matter  # noqa: E402

BS = "\\"  # one backslash, so YAML escapes in these fixtures stay escapes


def yaml(text):
    return parse(textwrap.dedent(text).lstrip("\n"))


ISSUE = textwrap.dedent(
    """\
    ---
    layout: layouts/issue.njk
    number: 140-special
    subject: 'Special Thing #140 / Matching Donations to Second Harvest!'
    publish_date: '2020-03-23T23:00:00Z'
    slug: special-thing-140-matching-donations-to-second
    description: ''
    domains:
    - www.2harvest.org
    links:
    - text: '''Ladies'' Is Gender Neutral – Alice Goldfuss'
      url: http://blog.alicegoldfuss.com/ladies-is-gender-neutral/
      domain: blog.alicegoldfuss.com
      heading_context: null
      section: Links 📌
    - text: "Daring Fireball: I’ll Wait"
      url: "https://daringfireball.net/2026/10/wait#more"
      heading_context: "[He said \\"wait\\"](https://daringfireball.net/)"
      section: ~
    word_count: 333
    permalink: /archive/140-special/
    tags: issue
    ---
    Body text with --- inside it.

    ---
    """
)


class IssueFrontMatterTest(unittest.TestCase):
    def setUp(self):
        self.meta = parse_front_matter(ISSUE)

    def test_scalars_are_strings_and_numbers_are_not_resolved(self):
        self.assertEqual(self.meta["number"], "140-special")
        self.assertEqual(self.meta["word_count"], "333")
        self.assertEqual(self.meta["description"], "")
        self.assertEqual(self.meta["publish_date"], "2020-03-23T23:00:00Z")

    def test_single_quotes_with_doubled_quote_escapes(self):
        self.assertEqual(self.meta["subject"], "Special Thing #140 / Matching Donations to Second Harvest!")
        self.assertEqual(self.meta["links"][0]["text"], "'Ladies' Is Gender Neutral – Alice Goldfuss")

    def test_double_quotes_with_escaped_quotes(self):
        link = self.meta["links"][1]
        self.assertEqual(link["text"], "Daring Fireball: I’ll Wait")
        self.assertEqual(link["url"], "https://daringfireball.net/2026/10/wait#more")
        self.assertEqual(link["heading_context"], '[He said "wait"](https://daringfireball.net/)')

    def test_null_and_tilde_are_none(self):
        self.assertIsNone(self.meta["links"][0]["heading_context"])
        self.assertIsNone(self.meta["links"][1]["section"])

    def test_sequence_at_the_same_indent_as_its_key(self):
        self.assertEqual(self.meta["domains"], ["www.2harvest.org"])
        self.assertEqual(len(self.meta["links"]), 2)
        self.assertEqual(self.meta["links"][0]["section"], "Links 📌")
        self.assertEqual(self.meta["permalink"], "/archive/140-special/")

    def test_front_matter_ends_at_the_first_closing_line(self):
        self.assertNotIn("Body text", str(self.meta))


class ScalarTest(unittest.TestCase):
    def test_plain_scalars_keep_inner_quotes_colons_and_hashes(self):
        meta = yaml(
            """
            subject: Weekly Thing 297 / People, Building, "Pure Blogger"
            url: https://example.com/a?b=c#frag
            title: It's 9:30 now
            """
        )
        self.assertEqual(meta["subject"], 'Weekly Thing 297 / People, Building, "Pure Blogger"')
        self.assertEqual(meta["url"], "https://example.com/a?b=c#frag")
        self.assertEqual(meta["title"], "It's 9:30 now")

    def test_comments(self):
        meta = yaml(
            """
            # a full-line comment
            a: value # a trailing comment
            b: 'quoted # not a comment' # but this is
            c: # nothing
            d: x#y
            """
        )
        self.assertEqual(meta, {"a": "value", "b": "quoted # not a comment", "c": None, "d": "x#y"})

    def test_empty_strings_and_nulls(self):
        meta = yaml(
            """
            a: ''
            b: ""
            c:
            d: null
            e: NULL
            f: 'null'
            g: "~"
            """
        )
        self.assertEqual(meta, {"a": "", "b": "", "c": None, "d": None, "e": None, "f": "null", "g": "~"})

    def test_double_quoted_escapes(self):
        text = (
            f'a: "x{BS}ty {BS}"q{BS}" {BS}{BS} {BS}/ {BS}x41"\n'
            f'b: "{BS}u20AC {BS}U0001F600 {BS}N{BS}_{BS}0"\n'
            f'c: "line one{BS}nline two"\n'
        )
        meta = parse(text)
        self.assertEqual(meta["a"], 'x\ty "q" \\ / A')
        self.assertEqual(meta["b"], "€ \U0001f600 \x85\xa0\x00")
        self.assertEqual(meta["c"], "line one\nline two")

    def test_bad_escapes_are_refused(self):
        with self.assertRaises(FrontMatterError):
            parse(f'a: "{BS}q"\n')
        with self.assertRaises(FrontMatterError):
            parse(f'a: "{BS}u20"\n')

    def test_multi_line_plain_scalar_folds(self):
        meta = yaml(
            """
            description: one
              two
              three

              four
            next: x
            """
        )
        self.assertEqual(meta, {"description": "one two three\nfour", "next": "x"})

    def test_multi_line_quoted_scalars_fold(self):
        meta = parse(
            "a: 'it''s long\n  and folded'\n"
            'b: "first\n  second\n\n  third"\n'
            f'c: "joined{BS}\n  directly"\n'
            "d: x\n"
        )
        self.assertEqual(meta, {"a": "it's long and folded", "b": "first second\nthird", "c": "joineddirectly", "d": "x"})

    def test_block_scalars(self):
        meta = yaml(
            """
            literal: |
              line one
                indented
              line three
            stripped: |-
              no newline
            kept: |+
              kept

            folded: >
              folded
              text

              new paragraph
            folded_strip: >-
              a
              b
            explicit: |2
                two extra
            after: done
            """
        )
        self.assertEqual(meta["literal"], "line one\n  indented\nline three\n")
        self.assertEqual(meta["stripped"], "no newline")
        self.assertEqual(meta["kept"], "kept\n\n")
        self.assertEqual(meta["folded"], "folded text\nnew paragraph\n")
        self.assertEqual(meta["folded_strip"], "a b")
        self.assertEqual(meta["explicit"], "  two extra\n")
        self.assertEqual(meta["after"], "done")

    def test_flow_sequences(self):
        meta = yaml(
            """
            links: []
            tags: [a, 'b c', "d", null]
            other: {}
            """
        )
        self.assertEqual(meta, {"links": [], "tags": ["a", "b c", "d", None], "other": {}})


class StructureTest(unittest.TestCase):
    def test_indented_sequences_and_nesting(self):
        meta = yaml(
            """
            links:
              - text: a
                url: https://a.example/
                extra:
                  - x
                  - y
              - text: b
            audio_chapters:
            - start: 0
              title: "Welcome"
            -
              start: 5
            - - nested
              - list
            """
        )
        self.assertEqual(
            meta["links"],
            [{"text": "a", "url": "https://a.example/", "extra": ["x", "y"]}, {"text": "b"}],
        )
        self.assertEqual(meta["audio_chapters"], [{"start": "0", "title": "Welcome"}, {"start": "5"}, ["nested", "list"]])

    def test_nested_mapping(self):
        meta = yaml(
            """
            outer:
              inner: 1
              deeper:
                key: value
            top: 2
            """
        )
        self.assertEqual(meta, {"outer": {"inner": "1", "deeper": {"key": "value"}}, "top": "2"})

    def test_quoted_keys(self):
        self.assertEqual(yaml("""\n'a key': 1\n"b: key": 2\n"""), {"a key": "1", "b: key": "2"})

    def test_document_end_marker_stops_parsing(self):
        self.assertEqual(parse("a: |+\n  x\n\n...\n"), {"a": "x\n\n"})


class RefusalTest(unittest.TestCase):
    def assertRefused(self, text, fragment):
        with self.assertRaises(FrontMatterError) as caught:
            parse(text)
        self.assertIn(fragment, str(caught.exception))

    def test_anchors_aliases_and_tags(self):
        self.assertRefused("a: &x 1\n", "anchor")
        self.assertRefused("a: *x\n", "anchor")
        self.assertRefused("a: !!str 1\n", "anchor")

    def test_duplicate_keys(self):
        self.assertRefused("a: 1\nb: 2\na: 3\n", "duplicate key 'a'")

    def test_tabs_in_indentation(self):
        self.assertRefused("a:\n\t- 1\n", "tab")

    def test_unterminated_quotes(self):
        self.assertRefused("a: 'never closed\n", "unterminated")
        self.assertRefused('a: "never closed\n', "unterminated")

    def test_text_after_a_quoted_scalar(self):
        self.assertRefused("a: 'x' y\n", "after a quoted scalar")

    def test_flow_mappings_and_nested_flow(self):
        self.assertRefused("a: {b: 1}\n", "flow mappings")
        self.assertRefused("a: [[1]]\n", "nested flow")

    def test_errors_name_the_line(self):
        self.assertRefused("a: 1\nb: 2\nc: 'x\n", "line 3")

    def test_bad_indentation(self):
        self.assertRefused("a: 1\n  b: 2\n", "line 2")


class SplitTest(unittest.TestCase):
    def test_bom_and_crlf(self):
        meta = parse_front_matter("\ufeff---\r\nnumber: 5\r\nslug: '5'\r\n---\r\nbody\r\n")
        self.assertEqual(meta, {"number": "5", "slug": "5"})

    def test_missing_front_matter(self):
        with self.assertRaises(FrontMatterError):
            split_front_matter("no front matter here\n")

    def test_unclosed_front_matter(self):
        with self.assertRaises(FrontMatterError):
            split_front_matter("---\na: 1\n")

    def test_empty_front_matter(self):
        self.assertEqual(parse_front_matter("---\n---\nbody\n"), {})

    def test_line_numbers_count_from_the_file(self):
        with self.assertRaises(FrontMatterError) as caught:
            parse_front_matter("---\na: 1\nb: 'x\n---\n")
        self.assertIn("line 3", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
