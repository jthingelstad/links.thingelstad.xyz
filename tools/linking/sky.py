"""The sky: every public link as a star (docs/DATA.md, "The sky").

A star is a link's topic, its places in the two layouts and its ten nearest
neighbours. The layouts are frozen: tools/one-shot/sky_layout.py made them once
from the vectors, and a link that arrives later is placed beside its
neighbours, so no star ever moves and a topic never changes under a reader.

- Meaning: three dimensions, links that say similar things close together.
- Time: two dimensions of meaning across, and the day saved as depth, which
  the site draws (the day is the link's own, so it is not stored here).

On disk: data/derived/sky.json (the versions and each topic's label point) and
data/derived/sky/<yyyy>.json, the stars keyed by link id and filed by the year
of the link's own file under data/links/.
"""

import hashlib
import math
import operator
import re
from pathlib import Path

from . import jsonio, vectors

VERSION = 1
LAYOUT = 1
HEAD_KEYS = ("method", "version", "model", "recipe", "layout", "neighbors", "topics")
STAR_KEYS = ("topic", "meaning", "time", "neighbors")
SHARD = re.compile(r"(\d{4})\.json")
# How far a new star sits from the point its neighbours give it: about the
# distance from a star to its nearest one in the Meaning layout (median 1.6).
JITTER = 1.0
PLACE_FROM = 5


class SkyError(Exception):
    """The sky on disk is not what the contract says; nothing is written."""


def head_path(data_dir):
    return Path(data_dir) / "derived" / "sky.json"


def shard_dir(data_dir):
    return Path(data_dir) / "derived" / "sky"


def load_links(data_dir):
    """{id: record} for every public link, in the order of the year files."""
    links = {}
    for path in sorted((Path(data_dir) / "links").glob("*.json")):
        for record in jsonio.load(path):
            links[record["id"]] = record
    return links


def load(data_dir):
    """(head, stars), or (None, {}) when the sky has not been made yet."""
    try:
        head = jsonio.load(head_path(data_dir))
    except FileNotFoundError:
        return None, {}
    if not isinstance(head, dict) or tuple(head) != HEAD_KEYS or head["version"] != VERSION:
        raise SkyError(f"{head_path(data_dir)}: not a version {VERSION} sky head")
    stars = {}
    for path in sorted(shard_dir(data_dir).glob("*.json")):
        if not SHARD.fullmatch(path.name):
            raise SkyError(f"{path}: not a <yyyy>.json shard")
        shard = jsonio.load(path)
        if not isinstance(shard, dict):
            raise SkyError(f"{path}: not an object")
        for link_id, star in shard.items():
            if not isinstance(star, dict) or tuple(star) != STAR_KEYS:
                raise SkyError(f"{path}: {link_id} is not a star")
            stars[link_id] = star
    return head, stars


def write(data_dir, head, stars, links):
    """Write the head and one shard per year. Returns the files that changed."""
    changed = []
    if jsonio.write_json(head_path(data_dir), head):
        changed.append(head_path(data_dir))
    by_year = {}
    for link_id in sorted(stars):
        by_year.setdefault(links[link_id]["saved"][:4], {})[link_id] = stars[link_id]
    directory = shard_dir(data_dir)
    for year, shard in sorted(by_year.items()):
        path = directory / f"{year}.json"
        if jsonio.write_json(path, shard):
            changed.append(path)
    for path in sorted(directory.glob("*.json")):
        match = SHARD.fullmatch(path.name)
        if match and match.group(1) not in by_year:
            path.unlink()
            changed.append(path)
    return changed


def head(topics):
    return {
        "method": "tools/sky.py",
        "version": VERSION,
        "model": vectors.MODEL,
        "recipe": vectors.RECIPE,
        "layout": LAYOUT,
        "neighbors": vectors.NEIGHBOURS,
        "topics": topics,
    }


# ---------- placing a new star ----------


def _hash_unit(link_id, salt):
    value = int(hashlib.md5(f"{salt}:{link_id}".encode()).hexdigest()[:8], 16)
    return value / 0xFFFFFFFF


def jitter(link_id, dims):
    """A fixed small offset for a link, the same on every run."""
    angle = 2 * math.pi * _hash_unit(link_id, "angle")
    if dims == 2:
        return [JITTER * math.cos(angle), JITTER * math.sin(angle)]
    rise = 2 * _hash_unit(link_id, "rise") - 1
    flat = math.sqrt(max(0.0, 1 - rise * rise))
    return [JITTER * flat * math.cos(angle), JITTER * flat * math.sin(angle), JITTER * rise]


def place(points, link_id):
    """A spot beside the given neighbours' points, nearest first.

    The anchor is the medoid of the nearest five, the one closest to the rest,
    so a new star joins a real cluster rather than the empty middle of two
    where the layout tore a neighbourhood apart. It leans a little towards
    their mean and sits a fixed small step off it.
    """
    points = points[:PLACE_FROM]
    dims = len(points[0])
    medoid = min(points, key=lambda p: sum(math.dist(p, q) for q in points))
    mean = [sum(axis) / len(points) for axis in zip(*points)]
    offset = jitter(link_id, dims)
    return [round(m + 0.3 * (a - m) + o, 2) for m, a, o in zip(medoid, mean, offset)]


# ---------- the nightly update ----------


def _order(links):
    return sorted(links, key=lambda link_id: (links[link_id]["saved"], link_id))


