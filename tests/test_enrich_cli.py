"""enrich_hosts.py and enrich_pages.py end to end on a temporary data
directory, with fake DNS, HTTP and RDAP. No network.

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
from urllib.parse import urlsplit

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))

import enrich_hosts  # noqa: E402
import enrich_pages  # noqa: E402
from linking import dns, jsonio, web  # noqa: E402
from linking import wayback as wb  # noqa: E402
from linking.urls import md5_hex  # noqa: E402
from test_enrich_dns import APEX, NXDOMAIN  # noqa: E402
from test_enrich_web import FakeClock, FakeTransport, public_resolver  # noqa: E402

START = datetime(2026, 10, 24, 2, 0, 0, tzinfo=timezone.utc)


def record(url, saved):
    digest = md5_hex(url)
    return {"id": digest[:12], "hash": digest, "url": url, "title": "t", "note": "", "saved": saved,
            "tags": [], "toread": False, "meta": md5_hex("m" + url)}


LINKS = {
    "2005": [record("http://macstories.net/a", "2005-03-01T00:00:00Z"), record("http://gone.example/old", "2005-04-01T00:00:00Z")],
    "2026": [record("https://www.macstories.net/b", "2026-10-01T00:00:00Z")],
}
ALIVE, DEAD, NEW = (LINKS["2005"][0]["id"], LINKS["2005"][1]["id"], LINKS["2026"][0]["id"])


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        for year, links in LINKS.items():
            jsonio.write_json(self.data / "links" / f"{year}.json", links)
        (self.data / "derived").mkdir()
        (self.data / "derived" / "issues.json").write_text("{}\n")
        self.before = snapshot(self.data)
        self.clock = Clock()

    def tearDown(self):
        self.tmp.cleanup()

    def assertOnlyEnrichmentChanged(self):
        after = snapshot(self.data)
        for name, data in self.before.items():
            self.assertEqual(after.get(name), data, name)
        for name in set(after) - set(self.before):
            self.assertTrue(name.startswith("enrichment/"), name)

    def quiet(self, function, argv, **deps):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = function(argv, **deps)
        return code, out.getvalue()


class FakeResolver:
    def __init__(self):
        self.lookups = []

    def lookup(self, host):
        self.lookups.append(host)
        return dns.parse_dig(APEX if host == "macstories.net" else NXDOMAIN, host)


class FakeRdap:
    queries = 0

    def __init__(self):
        self.hosts = []

    def lookup(self, host):
        self.hosts.append(host)
        self.queries += 1
        if host == "macstories.net":
            return {"domain": "macstories.net", "registrar": "Example Registrar", "registered": "2009-03-01",
                    "expires": "2027-03-01", "status": ["client transfer prohibited"], "nameservers": ["ns1.example.net"]}, None
        return None, "not found at rdap.example"


def host_web():
    clock = FakeClock()
    transport = FakeTransport(
        {
            "https://macstories.net/": (200, {"Content-Type": "text/html"}, b"<html>"),
            "http://macstories.net/": (301, {"Location": "https://macstories.net/"}),
        }
    )
    return web.Client(transport=transport, resolve=public_resolver(), sleep=clock.sleep, clock=clock), transport


class HostsTest(Base):
    def run_hosts(self, *argv, resolver=None, rdap_client=None, web_client=None):
        resolver = resolver or FakeResolver()
        rdap_client = rdap_client or FakeRdap()
        web_client = web_client or host_web()[0]
        code, out = self.quiet(
            enrich_hosts.main, ["--data", str(self.data), *argv],
            resolver=resolver, web_client=web_client, rdap_client=rdap_client, now=self.clock,
        )
        return code, out, resolver, rdap_client

    def test_writes_the_contract_record(self):
        code, out, _, _ = self.run_hosts("--rdap-min-links", "2")
        self.assertEqual(code, 0, out)
        shard = jsonio.load(self.data / "enrichment" / "hosts" / "m.json")
        self.assertEqual(
            shard,
            {
                "macstories.net": {
                    "checked": "2026-10-24T02:00:00Z",
                    "method": "enrich_hosts",
                    "version": 1,
                    "dns": {"resolves": True, "a": ["9.9.9.9", "45.55.54.134", "104.16.9.10"], "aaaa": [], "cname": None,
                            "ns": ["raquel.ns.cloudflare.com", "rustam.ns.cloudflare.com"], "mx": True},
                    "https": {"reachable": True, "redirects_http": True, "status": 200},
                    "rdap": {"domain": "macstories.net", "registrar": "Example Registrar", "registered": "2009-03-01",
                             "expires": "2027-03-01", "status": ["client transfer prohibited"],
                             "nameservers": ["ns1.example.net"], "checked": "2026-10-24T02:00:00Z"},
                }
            },
        )
        gone = jsonio.load(self.data / "enrichment" / "hosts" / "g.json")["gone.example"]
        self.assertEqual(gone["dns"]["error"], "NXDOMAIN")
        self.assertEqual(gone["https"], {"reachable": False, "redirects_http": False, "status": None, "error": "does not resolve"})
        self.assertNotIn("rdap", gone)  # one link: below the RDAP threshold, so not observed
        self.assertTrue(out.strip().splitlines()[-1].startswith("enrich_hosts: done: checked 2 host(s), 1 alive"))
        self.assertOnlyEnrichmentChanged()

    def test_dry_run_touches_nothing(self):
        resolver, rdap_client = FakeResolver(), FakeRdap()
        web_client, transport = host_web()
        code, out, _, _ = self.run_hosts("--dry-run", resolver=resolver, rdap_client=rdap_client, web_client=web_client)
        self.assertEqual(code, 0)
        self.assertIn("would check macstories.net (2 links; unobserved)", out)
        self.assertEqual((resolver.lookups, rdap_client.hosts, transport.calls), ([], [], []))
        self.assertEqual(snapshot(self.data), self.before)

    def test_a_second_run_checks_nothing_until_due(self):
        self.run_hosts("--rdap-min-links", "1")
        first = snapshot(self.data)
        code, out, resolver, _ = self.run_hosts("--rdap-min-links", "1")
        self.assertEqual((code, resolver.lookups), (0, []))
        self.assertEqual(snapshot(self.data), first)
        self.clock.now += timedelta(days=31)
        code, out, resolver, rdap_client = self.run_hosts("--rdap-min-links", "1")
        self.assertEqual(sorted(resolver.lookups), ["gone.example", "macstories.net"])
        # macstories.net's RDAP answer is a month old: kept, not asked again.
        self.assertEqual(rdap_client.hosts, ["gone.example"])
        kept = jsonio.load(self.data / "enrichment" / "hosts" / "m.json")["macstories.net"]
        self.assertEqual(kept["rdap"]["checked"], "2026-10-24T02:00:00Z")
        self.assertEqual(kept["checked"], "2026-11-24T02:00:00Z")

    def test_rdap_none_records_the_reason(self):
        self.run_hosts("--rdap-min-links", "1")
        gone = jsonio.load(self.data / "enrichment" / "hosts" / "g.json")["gone.example"]
        self.assertIsNone(gone["rdap"])
        self.assertEqual(gone["rdap_error"], "not found at rdap.example")

    def test_only_and_unknown_hosts(self):
        code, out, resolver, _ = self.run_hosts("--only", "macstories.net")
        self.assertEqual((code, resolver.lookups), (0, ["macstories.net"]))
        code, out, _, _ = self.run_hosts("--only", "nowhere.example")
        self.assertEqual(code, 1)
        self.assertIn("not a host of any public link", out)

    def test_a_host_no_longer_linked_is_dropped(self):
        jsonio.write_json(self.data / "enrichment" / "hosts" / "p.json", {"private.example": {"checked": "2026-01-01T00:00:00Z"}})
        self.run_hosts("--limit", "0")
        self.assertFalse((self.data / "enrichment" / "hosts" / "p.json").exists())


def page_web(extra=None):
    clock = FakeClock()
    script = {
        "http://macstories.net/a": (301, {"Location": "https://www.macstories.net/a"}),
        "https://www.macstories.net/a": (200, {"Content-Type": "text/html; charset=utf-8"}, b"<html>" * 100),
        "https://www.macstories.net/b": (200, {"Content-Type": "text/html"}, b"<html>"),
        wb.cdx_url("http://macstories.net/a", wb.ROW_LIMIT): (200, {}, b'[["timestamp"],["20050302000000"],["20261001000000"]]'),
        wb.cdx_url("https://www.macstories.net/b", wb.ROW_LIMIT): (200, {}, b"[]"),
        wb.cdx_url("http://gone.example/old", wb.ROW_LIMIT): (200, {}, b'[["timestamp"],["20050401000000"]]'),
    }
    script.update(extra or {})
    transport = FakeTransport(script)
    resolver = public_resolver({"gone.example": None})
    return web.Client(transport=transport, resolve=resolver, sleep=clock.sleep, clock=clock), transport


class PagesTest(Base):
    def run_pages(self, *argv, web_client=None):
        web_client = web_client or page_web()[0]
        return self.quiet(enrich_pages.main, ["--data", str(self.data), *argv], web_client=web_client, now=self.clock)

    def test_liveness_records_by_year_saved(self):
        code, out = self.run_pages("--no-wayback")
        self.assertEqual(code, 0, out)
        y2005 = jsonio.load(self.data / "enrichment" / "pages" / "2005.json")
        self.assertEqual(list(y2005), sorted([ALIVE, DEAD]))
        self.assertEqual(
            y2005[ALIVE],
            {"checked": "2026-10-24T02:00:00Z", "method": "enrich_pages", "version": 1, "status": 200, "alive": True,
             "final_url": "https://www.macstories.net/a", "redirects": [{"status": 301, "url": "https://www.macstories.net/a"}],
             "content_type": "text/html"},
        )
        self.assertEqual(
            y2005[DEAD],
            {"checked": "2026-10-24T02:00:00Z", "method": "enrich_pages", "version": 1, "status": None, "alive": False,
             "final_url": "http://gone.example/old", "redirects": [], "content_type": None, "error": "dns: name does not resolve"},
        )
        self.assertIn(NEW, jsonio.load(self.data / "enrichment" / "pages" / "2026.json"))
        self.assertIn("checked 3 link(s), 2 alive, 1 dead; wayback skipped", out.strip().splitlines()[-1])
        self.assertOnlyEnrichmentChanged()
        text = (self.data / "enrichment" / "pages" / "2005.json").read_text()
        self.assertNotIn("<html>", text)  # bodies are never stored

    def test_wayback_only_adds_to_the_liveness_record(self):
        self.run_pages("--no-wayback")
        self.clock.now += timedelta(minutes=5)
        code, out = self.run_pages("--wayback-only", "--ids", ALIVE)
        self.assertEqual(code, 0, out)
        self.assertIn("liveness skipped (1 link(s) selected); wayback 1 looked up, 1 with captures", out)
        page = jsonio.load(self.data / "enrichment" / "pages" / "2005.json")[ALIVE]
        self.assertEqual(page["checked"], "2026-10-24T02:00:00Z")  # liveness untouched
        self.assertEqual(
            page["wayback"],
            {"first": "2005-03-02T00:00:00Z", "last": "2026-10-01T00:00:00Z", "count": 2, "checked": "2026-10-24T02:05:00Z"},
        )
        self.assertEqual(list(page)[-1], "wayback")
        # A later liveness check keeps the Wayback answer.
        self.clock.now += timedelta(days=100)
        self.run_pages("--no-wayback", "--ids", ALIVE)
        page = jsonio.load(self.data / "enrichment" / "pages" / "2005.json")[ALIVE]
        self.assertEqual(page["checked"], "2027-02-01T02:05:00Z")
        self.assertEqual(page["wayback"]["count"], 2)

    def test_liveness_and_wayback_together(self):
        code, out = self.run_pages()
        self.assertEqual(code, 0, out)
        y2026 = jsonio.load(self.data / "enrichment" / "pages" / "2026.json")[NEW]
        self.assertEqual(y2026["wayback"], {"first": None, "last": None, "count": 0, "checked": "2026-10-24T02:00:00Z"})

    def test_a_blocked_archive_stops_wayback_for_the_run(self):
        blocked = {wb.cdx_url("http://macstories.net/a", wb.ROW_LIMIT): (429, {})}
        web_client, transport = page_web(blocked)
        code, out = self.run_pages(web_client=web_client)
        self.assertEqual(code, 1)
        self.assertIn("STOPPED", out.strip().splitlines()[-1])
        cdx_calls = [url for url, _, _ in transport.calls if urlsplit(url).hostname == "web.archive.org"]
        self.assertEqual(len(cdx_calls), 2)  # the request and its one retry, then no more
        # Liveness carried on for every link and was written.
        self.assertEqual(len(jsonio.load(self.data / "enrichment" / "pages" / "2005.json")), 2)

    def test_nothing_due_means_nothing_rewritten(self):
        self.run_pages("--no-wayback")
        first = snapshot(self.data)
        code, out = self.run_pages("--no-wayback")
        self.assertIn("checked 0 link(s)", out)
        self.assertEqual(snapshot(self.data), first)

    def test_dead_pages_come_back_after_a_month_and_live_ones_after_a_quarter(self):
        self.run_pages("--no-wayback")
        self.clock.now += timedelta(days=31)
        code, out = self.run_pages("--no-wayback", "--dry-run")
        self.assertIn(f"would observe {DEAD}", out)
        self.assertNotIn(f"would observe {ALIVE}", out)
        self.clock.now += timedelta(days=60)
        code, out = self.run_pages("--no-wayback", "--dry-run")
        self.assertIn(f"would observe {ALIVE}", out)

    def test_dry_run_touches_nothing(self):
        web_client, transport = page_web()
        code, out = self.run_pages("--sample", "2", "--dry-run", web_client=web_client)
        self.assertEqual(code, 0)
        self.assertEqual(transport.calls, [])
        self.assertEqual(snapshot(self.data), self.before)
        self.assertIn("would observe liveness and Wayback of 2 of 3 links", out)

    def test_bad_ids_are_refused(self):
        code, out = self.run_pages("--ids", "0123456789ab")
        self.assertEqual(code, 1)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            enrich_pages.parse_args(["--ids", "not-an-id"])

    def test_a_link_made_private_loses_its_record(self):
        jsonio.write_json(
            self.data / "enrichment" / "pages" / "2005.json",
            {"ffffffffffff": {"checked": "2026-01-01T00:00:00Z", "final_url": "https://private.example/"}},
        )
        self.run_pages("--no-wayback", "--limit", "0")
        self.assertNotIn("private.example", (self.data / "enrichment" / "pages" / "2005.json").read_text()
                         if (self.data / "enrichment" / "pages" / "2005.json").exists() else "")

    def test_the_records_validate_as_json_with_no_credentials(self):
        self.run_pages()
        for path in (self.data / "enrichment").rglob("*.json"):
            json.loads(path.read_text())


if __name__ == "__main__":
    unittest.main()
