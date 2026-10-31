"""The data validator (docs/DATA.md). Run: python3 -m unittest discover -s tests -v"""

import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import validate_data  # noqa: E402
from linking import jsonio  # noqa: E402
from linking.issues import SOURCE  # noqa: E402
from linking.urls import link_id, md5_hex  # noqa: E402
from linking.validate import validate  # noqa: E402


def record(url, saved, **changes):
    value = {
        "id": link_id(url),
        "hash": md5_hex(url),
        "url": url,
        "title": "A title",
        "note": "",
        "saved": saved,
        "tags": ["web"],
        "toread": False,
        "meta": md5_hex("meta " + url),
    }
    value.update(changes)
    return value


A = record("https://a.example/", "2019-03-01T10:00:00Z")
B = record("https://b.example/post", "2019-07-04T08:30:00Z")
C = record("https://c.example/", "2020-01-02T00:00:00Z", tags=[], toread=True, note="It's good.")
PRIVATE_URL = "https://private.example/secret-page"


def issue(number, date, links):
    return {
        "number": number,
        "slug": str(number),
        "title": "Things",
        "subject": f"WT{number} — Things",
        "date": date,
        "url": f"https://weekly.thingelstad.com/archive/{number}/",
        "links": [
            {
                "position": position,
                "id": link,
                "url": "https://linked.example/",
                "text": "Linked",
                "section": None,
                "heading_context": None,
            }
            for position, link in enumerate(links)
        ],
    }


def pinboard_post(url, shared):
    return {
        "href": url,
        "description": "t",
        "extended": "",
        "meta": md5_hex("m"),
        "hash": md5_hex(url),
        "time": "2019-01-01T00:00:00Z",
        "shared": shared,
        "toread": "no",
        "tags": "",
    }


class Fixture:
    """A small valid data directory, changed one way per test."""

    def __init__(self):
        self.years = {"2019": [A, B], "2020": [C]}
        self.hosts, self.pages, self.facts, self.media = {}, {}, {}, {}
        self.issues = [
            issue(1, "2019-08-03T12:00:00Z", [A["id"], None]),
            issue(2, "2020-01-04T12:00:00Z", [C["id"], A["id"]]),
        ]
        self.state = {"updated": "2020-01-02T00:00:05Z", "fetched_at": "2020-01-02T00:01:00Z", "public": 3, "total": 4}
        self.raw = [pinboard_post(r["url"], "yes") for r in (A, B, C)] + [pinboard_post(PRIVATE_URL, "no")]

    def write(self, root):
        root = Path(root)
        data = root / "data"
        for year, records in self.years.items():
            jsonio.write_json(data / "links" / f"{year}.json", records)
        jsonio.write_json(data / "derived" / "issues.json", {"source": SOURCE, "issues": self.issues})
        if self.state is not None:
            jsonio.write_json(data / "sync.json", self.state)
        raw = root / "pinboard" / "posts_all.json"
        jsonio.write_json(raw, self.raw)
        for kind, shards in (("hosts", self.hosts), ("pages", self.pages), ("facts", self.facts)):
            for name, records in shards.items():
                jsonio.write_json(data / "enrichment" / kind / f"{name}.json", dict(sorted(records.items())))
        for relative, body in self.media.items():
            path = root / "public" / "media" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        return data, raw


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fixture = Fixture()

    def tearDown(self):
        self.tmp.cleanup()

    def run_validate(self, token=None):
        data, raw = self.fixture.write(self.root)
        return validate(data, raw_path=raw, token=token)

    def assertFails(self, *fragments, token=None):
        report, _ = self.run_validate(token)
        self.assertFalse(report.ok, "expected a failure")
        text = "\n".join(report.errors)
        for fragment in fragments:
            self.assertIn(fragment, text)
        return report.errors


