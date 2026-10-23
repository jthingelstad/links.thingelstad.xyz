"""The enrichment shards: load, merge, prune and write (docs/DATA.md).

Each shard is a JSON object keyed by host or link id, keys sorted, written in
the canonical format through jsonio (atomic, and untouched when the bytes would
not change). A run loads every existing shard, so a record whose key is no
longer a public host or link is dropped (a bookmark made private must not keep
its observations in public), and a record filed in the wrong shard is moved.
"""

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import jsonio

VERSION = 1
STAMP_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


class ShardError(Exception):
    """A shard on disk is not what the contract says; nothing is written."""


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def stamp(when):
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_stamp(text):
    if not isinstance(text, str) or not STAMP_RE.fullmatch(text):
        return None
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def age_days(record_stamp, now):
    """Days since a checked stamp, or None when there is no usable stamp."""
    when = parse_stamp(record_stamp)
    if when is None:
        return None
    return (now - when) / timedelta(days=1)


class Store:
    """Every record of one shard directory, by key.

    expected maps each valid key to its shard name (the file stem). name_re is
    the shard file name pattern; other files in the directory are left alone.
    """

    def __init__(self, directory, expected, name_re):
        self.directory = Path(directory)
        self.expected = expected
        self.name_re = re.compile(name_re)
        self.shards = {}  # shard name -> {key: record}
        self.dirty = set()
        self.dropped = 0
        self.moved = 0
        self.ignored = []

    def load(self):
        if not self.directory.is_dir():
            return self
        found = {}
        for path in sorted(self.directory.iterdir()):
            if path.name.startswith(".") or not path.is_file():
                continue
            if not self.name_re.fullmatch(path.name):
                self.ignored.append(path.name)
                continue
            try:
                value = jsonio.load(path)
            except ValueError as error:
                raise ShardError(f"{path}: not JSON ({error})") from None
            if not isinstance(value, dict):
                raise ShardError(f"{path}: a shard is a JSON object keyed by host or id")
            found[path.stem] = value
        for name, records in found.items():
            self.shards.setdefault(name, {})
            for key, record in records.items():
                want = self.expected.get(key)
                if want is None:
                    self.dropped += 1
                    self.dirty.add(name)
                    continue
                if want != name:
                    self.moved += 1
                    self.dirty.update((name, want))
                    self.shards.setdefault(want, {})[key] = record
                    continue
                self.shards[name][key] = record
        return self

    def get(self, key):
        name = self.expected.get(key)
        if name is None:
            return None
        return self.shards.get(name, {}).get(key)

    def records(self):
        for records in self.shards.values():
            yield from records.items()

    def put(self, key, record):
        name = self.expected[key]
        self.shards.setdefault(name, {})[key] = record
        self.dirty.add(name)

    def flush(self):
        """Write every changed shard. Returns the names of files whose bytes changed."""
        written = []
        for name in sorted(self.dirty):
            path = self.directory / f"{name}.json"
            records = self.shards.get(name, {})
            if not records:
                if path.exists():
                    path.unlink()
                    written.append(name)
                continue
            if jsonio.write_json(path, dict(sorted(records.items()))):
                written.append(name)
        self.dirty.clear()
        return written
