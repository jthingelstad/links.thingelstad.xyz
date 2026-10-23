"""The Pinboard mirror: shards, the client, and the sync flow, with no network.

Run: python3 -m unittest discover -s tests -v
"""

import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))

import sync  # noqa: E402
from linking import jsonio  # noqa: E402
from linking import pinboard as pb  # noqa: E402
from linking.urls import md5_hex  # noqa: E402

TOKEN = "testuser:0123456789ABCDEF0123"


def post(url, time, *, shared="yes", title="A title", note="", tags="", toread="no"):
    return {
        "href": url,
        "description": title,
        "extended": note,
        "meta": md5_hex("meta" + url),
        "hash": md5_hex(url),
        "time": time,
        "shared": shared,
        "toread": toread,
        "tags": tags,
    }


POSTS = [
    post("https://example.com/newest", "2026-10-23T12:00:00Z", tags="_brief _feature"),
    post("https://example.com/private", "2026-10-22T12:00:00Z", shared="no", note="secret note"),
    post("https://example.com/b", "2026-01-01T00:00:00Z", note="café ☕"),
    post("https://example.com/a", "2026-01-01T00:00:00Z", toread="yes"),
    post("http://example.org/old", "2005-08-02T10:00:00Z"),
]


def raw_bytes(posts):
    return json.dumps(posts).replace("/", "\\/").encode("utf-8")


class ShardTest(unittest.TestCase):
    def test_private_bookmarks_never_become_records(self):
        years = pb.shard(POSTS)
        urls = [record["url"] for records in years.values() for record in records]
        self.assertNotIn("https://example.com/private", urls)
        self.assertEqual(len(urls), 4)

    def test_missing_or_odd_shared_value_is_private(self):
        odd = dict(POSTS[0], shared="YES")
        missing = {key: value for key, value in POSTS[2].items() if key != "shared"}
        self.assertEqual(pb.shard([odd, missing]), {})

    def test_record_fields_in_contract_order(self):
        record = pb.shard(POSTS)["2026"][-1]
        self.assertEqual(list(record), list(pb.RECORD_FIELDS))
        self.assertEqual(record["id"], md5_hex("https://example.com/newest")[:12])
        self.assertEqual(record["tags"], ["_brief", "_feature"])
        self.assertIs(record["toread"], False)
        self.assertNotIn("shared", record)

    def test_years_and_sort_by_saved_then_id(self):
        years = pb.shard(POSTS)
        self.assertEqual(list(years), ["2005", "2026"])
        saved_ties = [r for r in years["2026"] if r["saved"] == "2026-01-01T00:00:00Z"]
        self.assertEqual([r["id"] for r in saved_ties], sorted(r["id"] for r in saved_ties))
        self.assertEqual(years["2026"][-1]["url"], "https://example.com/newest")
        self.assertIs([r for r in years["2026"] if r["url"].endswith("/a")][0]["toread"], True)

    def test_hash_must_be_md5_of_href(self):
        bad = dict(POSTS[0], hash="0" * 32)
        with self.assertRaises(pb.SyncError):
            pb.shard([bad])

    def test_canonical_format(self):
        text = jsonio.dumps(pb.shard(POSTS)["2026"])
        self.assertTrue(text.startswith('[\n {\n  "id": '))
        self.assertTrue(text.endswith("}\n]\n"))
        self.assertIn("café ☕", text)

    def test_write_shards_removes_years_that_emptied(self):
        with tempfile.TemporaryDirectory() as tmp:
            links = Path(tmp) / "links"
            pb.write_shards(links, pb.shard(POSTS))
            self.assertEqual(sorted(p.name for p in links.iterdir()), ["2005.json", "2026.json"])
            changed, removed = pb.write_shards(links, pb.shard(POSTS[:4]))
            self.assertEqual((changed, removed), ([], ["2005"]))
            self.assertEqual([p.name for p in links.iterdir()], ["2026.json"])


class ParsePostsTest(unittest.TestCase):
    def test_accepts_the_export(self):
        self.assertEqual(len(pb.parse_posts(raw_bytes(POSTS))), 5)

    def test_refuses_what_is_not_an_export(self):
        for raw in (b"{}", b"[]", b"not json", json.dumps([{"href": "x"}]).encode()):
            with self.assertRaises(pb.SyncError):
                pb.parse_posts(raw)


class FakeFetch:
    """Stands in for the network: answers by endpoint, records each call."""

    def __init__(self, responses):
        self.responses = dict(responses)
        self.urls = []
        self.headers = []

    def __call__(self, url, headers, timeout):
        self.urls.append(url)
        self.headers.append(headers)
        endpoint = url.split("/v1/", 1)[1].split("?", 1)[0]
        answer = self.responses[endpoint]
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


