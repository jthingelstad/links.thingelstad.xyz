"""Which hosts and links a run observes: the host rule, the order, the recheck
cadence, the even sample across years. No network.

Run: python3 -I -m unittest discover -s tests -v
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import hosts as hs  # noqa: E402
from linking import pages as pg  # noqa: E402
from linking.urls import link_id  # noqa: E402

NOW = datetime(2026, 10, 23, 12, 0, 0, tzinfo=timezone.utc)


def link(url, saved):
    return {"id": link_id(url), "url": url, "saved": saved}


def days_ago(days):
    return (datetime.fromtimestamp(NOW.timestamp() - days * 86400, timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeStore:
    def __init__(self, records=None):
        self.records = records or {}

    def get(self, key):
        return self.records.get(key)


class HostRuleTest(unittest.TestCase):
    def test_same_rule_as_the_site(self):
        cases = {
            "https://WWW.MacStories.net/x": "macstories.net",
            "http://www.www.example.com/": "www.example.com",
            "https://blog.www.example.com/": "blog.www.example.com",
            "https://user:pw@www.example.com:8080/a": "example.com:8080",
            "  https://example.com  ": "example.com",
            "http://[::1/a": "",
        }
        for url, host in cases.items():
            self.assertEqual(hs.host_of(url), host, url)

    def test_hostname_drops_a_port(self):
        self.assertEqual(hs.hostname("example.com:8080"), "example.com")
        self.assertEqual(hs.hostname("example.com"), "example.com")

    def test_index_counts_and_first_saved(self):
        links = [
            link("https://a.example/2", "2012-01-01T00:00:00Z"),
            link("https://www.a.example/1", "2009-01-01T00:00:00Z"),
            link("https://b.example/", "2010-01-01T00:00:00Z"),
        ]
        self.assertEqual(
            hs.index(links),
            {"a.example": {"count": 2, "first": "2009-01-01T00:00:00Z"}, "b.example": {"count": 1, "first": "2010-01-01T00:00:00Z"}},
        )


HOSTS = {
    "big.example": {"count": 50, "first": "2006-01-01T00:00:00Z"},
    "mid.example": {"count": 20, "first": "2008-01-01T00:00:00Z"},
    "small.example": {"count": 2, "first": "2010-01-01T00:00:00Z"},
    "old.example": {"count": 30, "first": "2005-01-01T00:00:00Z"},
    "older.example": {"count": 3, "first": "2005-01-01T00:00:00Z"},
    "fresh.example": {"count": 40, "first": "2007-01-01T00:00:00Z"},
}
EXISTING = {
    "old.example": {"checked": days_ago(40), "version": hs.VERSION},
    "older.example": {"checked": days_ago(60), "version": hs.VERSION},
    "fresh.example": {"checked": days_ago(2), "version": hs.VERSION},
}


class HostSelectTest(unittest.TestCase):
    def test_unobserved_first_by_links_then_oldest_checked(self):
        chosen = [host for host, _ in hs.select(HOSTS, EXISTING, NOW)]
        self.assertEqual(chosen, ["big.example", "mid.example", "small.example", "older.example", "old.example"])
        self.assertNotIn("fresh.example", chosen)

    def test_min_links_and_limit(self):
        chosen = [host for host, _ in hs.select(HOSTS, EXISTING, NOW, min_links=20, limit=3)]
        self.assertEqual(chosen, ["big.example", "mid.example", "old.example"])

    def test_recheck_after(self):
        chosen = [host for host, _ in hs.select(HOSTS, EXISTING, NOW, recheck_after=1)]
        self.assertIn("fresh.example", chosen)
        chosen = [host for host, _ in hs.select(HOSTS, EXISTING, NOW, recheck_after=50)]
        self.assertNotIn("old.example", chosen)
        self.assertIn("older.example", chosen)

    def test_a_record_at_a_lower_version_is_due(self):
        existing = dict(EXISTING, **{"fresh.example": {"checked": days_ago(2), "version": 1}})
        chosen = hs.select(HOSTS, existing, NOW)
        self.assertEqual(chosen[-1], ("fresh.example", f"version 1, checked {days_ago(2)}"))
        self.assertIn("fresh.example", [host for host, _ in hs.select(HOSTS, {"fresh.example": {"checked": days_ago(2)}}, NOW)])

    def test_only_checks_named_hosts_whatever_their_state(self):
        chosen = hs.select(HOSTS, EXISTING, NOW, only={"fresh.example", "mid.example"})
        self.assertEqual([host for host, _ in chosen], ["mid.example", "fresh.example"])

    def test_rdap_is_asked_for_hosts_with_enough_links_and_no_fresh_answer(self):
        entry = {"count": 10}
        self.assertTrue(hs.wants_rdap(entry, None, NOW, min_links=5, recheck_after=90))
        self.assertFalse(hs.wants_rdap({"count": 4}, None, NOW, min_links=5, recheck_after=90))
        fresh = {"rdap": {"checked": days_ago(10)}}
        stale = {"rdap": {"checked": days_ago(100)}}
        self.assertFalse(hs.wants_rdap(entry, fresh, NOW, min_links=5, recheck_after=90))
        self.assertTrue(hs.wants_rdap(entry, stale, NOW, min_links=5, recheck_after=90))
        self.assertTrue(hs.wants_rdap(entry, {"rdap": None, "rdap_error": "x"}, NOW, min_links=5, recheck_after=90))


def corpus():
    """Ten links a year, 2005 to 2026, two saved a month apart."""
    links = []
    for year in range(2005, 2027):
        for n in range(10):
            links.append(link(f"https://e{n}.example/{year}/{n}", f"{year}-{n + 1:02d}-01T00:00:00Z"))
    return links


class PageSelectTest(unittest.TestCase):
    def test_unobserved_first_in_saved_order_then_due_oldest_first(self):
        a = link("https://a.example/", "2005-01-01T00:00:00Z")
        b = link("https://b.example/", "2006-01-01T00:00:00Z")
        c = link("https://c.example/", "2007-01-01T00:00:00Z")
        d = link("https://d.example/", "2008-01-01T00:00:00Z")
        store = FakeStore(
            {
                a["id"]: {"checked": days_ago(31), "alive": False},  # dead, due monthly
                b["id"]: {"checked": days_ago(45), "alive": True},  # alive, not due until 90
                c["id"]: {"checked": days_ago(100), "alive": True},  # alive, due
            }
        )
        chosen = pg.select([a, b, c, d], store, NOW)
        self.assertEqual([item["id"] for item, _ in chosen], [d["id"], c["id"], a["id"]])
        self.assertEqual(chosen[0][1], "unobserved")

    def test_recheck_after_overrides_the_cadence(self):
        b = link("https://b.example/", "2006-01-01T00:00:00Z")
        store = FakeStore({b["id"]: {"checked": days_ago(45), "alive": True}})
        self.assertEqual(len(pg.select([b], store, NOW, recheck_after=30)), 1)
        self.assertEqual(len(pg.select([b], store, NOW, recheck_after=60)), 0)

    def test_ids_year_and_limit(self):
        links = corpus()
        store = FakeStore({links[0]["id"]: {"checked": days_ago(1), "alive": True}})
        named = pg.select(links, store, NOW, ids=[links[0]["id"], links[5]["id"]])
        self.assertEqual([item["id"] for item, _ in named], [links[0]["id"], links[5]["id"]])
        self.assertTrue(all(item["saved"].startswith("2011") for item, _ in pg.select(links, store, NOW, year="2011")))
        self.assertEqual(len(pg.select(links, store, NOW, limit=7)), 7)

    def test_sample_spreads_evenly_across_years(self):
        links = corpus()
        chosen = pg.select(links, FakeStore(), NOW, sample=150)
        self.assertEqual(len(chosen), 150)
        per_year = {}
        for item, _ in chosen:
            per_year[item["saved"][:4]] = per_year.get(item["saved"][:4], 0) + 1
        self.assertEqual(sorted(per_year), [str(year) for year in range(2005, 2027)])
        self.assertLessEqual(max(per_year.values()) - min(per_year.values()), 1)
        self.assertEqual(len({item["id"] for item, _ in chosen}), 150)
        self.assertEqual(chosen, pg.select(links, FakeStore(), NOW, sample=150))  # deterministic

    def test_sample_gives_a_thin_year_all_it_has(self):
        links = corpus() + [link(f"https://x{n}.example/", f"2026-12-{n + 1:02d}T00:00:00Z") for n in range(20)]
        links = [item for item in links if not item["saved"].startswith("2005")] + [
            link("https://only.example/2005", "2005-06-01T00:00:00Z")
        ]
        per_year = {}
        for item in pg.spread(links, 66):
            per_year[item["saved"][:4]] = per_year.get(item["saved"][:4], 0) + 1
        self.assertEqual(per_year["2005"], 1)
        self.assertEqual(sum(per_year.values()), 66)

    def test_spread_within_a_year_is_evenly_spaced(self):
        links = [link(f"https://e.example/{n}", f"2010-01-{n + 1:02d}T00:00:00Z") for n in range(10)]
        self.assertEqual([item["url"][-1] for item in pg.spread(links, 2)], ["2", "7"])

    def test_wayback_mode_ignores_liveness(self):
        a = link("https://a.example/", "2005-01-01T00:00:00Z")
        b = link("https://b.example/", "2006-01-01T00:00:00Z")
        c = link("https://c.example/", "2007-01-01T00:00:00Z")
        d = link("https://d.example/", "2008-01-01T00:00:00Z")
        e = link("https://e.example/", "2009-01-01T00:00:00Z")
        f = link("https://f.example/", "2010-01-01T00:00:00Z")
        store = FakeStore(
            {
                b["id"]: {"checked": days_ago(1), "alive": True},  # liveness, no Wayback
                c["id"]: {"checked": days_ago(5), "wayback": {"checked": days_ago(5)}},  # fresh
                d["id"]: {"checked": days_ago(1), "alive": True, "wayback": {"checked": days_ago(120)}},
                e["id"]: {"checked": days_ago(200), "wayback": {"checked": days_ago(200)}},  # Wayback-only, older
            }
        )
        chosen = pg.select([a, b, c, d, e, f], store, NOW, mode="wayback")
        self.assertEqual(
            [(item["id"], reason) for item, reason in chosen],
            [
                (a["id"], "no wayback"),  # never observed at all, in saved order
                (b["id"], "no wayback"),
                (f["id"], "no wayback"),
                (e["id"], f"wayback checked {days_ago(200)}"),  # then the oldest answers
                (d["id"], f"wayback checked {days_ago(120)}"),
            ],
        )
        self.assertEqual(len(pg.select([a, b, c, d, e, f], store, NOW, mode="wayback", limit=2)), 2)

    def test_a_wayback_only_record_is_unobserved_for_liveness(self):
        a = link("https://a.example/", "2005-01-01T00:00:00Z")
        store = FakeStore({a["id"]: {"checked": days_ago(1), "wayback": {"checked": days_ago(1)}}})
        self.assertEqual(pg.select([a], store, NOW), [(a, "unobserved")])

    def test_a_wayback_only_record_has_no_liveness_fields(self):
        observed = {"first": None, "last": None, "count": 0}
        record = pg.with_wayback(None, observed, NOW)
        self.assertEqual(
            record,
            {"checked": "2026-10-23T12:00:00Z", "method": "enrich_pages", "version": 1,
             "wayback": {"first": None, "last": None, "count": 0, "checked": "2026-10-23T12:00:00Z"}},
        )
        self.assertFalse(set(record) & set(pg.LIVENESS_FIELDS))
        later = pg.with_wayback(record, {"first": None, "last": None, "count": 0}, datetime(2027, 2, 1, tzinfo=timezone.utc))
        self.assertEqual(later["checked"], "2027-02-01T00:00:00Z")  # a Wayback-only record dates its lookup
        live = {"checked": "2026-10-01T00:00:00Z", "method": "enrich_pages", "version": 1, "status": 200, "alive": True}
        self.assertEqual(pg.with_wayback(live, observed, NOW)["checked"], "2026-10-01T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