class ValidateTest(Base):
    def test_valid_data_passes_with_counts(self):
        report, summary = self.run_validate()
        self.assertEqual(report.errors, [])
        self.assertEqual(
            summary,
            {"links": 3, "years": 2, "issues": 2, "linked_ids": 2, "unmatched": 1, "private_checked": True,
             "stars": 0, "starless": 3, "hosts": 0, "pages": 0, "facts": 0, "images": 0},
        )

    def test_without_the_raw_export_the_private_check_is_skipped(self):
        data, raw = self.fixture.write(self.root)
        raw.unlink()
        report, summary = validate(data, raw_path=raw)
        self.assertTrue(report.ok, report.errors)
        self.assertFalse(summary["private_checked"])

    # Private bookmarks

    def test_a_raw_pinboard_bookmark_with_a_shared_field_fails(self):
        self.fixture.years["2019"][0] = dict(A, shared="no")
        self.assertFails("2019.json[0]", "has a 'shared' field", "unknown shared")

    def test_a_private_bookmark_fails_even_in_the_contract_shape(self):
        leaked = record(PRIVATE_URL, "2019-12-31T23:00:00Z")
        self.fixture.years["2019"].append(leaked)
        self.fixture.state["public"] = 4
        errors = self.assertFails(f"links {leaked['id']}: is a private bookmark")
        # The message names the id, never the private URL.
        self.assertFalse(any("private.example" in line for line in errors))

    # Records

    def test_a_bad_id_fails(self):
        self.fixture.years["2019"][1] = dict(B, id="0123456789ab")
        self.assertFails(f"2019.json[1]: id 0123456789ab is not md5(url)[:12] ({B['id']})")

    def test_an_id_that_is_not_hex_fails(self):
        self.fixture.years["2019"][1] = dict(B, id="ABCDEF")
        self.assertFails("is not 12 lower-case hex characters")

    def test_a_bad_hash_fails(self):
        self.fixture.years["2019"][1] = dict(B, hash=md5_hex("other"))
        self.assertFails("2019.json[1]: hash is not md5(url)")

    def test_a_duplicate_across_years_fails(self):
        self.fixture.years["2020"].insert(0, copy.deepcopy(B))
        self.assertFails(f"2020.json[0]: duplicate id {B['id']}", "is not in 2020, the year of its file")

    def test_a_record_in_the_wrong_year_file_fails(self):
        self.fixture.years["2020"].insert(0, record("https://d.example/", "2019-12-31T23:59:59Z"))
        self.fixture.state["public"] = 4
        self.assertFails("2020.json[0]: saved 2019-12-31T23:59:59Z is not in 2020")

    def test_out_of_order_fails(self):
        self.fixture.years["2019"].reverse()
        self.assertFails("2019.json[1]: out of order")

    def test_saved_format(self):
        self.fixture.years["2019"][0] = dict(A, saved="2019-03-01 10:00:00")
        self.assertFails("saved '2019-03-01 10:00:00' is not YYYY-MM-DDTHH:MM:SSZ")

    def test_types(self):
        self.fixture.years["2019"][0] = dict(A, toread="no", tags="web design")
        self.fixture.years["2019"][1] = dict(B, tags=["two words"])
        self.assertFails("2019.json[0]: tags is not a list", "2019.json[0]: toread is not a boolean", "2019.json[1]: tags")

    def test_unknown_missing_and_reordered_fields(self):
        extra = dict(A, private=False)
        missing = {key: value for key, value in B.items() if key != "meta"}
        self.fixture.years["2019"] = [extra, missing]
        self.fixture.years["2020"] = [{key: C[key] for key in reversed(list(C))}]
        self.assertFails("unknown private", "missing meta", "fields out of order")

    def test_non_canonical_formatting_fails(self):
        data, raw = self.fixture.write(self.root)
        path = data / "links" / "2019.json"
        path.write_text(json.dumps(self.fixture.years["2019"], indent=2), encoding="utf-8")
        report, _ = validate(data, raw_path=raw)
        self.assertIn(f"{path}: not in the canonical format", "\n".join(report.errors))

    def test_stray_files_in_links_fail(self):
        data, raw = self.fixture.write(self.root)
        (data / "links" / "all.json").write_text("[]\n")
        report, _ = validate(data, raw_path=raw)
        self.assertIn("not a <yyyy>.json links file", "\n".join(report.errors))

    # issues.json

    def test_an_issue_link_to_an_unknown_id_fails(self):
        self.fixture.issues[0]["links"][0]["id"] = "ffffffffffff"
        self.assertFails("issues.json 1 link 0: id 'ffffffffffff' is not a saved link")

    def test_positions_must_run_from_zero(self):
        self.fixture.issues[1]["links"][1]["position"] = 2
        self.assertFails("issues.json 2 link 1: position 2")

    def test_issues_sorted_by_date_then_slug(self):
        self.fixture.issues.reverse()
        self.assertFails("issues.json 1: out of order")

    def test_issue_fields(self):
        self.fixture.issues[0]["number"] = "1"
        self.fixture.issues[1]["date"] = "2020-01-04"
        self.fixture.issues[1]["links"][0]["text"] = 5
        del self.fixture.issues[1]["links"][1]["section"]
        self.assertFails(
            "issues.json 1: number is not an integer or null",
            "issues.json 2: date '2020-01-04' is not",
            "issues.json 2 link 0: text is not a string or null",
            "issues.json 2 link 1: fields are not exactly",
        )

    # sync.json

    def test_sync_state_must_match_the_links(self):
        self.fixture.state["public"] = 99
        self.assertFails("public is 99 but the links hold 3")

    def test_sync_state_fields(self):
        self.fixture.state = {"updated": None, "public": 3}
        self.assertFails("fields are not exactly updated, fetched_at, public, total")

    # Credentials

    def test_credential_like_strings_fail_without_being_echoed(self):
        self.fixture.years["2019"][0] = dict(A, note="api?auth_token=hidden&format=json")
        self.fixture.years["2019"][1] = dict(B, note="token: " + "0123456789abcdef0123")
        self.fixture.years["2020"][0] = dict(C, note="key " + "jamie:" + "0123456789ABCDEF0123")
        errors = self.assertFails("an auth_token parameter", "a hex token after 'token'", "a Pinboard API token")
        text = "\n".join(errors)
        for secret in ("hidden", "0123456789abcdef0123", "0123456789ABCDEF0123"):
            self.assertNotIn(secret, text)

    def test_the_env_token_value_fails_anywhere_under_data(self):
        token = "someone:notahexsecret42"
        self.fixture.issues[0]["links"][1]["text"] = "pasted notahexsecret42 by mistake"
        errors = self.assertFails("contains the PINBOARD_API_TOKEN value", token=token)
        self.assertFalse(any("notahexsecret42" in line for line in errors))

    def test_a_plain_mention_of_tokens_passes(self):
        self.fixture.years["2019"][0] = dict(A, note="https://etherscan.io/token/0x6b175474e89094c44da98b954eedeac495271d0f")
        report, _ = self.run_validate()
        self.assertTrue(report.ok, report.errors)


