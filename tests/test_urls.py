"""URL normalisation and ids (docs/DATA.md). Run: python3 -m unittest discover -s tests -v"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking.urls import link_id, md5_hex, normalise  # noqa: E402


class IdTest(unittest.TestCase):
    def test_id_is_md5_of_the_url_as_saved(self):
        # Pinned from Pinboard's own hash for two saved links.
        self.assertEqual(md5_hex("http://wheregoes.com/"), "5029bebcaf782f5be4b9672df8c34745")
        self.assertEqual(link_id("http://wheregoes.com/"), "5029bebcaf78")
        self.assertEqual(link_id("https://wheregoes.com/"), "6d35b392e063")

    def test_id_uses_utf8_bytes(self):
        self.assertEqual(md5_hex("https://example.com/€"), "84e2d55cc4cb4a9de62dc5eed4c98d35")

    def test_id_is_never_normalised(self):
        self.assertNotEqual(link_id("http://wheregoes.com/"), link_id("https://wheregoes.com/"))
        self.assertEqual(normalise("http://wheregoes.com/"), normalise("https://wheregoes.com/"))


class NormaliseTest(unittest.TestCase):
    def assertNorm(self, url, expected):
        self.assertEqual(normalise(url), expected, url)

    def test_host_lower_cased_and_one_leading_www_dropped(self):
        self.assertNorm("https://WWW.Example.COM/Path", "example.com/Path")
        self.assertNorm("https://www.www.example.com/", "www.example.com/")
        self.assertNorm("https://www2.example.com/", "www2.example.com/")
        self.assertNorm("https://blog.www.example.com/", "blog.www.example.com/")

    def test_path_case_is_kept(self):
        self.assertNorm("https://example.com/A/b", "example.com/A/b")

    def test_scheme_dropped(self):
        self.assertEqual(normalise("http://example.com/a"), normalise("https://example.com/a"))
        self.assertNorm("HTTPS://example.com/a", "example.com/a")
        self.assertNorm("//example.com/a", "example.com/a")

    def test_trailing_slashes_dropped_and_empty_path_is_root(self):
        self.assertNorm("https://example.com/a/", "example.com/a")
        self.assertNorm("https://lookbusy.app//", "lookbusy.app/")
        self.assertNorm("https://example.com/a//", "example.com/a")
        self.assertNorm("https://example.com", "example.com/")
        self.assertNorm("https://example.com/", "example.com/")
        self.assertNorm("https://example.com?q=1", "example.com/?q=1")

    def test_tracking_parameters_dropped_rest_kept_in_order(self):
        self.assertNorm(
            "https://example.com/a?z=1&utm_source=x&b=2&utm_medium=y&ref=hn&a=3",
            "example.com/a?z=1&b=2&a=3",
        )
        for name in ("ref", "source", "mc_cid", "mc_eid", "fbclid", "gclid", "utm_campaign", "utm_"):
            self.assertNorm(f"https://example.com/?{name}=v", "example.com/")
        # A bare name counts too; a longer name that merely starts alike does not.
        self.assertNorm("https://example.com/?ref", "example.com/")
        self.assertNorm("https://example.com/?references=1&sources=2", "example.com/?references=1&sources=2")
        # Names are matched exactly as written: upper case is not a tracking name.
        self.assertNorm("https://example.com/?UTM_source=x&Ref=y", "example.com/?UTM_source=x&Ref=y")
        self.assertNorm("https://www.tldraw.com/?ref=DenseDiscovery-376", "tldraw.com/")

    def test_query_values_kept_as_written(self):
        self.assertNorm("https://example.com/?q=a%20b&r=c+d", "example.com/?q=a%20b&r=c+d")
        self.assertNorm("https://example.com/?b=2&a=1", "example.com/?b=2&a=1")

    def test_empty_parameters_and_bare_question_mark_dropped(self):
        self.assertNorm("https://example.com/a?", "example.com/a")
        self.assertNorm("https://example.com/a?x=1&&y=2&", "example.com/a?x=1&y=2")
        self.assertNorm("https://example.com/a?utm_source=x", "example.com/a")

    def test_fragment_dropped(self):
        self.assertNorm("https://example.com/a#section", "example.com/a")
        self.assertNorm("https://example.com/a/#", "example.com/a")
        self.assertNorm("https://example.com/a?x=1#y?z=2", "example.com/a?x=1")

    def test_path_percent_decoded(self):
        self.assertNorm("https://example.com/caf%C3%A9", "example.com/café")
        self.assertEqual(normalise("https://example.com/café"), normalise("https://example.com/caf%C3%A9"))
        self.assertNorm("https://example.com/a%20b", "example.com/a b")
        # An encoded slash decodes, and as a trailing slash it then drops.
        self.assertNorm("https://example.com/a%2Fb%2F", "example.com/a/b")
        # Invalid escapes stay; an invalid UTF-8 sequence becomes U+FFFD.
        self.assertNorm("https://example.com/%ZZ", "example.com/%ZZ")
        self.assertNorm("https://example.com/%C3", "example.com/\ufffd")
        # Plus is not a space in a path.
        self.assertNorm("https://example.com/a+b", "example.com/a+b")

    def test_whitespace_and_control_characters(self):
        self.assertNorm("  https://example.com/a  ", "example.com/a")
        self.assertNorm("https://exa\tmple.com/a\n", "example.com/a")

    def test_port_and_userinfo_kept(self):
        self.assertNorm("https://www.example.com:8080/a", "example.com:8080/a")
        self.assertNorm("https://User@www.Example.com/a", "user@www.example.com/a")

    def test_unparseable_url_only_matches_itself(self):
        self.assertNorm(" http://[::1/a ", "http://[::1/a")

    def test_without_scheme_or_host(self):
        self.assertNorm("example.com/a/", "example.com/a")
        self.assertNorm("mailto:jamie@example.com", "jamie@example.com")


if __name__ == "__main__":
    unittest.main()
