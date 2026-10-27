import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from import_bookmarks import import_bookmarks  # noqa: E402
from linking import jsonio  # noqa: E402
from linking.bookmarks import merge_bookmarks  # noqa: E402
from linking.pinboard import SyncError, to_record  # noqa: E402


def post(url="https://example.com/bookmark", **changes):
    return {"href": url, "description": "Title", "extended": "Jamie's words", "meta": "a" * 32,
            "hash": hashlib.md5(url.encode()).hexdigest(), "time": "2026-10-27T10:00:00Z",
            "shared": "yes", "toread": "no", "tags": "existing", **changes}


class CaptureImport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "data/links").mkdir(parents=True)
        self.inbox = self.root / "inbox"
        self.inbox.mkdir()
        self.state = {"updated": "2026-10-26T10:00:00Z", "fetched_at": "2026-10-26T10:01:00Z", "public": 0, "total": 1}
        jsonio.write_json(self.root / "data/sync.json", self.state)

    def capture(self, value=None, at="2026-10-27T11:00:00Z"):
        value = value or post()
        body = json.dumps({"version": 1, "star": {"id": "123", "url": value["href"]}, "observed_at": at, "post": value}).encode()
        path = self.inbox / (hashlib.sha256(body).hexdigest() + ".json")
        path.write_bytes(body)
        return path

    def test_additive_import_never_rewrites_full_snapshot_and_retries_are_noops(self):
        self.capture()
        self.assertEqual(import_bookmarks(self.root, self.inbox), 1)
        self.assertEqual(jsonio.load(self.root / "data/sync.json"), self.state)
        self.assertEqual(list((self.root / "data/links").iterdir()), [])
        effective = merge_bookmarks([], self.root / "data")
        self.assertEqual(effective, [to_record(post())])
        before = (self.root / "data/derived/bookmarks.json").read_bytes()
        self.assertEqual(import_bookmarks(self.root, self.inbox), 0)
        self.assertEqual((self.root / "data/derived/bookmarks.json").read_bytes(), before)

    def test_existing_edits_and_later_full_snapshot_privacy_win(self):
        existing = to_record(post(extended="Later edit", tags="mine"))
        jsonio.write_json(self.root / "data/links/2026.json", [existing])
        self.capture()
        self.assertEqual(import_bookmarks(self.root, self.inbox), 0)
        self.assertEqual(merge_bookmarks([existing], self.root / "data"), [existing])
        self.state["fetched_at"] = "2026-10-28T11:00:00Z"
        jsonio.write_json(self.root / "data/sync.json", self.state)
        self.assertEqual(merge_bookmarks([], self.root / "data"), [])

    def test_stale_capture_cannot_resurrect_absent_record(self):
        self.capture(at="2026-10-25T11:00:00Z")
        self.assertEqual(import_bookmarks(self.root, self.inbox), 0)
        self.assertEqual(merge_bookmarks([], self.root / "data"), [])

    def test_private_malformed_or_tampered_batch_writes_nothing(self):
        for changes in ({"shared": "no"}, {"meta": "bad"}, {"hash": "b" * 32}):
            with self.subTest(changes=changes):
                for file in self.inbox.iterdir():
                    file.unlink()
                self.capture(post(**changes))
                with self.assertRaises(SyncError):
                    import_bookmarks(self.root, self.inbox)
                self.assertFalse((self.root / "data/derived/bookmarks.json").exists())
        file = self.capture()
        file.write_text('{}')
        with self.assertRaises(SyncError):
            import_bookmarks(self.root, self.inbox)
