"""Checks that the sky keeps docs/DATA.md ("The sky"): the head, and every star a
public link's, filed in its year, with a topic, two places and at most the
head's number of neighbours, all public links too. A link with no star yet is allowed: it
waits for its vector, and the site leaves it out of the sky until then.
"""

import json
import math
from pathlib import Path

from . import jsonio
from .sky import HEAD_KEYS, SHARD, STAR_KEYS, VERSION


def _points(value, size):
    return (
        isinstance(value, list)
        and len(value) == size
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)
    )


def check_sky(report, data_dir, by_id):
    """Returns (stars, public links without a star)."""
    head_path = Path(data_dir) / "derived" / "sky.json"
    directory = Path(data_dir) / "derived" / "sky"
    shards = sorted(directory.glob("*")) if directory.is_dir() else []
    if not head_path.exists():
        if shards:
            report.error(str(directory), "stars without data/derived/sky.json")
        return 0, len(by_id)
    text = head_path.read_text(encoding="utf-8")
    try:
        head = json.loads(text)
    except ValueError as error:
        report.error(str(head_path), f"not JSON ({error})")
        return 0, len(by_id)
    if text != jsonio.dumps(head):
        report.error(str(head_path), "not in the canonical format (indent 1, UTF-8, trailing newline)")
    if not isinstance(head, dict) or tuple(head) != HEAD_KEYS:
        report.error(str(head_path), f"fields must be {', '.join(HEAD_KEYS)}, in that order")
        return 0, len(by_id)
    if head["version"] != VERSION or head["method"] != "tools/sky.py":
        report.error(str(head_path), f"method must be tools/sky.py and version {VERSION}")
    k = head["neighbors"]
    if not isinstance(k, int) or isinstance(k, bool) or k < 1:
        report.error(str(head_path), "neighbors must be a whole number, the length of a full list")
        k = 10
    topics = head["topics"]
    if not isinstance(topics, list) or not topics:
        report.error(str(head_path), "topics must be a non-empty list")
        topics = []
    for n, topic in enumerate(topics):
        where = f"{head_path}: topic {n}"
        if not isinstance(topic, dict) or list(topic) != ["id", "meaning", "time"] or topic["id"] != n:
            report.error(where, "must be {id, meaning, time} with ids 0, 1, 2 in order")
            continue
        if not _points(topic["meaning"], 3):
            report.error(where, "meaning must be three finite numbers")
        if not _points(topic["time"], 4) or topic["time"][2] > topic["time"][3]:
            report.error(where, "time must be x, y and the years it runs from and to")

    stars = 0
    for path in shards:
        match = SHARD.fullmatch(path.name)
        if not match:
            report.error(str(path), "not a <yyyy>.json shard")
            continue
        year = match.group(1)
        text = path.read_text(encoding="utf-8")
        try:
            shard = json.loads(text)
        except ValueError as error:
            report.error(str(path), f"not JSON ({error})")
            continue
        if not isinstance(shard, dict) or not shard:
            report.error(str(path), "must be a non-empty object keyed by link id")
            continue
        if text != jsonio.dumps(shard) or list(shard) != sorted(shard):
            report.error(str(path), "not in the canonical format with sorted keys")
        for link_id, star in shard.items():
            where = f"{path.name}: {link_id}"
            record = by_id.get(link_id)
            if record is None:
                report.error(where, "a star for a link that is not public")
                continue
            if record["saved"][:4] != year:
                report.error(where, f"filed under {year}, saved in {record['saved'][:4]}")
            if not isinstance(star, dict) or tuple(star) != STAR_KEYS:
                report.error(where, f"fields must be {', '.join(STAR_KEYS)}, in that order")
                continue
            stars += 1
            topic = star["topic"]
            if not isinstance(topic, int) or isinstance(topic, bool) or not 0 <= topic < len(topics):
                report.error(where, "topic is not one of the head's topics")
            if not _points(star["meaning"], 3):
                report.error(where, "meaning must be three finite numbers")
            if not _points(star["time"], 2):
                report.error(where, "time must be two finite numbers")
            neighbors = star["neighbors"]
            if (
                not isinstance(neighbors, list)
                or len(neighbors) > k
                or len(set(neighbors)) != len(neighbors)
                or link_id in neighbors
            ):
                report.error(where, f"neighbors must be at most {k} distinct other ids")
                continue
            for other in neighbors:
                if other not in by_id:
                    report.error(where, f"neighbour {other} is not a public link")
    return stars, len(by_id) - stars
