"""Make the sky once: the topics, the two frozen layouts and every neighbour list.

Run by hand, never by the nightly, and only when the vectors themselves change
(a new model or text recipe): every star moves and the topics are made again as
a new vocabulary, so content/topics.md is named again with them. Between those
times tools/sky.py places each new link beside its neighbours and nothing moves.

Needs numpy, scikit-learn and umap-learn, which the data tools otherwise never
use, so it runs from a venv of its own (tools/README.md, "sky_layout.py"):

  python3 -m venv ~/.venvs/links-sky
  ~/.venvs/links-sky/bin/pip install numpy==2.5.4 scikit-learn==1.9.1 umap-learn==0.5.12
  python3 -I tools/sky.py --embed-only
  ~/.venvs/links-sky/bin/python tools/one-shot/sky_layout.py

The first sky (2026-10-30) is the design spike's, made from the same vectors in
the same order with the same seeds and these library versions.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import umap
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from linking import DATA_DIR  # noqa: E402
from linking import sky, vectors  # noqa: E402

TOPICS = 100
SEED = 7
RADIUS = 100.0
DENSE = 6.0


def scaled(points):
    """Centred on the median and scaled so 98% of points lie within RADIUS."""
    points = points - np.median(points, 0)
    return points / np.percentile(np.linalg.norm(points, axis=1), 98) * RADIUS


def densest(points):
    """The member with the most other members within DENSE: where a topic's name
    goes, rather than its mean, which can fall in empty space."""
    d2 = ((points[:, None, :] - points[None, :, :]) ** 2).sum(-1)
    return int((d2 < DENSE**2).sum(1).argmax())


def year_of(saved):
    """A decimal year, for where a topic runs in the Time layout."""
    year, month, day = int(saved[:4]), int(saved[5:7]), int(saved[8:10])
    return year + ((month - 1) * 30.44 + day - 1) / 365.25


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DATA_DIR)
    parser.add_argument("--vectors", type=Path, default=None)
    args = parser.parse_args(argv)

    links = sky.load_links(args.data)
    cache = vectors.Cache.load(args.vectors or vectors.default_dir())
    ids = sky._order(links)
    stale = [i for i in ids if cache.digest_of(i) != vectors.digest(vectors.text(links[i]))]
    if stale:
        sys.exit(f"sky_layout: {len(stale):,} links have no current vector; run tools/sky.py --embed-only first")
    V = np.stack([np.frombuffer(cache.vector(i), dtype="<f4") for i in ids])
    n, k = len(ids), vectors.NEIGHBOURS
    keys = [vectors.same_url_key(links[i]) for i in ids]
    print(f"sky_layout: {n:,} links")

    # Neighbours by the same rule as tools/sky.py: cosine, nearest first, never
    # itself or another save of the same URL, ties to the earlier row.
    neighbours = []
    wide = V.astype(np.float64)  # as tools/sky.py measures: float64 sums of the float32 rows
    for start in range(0, n, 2000):
        block = wide[start : start + 2000] @ wide.T
        for offset, scores in enumerate(block):
            me = start + offset
            top = np.argpartition(-scores, 48)[:48]
            top = top[np.lexsort((top, -scores[top]))]
            kept = [int(j) for j in top if j != me and keys[j] != keys[me]][:k]
            neighbours.append([ids[j] for j in kept])

    labels = KMeans(n_clusters=TOPICS, n_init=4, random_state=SEED).fit(V).labels_
    reduced = PCA(n_components=50, random_state=SEED).fit_transform(V)
    flat = umap.UMAP(n_neighbors=20, min_dist=0.08, metric="cosine", random_state=SEED).fit_transform(reduced)
    reduced = PCA(n_components=50, random_state=SEED).fit_transform(V)
    deep = umap.UMAP(
        n_components=3, n_neighbors=20, min_dist=0.12, metric="cosine", random_state=SEED
    ).fit_transform(reduced)
    meaning = scaled(deep)
    time = scaled(flat)
    # Turn the flat map to lie as the deep one does seen from the front, so the
    # stars travel as little as they can between the two layouts.
    u, _, vt = np.linalg.svd(time.T @ meaning[:, :2])
    time = time @ (u @ vt)

    years = np.array([year_of(links[i]["saved"]) for i in ids])
    topics = []
    for t in range(TOPICS):
        members = np.where(labels == t)[0]
        here = members[densest(meaning[members])]
        there = members[densest(time[members])]
        low, high = np.percentile(years[members], [10, 90])
        topics.append(
            {
                "id": t,
                "meaning": [round(float(v), 2) for v in meaning[here]],
                "time": [round(float(v), 2) for v in time[there]] + [round(float(low), 1), round(float(high), 1)],
            }
        )
    stars = {
        ids[m]: {
            "topic": int(labels[m]),
            "meaning": [round(float(v), 2) for v in meaning[m]],
            "time": [round(float(v), 2) for v in time[m]],
            "neighbors": neighbours[m],
        }
        for m in range(n)
    }
    changed = sky.write(args.data, sky.head(topics), stars, links)
    sizes = np.bincount(labels)
    print(
        f"sky_layout: {TOPICS} topics ({sizes.min()} to {sizes.max()} links, median {int(np.median(sizes))}); "
        f"wrote {len(changed)} file(s)"
    )


if __name__ == "__main__":
    main()
