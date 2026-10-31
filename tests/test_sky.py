"""The sky: vectors, neighbours and frozen places (docs/DATA.md, "The sky").
Run: python3 -m unittest discover -s tests -v"""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import jsonio, sky, vectors  # noqa: E402
from linking.check_sky import check_sky  # noqa: E402
from linking.urls import link_id, md5_hex  # noqa: E402
from linking.validate import Report  # noqa: E402


def record(url, saved, note="", title="A title"):
    return {
        "id": link_id(url),
        "hash": md5_hex(url),
        "url": url,
        "title": title,
        "note": note,
        "saved": saved,
        "tags": [],
        "toread": False,
        "meta": md5_hex("meta " + url),
    }


def vec(*leading):
    """A 1,024-dimension vector with the given leading values."""
    return list(leading) + [0.0] * (vectors.DIMS - len(leading))


# Two neighbourhoods: A near the first axis, B near the second.
LINKS = [
    (record("https://a1.example/", "2019-01-01T00:00:00Z", note="one"), vec(1.0, 0.05, 0.01)),
    (record("https://a2.example/", "2019-02-01T00:00:00Z", note="two"), vec(1.0, 0.1, 0.02)),
    (record("https://a3.example/", "2020-03-01T00:00:00Z", note="three"), vec(1.0, 0.2, 0.0)),
    (record("https://b1.example/", "2020-04-01T00:00:00Z", note="four"), vec(0.05, 1.0, 0.0)),
    (record("https://b2.example/", "2021-05-01T00:00:00Z", note="five"), vec(0.1, 1.0, 0.03)),
    (record("https://b3.example/", "2021-06-01T00:00:00Z", note="six"), vec(0.2, 1.0, 0.01)),
]
NEW = (record("https://a4.example/", "2022-01-01T00:00:00Z", note="seven"), vec(1.0, 0.07, 0.015))
K = 3


def world(entries=LINKS):
    """Links, a head and stars as the one-shot would leave them, and a cache."""
    links = {r["id"]: r for r, _ in entries}
    cache = vectors.Cache()
    for r, v in entries:
        cache.put(r["id"], vectors.digest(vectors.text(r)), v)
    ids = sky._order(links)
    vecs = [cache.vector(i) for i in ids]
    keys = [vectors.same_url_key(links[i]) for i in ids]
    stars = {}
    for n, i in enumerate(ids):
        a_side = links[i]["url"].startswith("https://a")
        stars[i] = {
            "topic": 0 if a_side else 1,
            "meaning": [10.0 + n, 0.0, 0.0] if a_side else [-10.0 - n, 0.0, 0.0],
            "time": [5.0 + n, 0.0] if a_side else [-5.0 - n, 0.0],
            "neighbors": vectors.nearest(n, ids, vecs, keys, K),
        }
    topics = [
        {"id": 0, "meaning": [10.0, 0.0, 0.0], "time": [5.0, 0.0, 2019.0, 2020.5]},
        {"id": 1, "meaning": [-10.0, 0.0, 0.0], "time": [-5.0, 0.0, 2020.3, 2021.5]},
    ]
    head = sky.head(topics) | {"neighbors": K}
    return links, head, stars, cache


class TextRecipe(unittest.TestCase):
    def test_note_is_cleaned_and_title_trimmed(self):
        link = record(
            "https://x.example/a",
            "2020-01-01T00:00:00Z",
            title="The Slow Web | Jack Cheng",
            note="> A quote with [a link](https://y.example/) and <b>bold</b> https://z.example/q",
        )
        self.assertEqual(vectors.text(link), "The Slow Web\n\nA quote with a link and bold")

    def test_no_note_uses_the_path_words(self):
        link = record("https://x.example/2019/05/the-small-web-is-back.html", "2020-01-01T00:00:00Z", title="Home")
        self.assertEqual(vectors.text(link), "Home\n\nthe small web is back")

    def test_never_the_date_host_or_issue(self):
        link = record("https://unique-host.example/", "2011-11-11T00:00:00Z", note="words")
        self.assertNotIn("unique-host", vectors.text(link))
        self.assertNotIn("2011", vectors.text(link))


