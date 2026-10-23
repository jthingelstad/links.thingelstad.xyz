"""The Wayback CDX parser and lookup, with no network.

Run: python3 -I -m unittest discover -s tests -v
"""

import json
import sys
import unittest
import urllib.error
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import wayback as wb  # noqa: E402
from linking import web  # noqa: E402
from test_enrich_web import FakeClock, FakeTransport, public_resolver  # noqa: E402

URL = "https://www.amitgawande.com/blog/2026/the-fuzzy-mind/?a=1&b=2"


def rows(*stamps, extra=False):
    header = ["timestamp", "statuscode"] if extra else ["timestamp"]
    body = [header] + [[stamp, "200"] if extra else [stamp] for stamp in stamps]
    return json.dumps(body).encode()


def web_client(script):
    clock = FakeClock()
    transport = FakeTransport(script)
    return web.Client(transport=transport, resolve=public_resolver(), sleep=clock.sleep, clock=clock), transport, clock


class ParseTest(unittest.TestCase):
    def test_no_captures(self):
        self.assertEqual(wb.parse_cdx(b""), [])
        self.assertEqual(wb.parse_cdx(b"[]\n"), [])
        self.assertEqual(wb.parse_cdx(b'[["timestamp"]]'), [])

    def test_rows_in_order(self):
        self.assertEqual(wb.parse_cdx(rows("20090101000000", "20261001000000")), ["20090101000000", "20261001000000"])

    def test_the_timestamp_column_is_found_by_name(self):
        body = json.dumps([["original", "timestamp"], ["http://a/", "20100203040506"]]).encode()
        self.assertEqual(wb.parse_cdx(body), ["20100203040506"])

    def test_malformed_rows_are_skipped(self):
        body = json.dumps([["timestamp"], ["2009"], ["20090101000000"], "junk", []]).encode()
        self.assertEqual(wb.parse_cdx(body), ["20090101000000"])

    def test_not_cdx_json(self):
        for body in (b'{"error": "x"}', b'[["original"], ["x"]]', b"<html>"):
            with self.assertRaises(ValueError, msg=body):
                wb.parse_cdx(body)

    def test_iso(self):
        self.assertEqual(wb.iso("20260701101112"), "2026-07-01T10:11:12Z")


class QueryTest(unittest.TestCase):
    def test_the_url_is_encoded_and_the_fields_trimmed(self):
        query = parse_qs(urlsplit(wb.cdx_url(URL, wb.ROW_LIMIT)).query)
        self.assertEqual(query["url"], [URL])
        self.assertEqual(query["output"], ["json"])
        self.assertEqual(query["fl"], ["timestamp"])
        self.assertEqual(query["limit"], [str(wb.ROW_LIMIT)])
        self.assertTrue(wb.cdx_url(URL, -1).endswith("&limit=-1"))
        self.assertTrue(wb.cdx_url(URL, 1).startswith("https://web.archive.org/cdx/search/cdx?url=https%3A%2F%2F"))


class ObserveTest(unittest.TestCase):
    def test_first_last_and_count_from_one_request(self):
        client, transport, _ = web_client(
            {wb.cdx_url(URL, wb.ROW_LIMIT): (200, {}, rows("20260701101112", "20260801000000", "20261001000000"))}
        )
        self.assertEqual(
            wb.observe(client, URL),
            {"first": "2026-07-01T10:11:12Z", "last": "2026-10-01T00:00:00Z", "count": 3},
        )
        self.assertEqual(len(transport.calls), 1)

    def test_never_archived(self):
        client, _, _ = web_client({wb.cdx_url(URL, wb.ROW_LIMIT): (200, {}, b"[]")})
        self.assertEqual(wb.observe(client, URL), {"first": None, "last": None, "count": 0})

    def test_a_busy_page_asks_again_for_the_latest(self):
        many = [f"2010{n:010d}" for n in range(wb.ROW_LIMIT)]
        client, transport, clock = web_client(
            {
                wb.cdx_url(URL, wb.ROW_LIMIT): (200, {}, rows(*many)),
                wb.cdx_url(URL, -1): (200, {}, rows("20261022000000")),
            }
        )
        record = wb.observe(client, URL)
        self.assertEqual(record["count"], wb.ROW_LIMIT)
        self.assertTrue(record["count_capped"])
        self.assertEqual(record["last"], "2026-10-22T00:00:00Z")
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(clock.sleeps, [6.0])  # the six-second pace between the two

    def test_a_429_after_the_retry_means_stop(self):
        client, transport, clock = web_client({wb.cdx_url(URL, wb.ROW_LIMIT): (429, {})})
        with self.assertRaises(wb.Blocked):
            wb.observe(client, URL)
        self.assertEqual(len(transport.calls), 2)
        self.assertIn(60.0, clock.sleeps)  # the archive's retry waits a minute

    def test_a_refused_connection_means_stop(self):
        refused = urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))
        client, _, _ = web_client({wb.cdx_url(URL, wb.ROW_LIMIT): refused})
        with self.assertRaises(wb.Blocked):
            wb.observe(client, URL)

    def test_other_failures_skip_this_link_only(self):
        client, _, _ = web_client({wb.cdx_url(URL, wb.ROW_LIMIT): (502, {})})
        with self.assertRaises(wb.LookupFailed):
            wb.observe(client, URL)
        client, _, _ = web_client({wb.cdx_url(URL, wb.ROW_LIMIT): (200, {}, b"<html>busy</html>")})
        with self.assertRaises(wb.LookupFailed):
            wb.observe(client, URL)


if __name__ == "__main__":
    unittest.main()