class ClientTest(unittest.TestCase):
    def client(self, responses):
        fetch = FakeFetch(responses)
        clock = FakeClock()
        return pb.PinboardClient(TOKEN, fetch=fetch, sleep=clock.sleep, clock=clock.clock), fetch, clock

    def test_requests_carry_json_format_user_agent_and_token(self):
        client, fetch, _ = self.client({"posts/update": b'{"update_time":"2026-10-23T19:51:57Z"}'})
        self.assertEqual(client.posts_update(), "2026-10-23T19:51:57Z")
        self.assertTrue(fetch.urls[0].startswith("https://api.pinboard.in/v1/posts/update?format=json&auth_token="))
        self.assertIn("links.thingelstad.xyz", fetch.headers[0]["User-Agent"])

    def test_three_seconds_between_calls(self):
        client, _, clock = self.client(
            {"posts/update": b'{"update_time":"2026-10-23T19:51:57Z"}', "posts/all": raw_bytes(POSTS)}
        )
        client.posts_update()
        clock.now += 1.0
        client.posts_all()
        self.assertEqual(clock.slept, [2.0])
        self.assertEqual(client.calls, ["posts/update", "posts/all"])

    def test_http_errors_never_carry_the_token(self):
        error = urllib.error.HTTPError(
            f"https://api.pinboard.in/v1/posts/all?auth_token={TOKEN}", 429, "Too Many Requests", {"Retry-After": "300"}, None
        )
        client, _, _ = self.client({"posts/all": error})
        with self.assertRaises(pb.PinboardError) as caught:
            client.posts_all()
        message = str(caught.exception)
        self.assertIn("HTTP 429", message)
        self.assertIn("Retry-After: 300", message)
        self.assertNotIn(TOKEN, message)
        self.assertNotIn("0123456789ABCDEF0123", message)
        # The original error (whose url holds the token) is not chained on.
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)

    def test_other_errors_that_echo_the_url_are_redacted(self):
        url = f"https://api.pinboard.in/v1/posts/update?format=json&auth_token={TOKEN}"
        client, _, _ = self.client({"posts/update": ValueError(f"URL can't contain control characters. {url!r}")})
        with self.assertRaises(pb.PinboardError) as caught:
            client.posts_update()
        self.assertNotIn("0123456789ABCDEF0123", str(caught.exception))
        self.assertNotIn("testuser:", str(caught.exception))
        self.assertIn("auth_token=[redacted]", str(caught.exception))

    def test_unexpected_update_response(self):
        client, _, _ = self.client({"posts/update": b"<html>"})
        with self.assertRaises(pb.PinboardError):
            client.posts_update()

    def test_no_token_no_client(self):
        with self.assertRaises(pb.PinboardError):
            pb.PinboardClient("")


class FakeClient:
    def __init__(self, stamp, posts=POSTS):
        self.stamp = stamp
        self.raw = raw_bytes(posts)
        self.calls = []

    def posts_update(self):
        self.calls.append("posts/update")
        return self.stamp

    def posts_all(self):
        self.calls.append("posts/all")
        return self.raw


NOW = datetime(2026, 10, 23, 20, 0, 0, tzinfo=timezone.utc)


class SyncFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.raw = self.root / "pinboard" / "posts_all.json"
        self.client = None
        self.env = contextlib.ExitStack()
        self.env.enter_context(_env(PINBOARD_API_TOKEN=TOKEN))

    def tearDown(self):
        self.env.close()
        self.tmp.cleanup()

    def run_sync(self, *argv, stamp="2026-10-23T19:51:57Z", now=NOW):
        self.client = FakeClient(stamp)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sync.main(
                ["--data", str(self.data), "--raw", str(self.raw), *argv],
                client_factory=lambda token: self.client,
                now=lambda: now,
            )
        output = out.getvalue() + err.getvalue()
        self.assertNotIn(TOKEN, output)
        self.assertNotIn("0123456789ABCDEF0123", output)
        return code, output

    def state(self):
        return jsonio.load(self.data / "sync.json")

    def test_first_sync_pulls_and_records_the_stamp(self):
        code, _ = self.run_sync()
        self.assertEqual(code, 0)
        self.assertEqual(self.client.calls, ["posts/update", "posts/all"])
        self.assertEqual(
            self.state(),
            {"updated": "2026-10-23T19:51:57Z", "fetched_at": "2026-10-23T20:00:00Z", "public": 4, "total": 5},
        )
        self.assertEqual(sorted(p.name for p in (self.data / "links").iterdir()), ["2005.json", "2026.json"])
        self.assertEqual(self.raw.read_bytes(), self.client.raw)
        self.assertEqual(stat.S_IMODE(self.raw.stat().st_mode), 0o600)
        everything = "".join(p.read_text() for p in self.data.rglob("*.json"))
        self.assertNotIn("example.com/private", everything)
        self.assertNotIn("secret note", everything)

    def test_unchanged_stamp_makes_no_posts_all_call(self):
        self.run_sync()
        code, output = self.run_sync(now=NOW + timedelta(hours=1))
        self.assertEqual(code, 0)
        self.assertEqual(self.client.calls, ["posts/update"])
        self.assertIn("unchanged", output)

    def test_moved_stamp_within_five_minutes_is_refused(self):
        self.run_sync()
        code, output = self.run_sync(stamp="2026-10-23T20:01:00Z", now=NOW + timedelta(minutes=4))
        self.assertEqual(code, sync.EXIT_RATE_LIMITED)
        self.assertEqual(self.client.calls, ["posts/update"])
        self.assertIn("five minutes", output)
        self.assertEqual(self.state()["updated"], "2026-10-23T19:51:57Z")

    def test_moved_stamp_after_five_minutes_pulls(self):
        self.run_sync()
        code, _ = self.run_sync(stamp="2026-10-23T20:01:00Z", now=NOW + timedelta(minutes=6))
        self.assertEqual(code, 0)
        self.assertEqual(self.client.calls, ["posts/update", "posts/all"])
        self.assertEqual(self.state()["updated"], "2026-10-23T20:01:00Z")

    def test_force_pulls_an_unchanged_stamp_but_not_within_five_minutes(self):
        self.run_sync()
        code, _ = self.run_sync("--force", now=NOW + timedelta(minutes=1))
        self.assertEqual(code, sync.EXIT_RATE_LIMITED)
        self.assertEqual(self.client.calls, [])
        code, _ = self.run_sync("--force", now=NOW + timedelta(minutes=10))
        self.assertEqual(code, 0)
        self.assertEqual(self.client.calls, ["posts/update", "posts/all"])

    def test_the_local_marker_counts_a_failed_call(self):
        self.raw.parent.mkdir(parents=True)
        (self.raw.parent / ".posts_all_called_at").write_text("2026-10-23T19:58:00Z\n")
        code, _ = self.run_sync()
        self.assertEqual(code, sync.EXIT_RATE_LIMITED)
        self.assertEqual(self.client.calls, ["posts/update"])

    def test_check_calls_posts_update_only_and_writes_nothing(self):
        code, output = self.run_sync("--check")
        self.assertEqual(code, 0)
        self.assertEqual(self.client.calls, ["posts/update"])
        self.assertIn("would call posts/all", output)
        self.assertFalse(self.data.exists())
        self.assertFalse(self.raw.exists())

    def test_a_shrinking_export_is_refused(self):
        self.run_sync()
        shrunk = FakeClient("2026-10-25T00:00:00Z", posts=POSTS[:2])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sync.main(
                ["--data", str(self.data), "--raw", str(self.raw)],
                client_factory=lambda token: shrunk,
                now=lambda: NOW + timedelta(days=2),
            )
        self.assertEqual(code, 1)
        self.assertIn("--allow-shrink", out.getvalue())
        self.assertEqual(self.state()["public"], 4)

    def test_raw_export_may_not_live_under_data(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sync.main(["--data", str(self.data), "--raw", str(self.data / "posts_all.json")])
        self.assertEqual(code, 1)
        self.assertIn("refusing", out.getvalue())

    def test_missing_token(self):
        with _env(PINBOARD_API_TOKEN=None), contextlib.redirect_stdout(io.StringIO()) as out:
            code = sync.main(["--data", str(self.data), "--raw", str(self.raw)])
        self.assertEqual(code, 1)
        self.assertIn("PINBOARD_API_TOKEN is not set", out.getvalue())


class OfflineTest(unittest.TestCase):
    def test_offline_writes_shards_and_state_without_a_client(self):
        with tempfile.TemporaryDirectory() as tmp, _env(PINBOARD_API_TOKEN=None):
            source = Path(tmp) / "export.json"
            source.write_bytes(raw_bytes(POSTS))
            mtime = datetime(2026, 10, 23, 19, 52, 35, tzinfo=timezone.utc).timestamp()
            os.utime(source, (mtime, mtime))
            data = Path(tmp) / "data"

            def no_network(token):
                raise AssertionError("offline mode built a client")

            with contextlib.redirect_stdout(io.StringIO()):
                code = sync.main(["--from", str(source), "--data", str(data)], client_factory=no_network)
            self.assertEqual(code, 0)
            self.assertEqual(
                jsonio.load(data / "sync.json"),
                {"updated": None, "fetched_at": "2026-10-23T19:52:35Z", "public": 4, "total": 5},
            )
            years = pb.shard(POSTS)
            for year, records in years.items():
                self.assertEqual((data / "links" / f"{year}.json").read_text(), jsonio.dumps(records))

    def test_offline_keeps_the_recorded_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "export.json"
            source.write_bytes(raw_bytes(POSTS))
            data = Path(tmp) / "data"
            pb.write_state(data / "sync.json", "2026-10-23T19:51:57Z", "2026-10-23T19:52:35Z", 9, 9)
            with contextlib.redirect_stdout(io.StringIO()):
                sync.main(["--from", str(source), "--data", str(data)])
            self.assertEqual(
                jsonio.load(data / "sync.json"),
                {"updated": "2026-10-23T19:51:57Z", "fetched_at": "2026-10-23T19:52:35Z", "public": 4, "total": 5},
            )


@contextlib.contextmanager
def _env(**values):
    saved = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