VIDEO = record("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "2020-05-01T00:00:00Z")
REPO = record("https://github.com/simonw/datasette", "2020-06-01T00:00:00Z")
STAMP = "2026-10-24T02:00:00Z"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16


def host_record(version=2, **changes):
    value = {
        "checked": STAMP,
        "method": "enrich_hosts",
        "version": version,
        "dns": {"resolves": True, "a": ["192.0.2.1"], "aaaa": [], "cname": None, "ns": [], "mx": False},
        "https": {"reachable": True, "redirects_http": True, "status": 200},
    }
    if version >= 2:
        value["home"] = {
            "checked": STAMP,
            "title": "A",
            "generator": None,
            "feeds": [{"type": "rss", "url": "https://a.example/feed/", "title": None}],
            "hcard": False,
            "rel_me": ["https://mastodon.example/@a"],
            "webmention": None,
        }
    value["rdap"] = None
    value["rdap_error"] = "no RDAP service for .example"
    value.update(changes)
    return value


def page_record(**changes):
    value = {"checked": STAMP, "method": "enrich_pages", "version": 1, "status": 404, "alive": False,
             "final_url": "https://b.example/post", "redirects": [], "content_type": "text/html",
             "error": "HTTP 404"}
    value.update(changes)
    return value


WAYBACK = {"first": "2019-07-05T00:00:00Z", "last": "2024-01-01T00:00:00Z", "count": 3, "checked": STAMP}
WAYBACK_ONLY = {"checked": STAMP, "method": "enrich_pages", "version": 1, "wayback": WAYBACK}


def video_fact(**changes):
    value = {"checked": STAMP, "method": "youtube", "version": 1, "kind": "video", "video_id": "dQw4w9WgXcQ",
             "provider": "youtube", "title": "Never Gonna", "author": "Rick Astley",
             "author_url": "https://www.youtube.com/@RickAstley", "image": "/media/youtube/dQw4w9WgXcQ.jpg"}
    value.update(changes)
    return value


REPO_ERROR = {"checked": STAMP, "method": "github", "version": 1, "kind": "repository", "error": "HTTP 404"}


class EnrichmentTest(Base):
    """data/enrichment/ and public/media/ against docs/DATA.md."""

    def setUp(self):
        super().setUp()
        f = self.fixture
        f.years["2020"] += [VIDEO, REPO]
        f.state["public"], f.state["total"] = 5, 6
        f.raw += [pinboard_post(VIDEO["url"], "yes"), pinboard_post(REPO["url"], "yes")]
        f.hosts = {"a": {"a.example": host_record()}, "b": {"b.example": host_record(version=1)}}
        f.pages = {"2019": {B["id"]: page_record(wayback=WAYBACK)}, "2020": {C["id"]: WAYBACK_ONLY}}
        f.facts = {"2020": {VIDEO["id"]: video_fact(), REPO["id"]: REPO_ERROR}}
        f.media = {"youtube/dQw4w9WgXcQ.jpg": JPEG}

    def test_valid_enrichment_passes_with_counts(self):
        report, summary = self.run_validate()
        self.assertEqual(report.errors, [])
        self.assertEqual((summary["hosts"], summary["pages"], summary["facts"], summary["images"]), (2, 2, 2, 1))

    # Keys and shards

    def test_a_host_that_no_public_link_has_fails(self):
        self.fixture.hosts["p"] = {"private.example": host_record()}
        self.assertFails("hosts/p.json private.example: is not the host of any public link")

    def test_a_host_in_the_wrong_letter_shard_fails(self):
        self.fixture.hosts["b"]["a.example"] = self.fixture.hosts["a"].pop("a.example")
        del self.fixture.hosts["a"]
        self.assertFails("hosts/b.json a.example: belongs in hosts/a.json")

    def test_pages_and_facts_go_in_the_year_of_their_link(self):
        self.fixture.pages["2020"][B["id"]] = self.fixture.pages["2019"].pop(B["id"])
        del self.fixture.pages["2019"]
        self.fixture.facts["2019"] = {VIDEO["id"]: self.fixture.facts["2020"].pop(VIDEO["id"])}
        self.assertFails(
            f"pages/2020.json {B['id']}: belongs in pages/2019.json, the year its link was saved",
            f"facts/2019.json {VIDEO['id']}: belongs in facts/2020.json",
        )

    def test_a_key_that_is_not_a_public_id_fails(self):
        private_id = link_id(PRIVATE_URL)
        self.fixture.pages["2019"][private_id] = WAYBACK_ONLY
        self.fixture.facts["2020"]["ffffffffffff"] = video_fact()
        self.assertFails(
            f"pages/2019.json {private_id}: is not the id of a public link",
            "facts/2020.json ffffffffffff: is not the id of a public link",
        )

    def test_shard_files_are_canonical_sorted_and_named(self):
        data, raw = self.fixture.write(self.root)
        pages = data / "enrichment" / "pages"
        (pages / "2019.json").write_text(json.dumps(self.fixture.pages["2019"], indent=2), encoding="utf-8")
        (pages / "notes.json").write_text("{}\n", encoding="utf-8")
        high, low = sorted((C["id"], VIDEO["id"]), reverse=True)
        jsonio.write_json(pages / "2020.json", {high: WAYBACK_ONLY, low: WAYBACK_ONLY})
        report, _ = validate(data, raw_path=raw)
        text = "\n".join(report.errors)
        self.assertIn("2019.json: not in the canonical format", text)
        self.assertIn("notes.json: not a pages shard file", text)
        self.assertIn("2020.json: keys are not sorted", text)

    # Fields

    def test_hosts_have_only_known_fields(self):
        self.fixture.hosts["a"]["a.example"] = host_record(owner="someone")
        self.fixture.hosts["b"]["b.example"]["dns"]["txt"] = []
        self.assertFails("hosts/a.json a.example: unknown owner", "hosts/b.json b.example dns: unknown txt")

    def test_home_belongs_to_version_2_only(self):
        self.fixture.hosts["a"]["a.example"] = host_record(version=2)
        del self.fixture.hosts["a"]["a.example"]["home"]
        v1 = host_record(version=1)
        v1["home"] = host_record()["home"]
        self.fixture.hosts["b"]["b.example"] = v1
        self.assertFails("hosts/a.json a.example: missing home", "hosts/b.json b.example: unknown home")

    def test_home_fields(self):
        home = self.fixture.hosts["a"]["a.example"]["home"]
        home["feeds"][0]["type"] = "json-ld"
        home["rel_me"] = ["javascript:alert(1)"]
        home["body"] = "<html>"
        self.assertFails("a.example home: unknown body")
        del home["body"]
        self.assertFails("feeds[0]: type is not rss, atom or json", "rel_me is not a list of http(s) URLs")

    def test_a_wayback_only_record_has_no_liveness_field(self):
        self.fixture.pages["2020"][C["id"]] = dict(WAYBACK_ONLY, error="HTTP 404")
        self.assertFails(f"pages/2020.json {C['id']}: liveness fields with no liveness check", ": error")

    def test_a_liveness_record_has_every_liveness_field(self):
        partial = page_record()
        del partial["content_type"]
        self.fixture.pages["2019"][B["id"]] = partial
        self.assertFails(f"pages/2019.json {B['id']}: missing content_type")

    def test_facts_shapes_kinds_and_methods(self):
        self.fixture.facts["2020"][VIDEO["id"]] = video_fact(kind="article", views=10)
        self.fixture.facts["2020"][REPO["id"]] = dict(REPO_ERROR, method="vimeo")
        self.assertFails(
            f"{VIDEO['id']}: kind is not video",
            f"{VIDEO['id']}: not a youtube record: unknown views",
            f"{REPO['id']}: method is not github",
        )

    def test_a_fact_for_a_link_no_adapter_applies_to_fails(self):
        self.fixture.facts["2019"] = {A["id"]: REPO_ERROR}
        self.assertFails(f"facts/2019.json {A['id']}: no adapter applies to this link")

    def test_fact_field_types(self):
        self.fixture.facts["2020"][REPO["id"]] = {
            "checked": STAMP, "method": "github", "version": 1, "kind": "repository", "full_name": "simonw/datasette",
            "description": None, "language": "Python", "stars": "many", "license": None, "archived": "no",
            "pushed": None, "homepage": None, "fork": False,
        }
        self.assertFails("stars is not a count or null", "archived is not a boolean")

    # public/media/

    def test_an_image_path_must_exist(self):
        self.fixture.media = {}
        self.assertFails(f"{VIDEO['id']}: image public/media/youtube/dQw4w9WgXcQ.jpg does not exist")

    def test_an_image_path_must_be_in_the_adapters_directory(self):
        self.fixture.facts["2020"][VIDEO["id"]] = video_fact(image="/media/../../etc/passwd")
        self.assertFails("image is not /media/youtube/<name>.jpg")

    def test_an_image_no_record_names_fails(self):
        self.fixture.media["youtube/oldvideo123.jpg"] = JPEG
        self.fixture.media["notes/readme.txt"] = b"hello"
        self.assertFails(
            "public/media/youtube/oldvideo123.jpg: no facts record names this image",
            "public/media/notes/readme.txt: is not in an enrich_facts.py media directory",
        )

    # Every string

    def test_no_string_longer_than_2000_characters_and_it_is_not_echoed(self):
        self.fixture.hosts["a"]["a.example"]["home"]["title"] = "x" * 2001
        self.fixture.facts["2020"][VIDEO["id"]] = video_fact(title="y" * 2000)  # the limit itself is fine
        errors = self.assertFails("hosts/a.json a.example: home.title is longer than 2,000 characters")
        self.assertEqual(len(errors), 1)
        self.assertNotIn("xxxx", errors[0])


class CommandTest(unittest.TestCase):
    def run_main(self, data, raw):
        out, err = io.StringIO(), io.StringIO()
        env = {key: value for key, value in os.environ.items() if key != "PINBOARD_API_TOKEN"}
        with mock.patch.dict(os.environ, env, clear=True):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = validate_data.main(["--data", str(data), "--raw", str(raw)])
        return code, out.getvalue(), err.getvalue()

    def test_exit_codes_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture()
            data, raw = fixture.write(tmp)
            code, out, err = self.run_main(data, raw)
            self.assertEqual(code, 0)
            self.assertEqual(err, "")
            self.assertEqual(
                out,
                "validate_data: ok: 3 links, 2 years, 2 issues, 2 linked ids, 1 unmatched rows; "
                "enrichment 0 hosts, 0 pages, 0 facts, 0 images; "
                "sky 0 stars, 3 waiting; "
                "private bookmarks checked against the raw export\n",
            )
            fixture.years["2019"][0] = dict(A, id="0123456789ab")
            fixture.write(tmp)
            code, out, err = self.run_main(data, raw)
            self.assertEqual(code, 1)
            self.assertIn("FAILED with", out)
            self.assertIn("is not md5(url)[:12]", err)


if __name__ == "__main__":
    unittest.main()