class Update:
    def __init__(self):
        self.embedded = 0
        self.new = 0
        self.edited = 0
        self.removed = 0
        self.refilled = 0
        self.waiting = 0
        self.failure = None

    def summary(self, stars):
        parts = [
            f"{self.new:,} new",
            f"{self.edited:,} re-embedded",
            f"{self.removed:,} removed",
        ]
        if self.refilled:
            parts.append(f"{self.refilled:,} lists refilled")
        line = f"sky: {', '.join(parts)}; {stars:,} stars"
        if self.waiting:
            line += f", {self.waiting:,} links wait for a vector"
        if self.failure:
            line += f" ({self.failure})"
        return line


def update(links, sky_head, stars, cache, embed_texts=None):
    """Bring the stars up to date with the links, in place.

    embed_texts(list of str) -> list of vectors, or None for no network (a dry
    run). Removed links always leave the sky, even when Bedrock fails, so a
    bookmark made private never keeps its star. Returns an Update.
    """
    result = Update()
    k = sky_head["neighbors"]
    texts = {link_id: vectors.text(link) for link_id, link in links.items()}
    digests = {link_id: vectors.digest(value) for link_id, value in texts.items()}
    cache.keep(set(links))

    stale = [link_id for link_id in _order(links) if cache.digest_of(link_id) != digests[link_id]]
    fresh = []
    if stale and embed_texts is None:
        result.failure = "not embedded: no network"
    elif stale:
        try:
            made = embed_texts([texts[link_id] for link_id in stale])
            for link_id, vector in zip(stale, made, strict=True):
                cache.put(link_id, digests[link_id], vector)
            fresh = stale
            result.embedded = len(stale)
        except vectors.VectorError as error:
            result.failure = str(error)

    removed = sorted(link_id for link_id in stars if link_id not in links)
    for link_id in removed:
        del stars[link_id]
    result.removed = len(removed)
    gone = set(removed)
    for star in stars.values():
        if gone.intersection(star["neighbors"]):
            star["neighbors"] = [n for n in star["neighbors"] if n not in gone]

    waiting = [link_id for link_id in links if link_id not in cache]
    result.waiting = len(waiting)
    if waiting:
        # Neighbours are only worked out against every link; a link without a
        # vector waits, and so does everything that would be measured against it.
        return result

    ids = _order(links)
    row = {link_id: n for n, link_id in enumerate(ids)}
    vecs = [cache.vector(link_id) for link_id in ids]
    keys = [vectors.same_url_key(links[link_id]) for link_id in ids]
    changed = [link_id for link_id in fresh if link_id in stars]
    new = [link_id for link_id in ids if link_id not in stars]
    result.edited = len(changed)
    result.new = len(new)
    moved = set(changed)
    redo = set(new) | moved
    refill = {
        link_id
        for link_id, star in stars.items()
        if len(star["neighbors"]) < k or moved.intersection(star["neighbors"])
    } - redo
    result.refilled = len(refill)
    if not redo and not refill:
        return result

    lists = {}
    entrant_sims = {}
    for link_id in sorted(redo | refill, key=row.get):
        sims = vectors.similarities(vecs[row[link_id]], vecs)
        lists[link_id] = vectors.nearest(row[link_id], ids, vecs, keys, k, sims)
        if link_id in redo:
            entrant_sims[link_id] = sims

    # A new or re-embedded link enters any other list it now belongs in.
    if entrant_sims:
        for link_id, star in stars.items():
            if link_id in lists:
                continue
            me = row[link_id]
            current = star["neighbors"]
            last = math.sumprod(vecs[me], vecs[row[current[-1]]])
            entering = [
                e
                for e, sims in entrant_sims.items()
                if e != link_id and sims[me] > last and keys[row[e]] != keys[me] and e not in current
            ]
            if entering:
                pool = current + entering
                scored = sorted(
                    pool, key=lambda n: (-math.sumprod(vecs[me], vecs[row[n]]), row[n])
                )
                star["neighbors"] = scored[:k]

    for link_id in sorted(set(lists) & set(stars)):
        stars[link_id]["neighbors"] = lists[link_id]

    if new:
        centres = _centres(stars, row, vecs)
        for link_id in new:
            vector = vecs[row[link_id]]
            topic = max(
                centres,
                key=lambda t: (2 * math.sumprod(vector, centres[t][0]) - centres[t][1], -t),
            )
            placed = [n for n in lists[link_id] if n in stars]
            if placed:
                meaning = place([stars[n]["meaning"] for n in placed], link_id)
                time = place([stars[n]["time"] for n in placed], link_id)
            else:
                meaning = [round(v, 2) for v in jitter(link_id, 3)]
                time = [round(v, 2) for v in jitter(link_id, 2)]
            stars[link_id] = {
                "topic": topic,
                "meaning": meaning,
                "time": time,
                "neighbors": lists[link_id],
            }
    return result


def _centres(stars, row, vecs):
    """Each topic's mean vector and its squared length, so a new link joins the
    topic k-means would give it: the nearest mean."""
    sums = {}
    counts = {}
    for link_id, star in stars.items():
        topic = star["topic"]
        vector = vecs[row[link_id]]
        if topic in sums:
            sums[topic] = list(map(operator.add, sums[topic], vector))
            counts[topic] += 1
        else:
            sums[topic] = list(vector)
            counts[topic] = 1
    centres = {}
    for topic, total in sums.items():
        mean = [value / counts[topic] for value in total]
        centres[topic] = (mean, math.sumprod(mean, mean))
    return centres
