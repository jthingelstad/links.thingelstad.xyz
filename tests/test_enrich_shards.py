"""Enrichment shards: layout, canonical output, merging with what is on disk,
and dropping records that are no longer public. No network.

Run: python3 -I -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import hosts as hs  # noqa: E402
from linking import pages as pg  # noqa: E402
from linking.shards import ShardError, Store  # noqa: E402


def record(checked="2026-10-23T12:00:00Z", **extra):
    return {"checked": checked, "method": "enrich_pages", "version": 1, **extra}


class LayoutTest(unittest.TestCase):
    def test_hosts_shard_by_first_character(self):
        self.assertEqual(hs.shard_of("macstories.net"), "m")
        self.assertEqual(hs.shard_of("9to5mac.com"), "9")
        self.assertIsNone(hs.shard_of("-odd.example"))
        self.assertIsNone(hs.shard_of(""))

    def test_pages_shard_by_year_saved(self):
        self.assertEqual(pg.year_of({"saved": "2009-03-01T10:00:00Z"}), "2009")


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "pages"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, value):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / name).write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8")

    def test_writes_sorted_keys_in_the_canonical_format(self):
        store = Store(self.dir, {"bbbbbbbbbbbb": "2009", "aaaaaaaaaaaa": "2009"}, pg.SHARD_RE).load()
        store.put("bbbbbbbbbbbb", record(status=200))
        store.put("aaaaaaaaaaaa", record(status=404, note="café"))
        self.assertEqual(store.flush(), ["2009"])
        text = (self.dir / "2009.json").read_text(encoding="utf-8")
        self.assertTrue(text.endswith("}\n"))
        self.assertIn("café", text)  # UTF-8 kept, not escaped
        self.assertIn('\n "aaaaaaaaaaaa": {\n  "checked"', text)  # indent 1
        self.assertEqual(list(json.loads(text)), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])
        # Field order inside a record is the record's own, not sorted.
        self.assertEqual(list(json.loads(text)["aaaaaaaaaaaa"]), ["checked", "method", "version", "status", "note"])

    def test_merges_with_what_is_on_disk(self):
        self.write("2009.json", {"aaaaaaaaaaaa": record(status=200), "cccccccccccc": record(status=410)})
        expected = {"aaaaaaaaaaaa": "2009", "bbbbbbbbbbbb": "2009", "cccccccccccc": "2009"}
        store = Store(self.dir, expected, pg.SHARD_RE).load()
        store.put("bbbbbbbbbbbb", record(status=301))
        store.flush()
        saved = json.loads((self.dir / "2009.json").read_text())
        self.assertEqual(list(saved), ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"])
        self.assertEqual(saved["cccccccccccc"]["status"], 410)

    def test_an_unchanged_shard_is_not_rewritten(self):
        expected = {"aaaaaaaaaaaa": "2009"}
        store = Store(self.dir, expected, pg.SHARD_RE).load()
        store.put("aaaaaaaaaaaa", record(status=200))
        store.flush()
        path = self.dir / "2009.json"
        os.utime(path, (1, 1))
        again = Store(self.dir, expected, pg.SHARD_RE).load()
        again.put("aaaaaaaaaaaa", record(status=200))
        self.assertEqual(again.flush(), [])
        self.assertEqual(path.stat().st_mtime, 1)

    def test_records_no_longer_public_are_dropped(self):
        self.write("2009.json", {"aaaaaaaaaaaa": record(), "dddddddddddd": record(final_url="https://private.example/")})
        store = Store(self.dir, {"aaaaaaaaaaaa": "2009"}, pg.SHARD_RE).load()
        self.assertEqual(store.dropped, 1)
        store.flush()
        self.assertNotIn("private.example", (self.dir / "2009.json").read_text())

    def test_a_shard_left_empty_is_removed(self):
        self.write("2010.json", {"dddddddddddd": record()})
        store = Store(self.dir, {}, pg.SHARD_RE).load()
        self.assertEqual(store.flush(), ["2010"])
        self.assertFalse((self.dir / "2010.json").exists())

    def test_a_misfiled_record_moves(self):
        self.write("2009.json", {"aaaaaaaaaaaa": record(status=200)})
        store = Store(self.dir, {"aaaaaaaaaaaa": "2011"}, pg.SHARD_RE).load()
        self.assertEqual(store.moved, 1)
        self.assertEqual(store.get("aaaaaaaaaaaa")["status"], 200)
        store.flush()
        self.assertFalse((self.dir / "2009.json").exists())
        self.assertIn("aaaaaaaaaaaa", json.loads((self.dir / "2011.json").read_text()))

    def test_other_files_are_left_alone(self):
        self.write("notes.json", {"x": 1})
        store = Store(self.dir, {}, pg.SHARD_RE).load()
        self.assertEqual(store.ignored, ["notes.json"])
        store.flush()
        self.assertTrue((self.dir / "notes.json").exists())

    def test_a_broken_shard_stops_the_run(self):
        self.dir.mkdir(parents=True)
        (self.dir / "2009.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(ShardError):
            Store(self.dir, {}, pg.SHARD_RE).load()
        (self.dir / "2009.json").write_text("[]", encoding="utf-8")
        with self.assertRaises(ShardError):
            Store(self.dir, {}, pg.SHARD_RE).load()

    def test_host_shard_names(self):
        directory = Path(self.tmp.name) / "hosts"
        store = Store(directory, {"macstories.net": "m", "9to5mac.com": "9"}, hs.SHARD_RE).load()
        store.put("macstories.net", record())
        store.put("9to5mac.com", record())
        self.assertEqual(store.flush(), ["9", "m"])
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ["9.json", "m.json"])


if __name__ == "__main__":
    unittest.main()