class Neighbours(unittest.TestCase):
    def test_a_second_save_of_the_same_url_is_never_a_neighbour(self):
        first = record("http://www.same.example/page/", "2019-01-01T00:00:00Z", note="x")
        second = record("https://same.example/page", "2020-01-01T00:00:00Z", note="y")
        other = record("https://other.example/", "2020-01-01T00:00:00Z", note="z")
        links = {r["id"]: r for r in (first, second, other)}
        ids = sky._order(links)
        vecs = [vectors.unit(vec(1.0)), vectors.unit(vec(1.0, 0.01)), vectors.unit(vec(0.5, 0.5))]
        keys = [vectors.same_url_key(links[i]) for i in ids]
        self.assertEqual(vectors.nearest(0, ids, vecs, keys, 2), [other["id"]])


class Update(unittest.TestCase):
    def test_nothing_changes_when_nothing_arrives(self):
        links, head, stars, cache = world()
        before = copy.deepcopy(stars)
        result = sky.update(links, head, stars, cache, embed_texts=lambda texts: self.fail("embedded"))
        self.assertEqual(stars, before)
        self.assertIsNone(result.failure)

    def test_a_new_link_is_placed_beside_its_neighbours_and_enters_their_lists(self):
        links, head, stars, cache = world()
        links[NEW[0]["id"]] = NEW[0]
        result = sky.update(links, head, stars, cache, embed_texts=lambda texts: [NEW[1]])
        star = stars[NEW[0]["id"]]
        self.assertEqual(result.new, 1)
        self.assertEqual(star["topic"], 0)
        a_ids = {r["id"] for r, _ in LINKS if r["url"].startswith("https://a")}
        self.assertTrue(set(star["neighbors"]) <= a_ids)
        self.assertGreater(star["meaning"][0], 5)
        # It is nearer to a1 and a2 than a3 is, so it enters their lists.
        a1 = link_id("https://a1.example/")
        self.assertIn(NEW[0]["id"], stars[a1]["neighbors"])
        # The full computation agrees with the incremental one everywhere.
        expected_links, _, expected, _ = world(LINKS + [NEW])
        for i in expected:
            self.assertEqual(stars[i]["neighbors"], expected[i]["neighbors"], i)

    def test_a_link_made_private_leaves_even_when_bedrock_fails(self):
        links, head, stars, cache = world()
        gone = link_id("https://b2.example/")
        del links[gone]
        links[NEW[0]["id"]] = NEW[0]

        def broken(texts):
            raise vectors.VectorError("throttled")

        result = sky.update(links, head, stars, cache, embed_texts=broken)
        self.assertNotIn(gone, stars)
        self.assertFalse(any(gone in s["neighbors"] for s in stars.values()))
        self.assertNotIn(NEW[0]["id"], stars)
        self.assertEqual(result.waiting, 1)
        self.assertEqual(result.failure, "throttled")

    def test_a_removed_neighbour_is_refilled(self):
        links, head, stars, cache = world()
        gone = link_id("https://a2.example/")
        del links[gone]
        result = sky.update(links, head, stars, cache, embed_texts=lambda texts: [])
        self.assertGreater(result.refilled, 0)
        self.assertTrue(all(len(s["neighbors"]) == K for s in stars.values()))
        self.assertFalse(any(gone in s["neighbors"] for s in stars.values()))

    def test_an_edited_note_is_embedded_again_and_the_star_does_not_move(self):
        links, head, stars, cache = world()
        edited = link_id("https://a3.example/")
        place = (stars[edited]["topic"], stars[edited]["meaning"], stars[edited]["time"])
        links[edited] = dict(links[edited], note="now about the second thing")
        result = sky.update(links, head, stars, cache, embed_texts=lambda texts: [vec(0.0, 1.0, 0.5)])
        self.assertEqual(result.edited, 1)
        self.assertEqual((stars[edited]["topic"], stars[edited]["meaning"], stars[edited]["time"]), place)
        b_ids = {r["id"] for r, _ in LINKS if r["url"].startswith("https://b")}
        self.assertTrue(set(stars[edited]["neighbors"]) <= b_ids)

    def test_placement_is_the_same_every_run(self):
        points = [[1.0, 2.0, 3.0], [1.5, 2.5, 3.5], [40.0, 0.0, 0.0]]
        self.assertEqual(sky.place(points, "abc"), sky.place(points, "abc"))
        # The medoid anchors it, so the far point pulls it only a little.
        spot = sky.place(points, "abc")
        self.assertLess(abs(spot[0] - 1.5), 15)


class Disk(unittest.TestCase):
    def test_write_and_load_round_trip_one_shard_per_year(self):
        links, head, stars, _ = world()
        with tempfile.TemporaryDirectory() as tmp:
            sky.write(tmp, head, stars, links)
            self.assertEqual(sorted(p.name for p in (Path(tmp) / "derived" / "sky").iterdir()),
                             ["2019.json", "2020.json", "2021.json"])
            self.assertEqual(sky.load(tmp), (head, stars))

    def test_cache_round_trip_and_another_recipe_is_refused(self):
        _, _, _, cache = world()
        with tempfile.TemporaryDirectory() as tmp:
            cache.save(tmp)
            back = vectors.Cache.load(tmp)
            self.assertEqual(back.rows, cache.rows)
            self.assertEqual(list(back.vectors[0]), list(cache.vectors[0]))
            head = json.loads((Path(tmp) / "vectors.json").read_text())
            head["recipe"] = vectors.RECIPE + 1
            (Path(tmp) / "vectors.json").write_text(json.dumps(head))
            self.assertEqual(len(vectors.Cache.load(tmp)), 0)

    def test_rows_that_do_not_match_the_head_are_no_cache(self):
        # A run that died between the two writes: the rows were rewritten in
        # another order but the head is the old one.
        _, _, _, cache = world()
        with tempfile.TemporaryDirectory() as tmp:
            cache.save(tmp)
            head = (Path(tmp) / "vectors.json").read_bytes()
            cache.rows.reverse()
            cache.vectors.reverse()
            cache.save(tmp)
            (Path(tmp) / "vectors.json").write_bytes(head)
            self.assertEqual(len(vectors.Cache.load(tmp)), 0)


class Bedrock(unittest.TestCase):
    def fake(self, arn="arn:aws:sts::999153317627:assumed-role/ProjectsCloudEngineer/projects-cloud-engineer"):
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[1] == "sts":
                return subprocess.CompletedProcess(command, 0, json.dumps({"Account": arn.split(":")[4], "Arn": arn}), "")
            body = json.loads(Path(command[command.index("--body") + 1][len("fileb://"):]).read_text())
            Path(command[command.index("--body") + 2]).write_text(json.dumps({"embeddings": [vec(1.0)] * len(body["texts"])}))
            return subprocess.CompletedProcess(command, 0, "{}", "")

        return run, calls

    def test_batches_of_96_as_cloud_engineer(self):
        run, calls = self.fake()
        vectors.check_identity(run)
        made = vectors.embed([f"text {n}" for n in range(100)], run)
        self.assertEqual(len(made), 100)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all("--profile" in c and "cloud-engineer" in c for c in calls))

    def test_another_identity_is_refused(self):
        run, _ = self.fake("arn:aws:sts::999153317627:assumed-role/Jamie/jamie")
        with self.assertRaises(vectors.VectorError):
            vectors.check_identity(run)


class Validate(unittest.TestCase):
    def check(self, mutate):
        links, head, stars, _ = world()
        mutate(links, stars)
        with tempfile.TemporaryDirectory() as tmp:
            sky.write(tmp, head, stars, {**links, **{i: {"saved": "2019"} for i in stars if i not in links}})
            report = Report()
            check_sky(report, tmp, links)
            return report.errors

    def test_the_sky_from_the_tools_is_valid(self):
        self.assertEqual(self.check(lambda links, stars: None), [])

    def test_a_star_for_a_link_that_is_not_public_fails(self):
        gone = link_id("https://b1.example/")
        errors = self.check(lambda links, stars: links.pop(gone))
        self.assertTrue(any("not public" in e for e in errors), errors)

    def test_a_neighbour_that_is_not_public_fails(self):
        def mutate(links, stars):
            next(iter(stars.values()))["neighbors"][0] = "0123456789ab"

        errors = self.check(mutate)
        self.assertTrue(any("is not a public link" in e for e in errors), errors)


if __name__ == "__main__":
    unittest.main()
