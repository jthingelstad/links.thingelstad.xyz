"""The additive public inbox alongside the canonical nightly snapshot."""

from pathlib import Path

from . import jsonio


def merge_bookmarks(links, data):
    """Canonical records win. A newer full snapshot retires absent captures.

    A later full snapshot therefore controls edits, privacy and deletions;
    old captures cannot resurrect an absent record.
    """
    data = Path(data)
    path = data / "derived/bookmarks.json"
    if not path.exists():
        return links
    ledger = jsonio.load(path)
    state = jsonio.load(data / "sync.json")
    by_id = {link["id"]: link for link in links}
    for capture in ledger["captures"].values():
        record = capture["record"]
        if capture["imported"] and capture["observed_at"] > (state["fetched_at"] or ""):
            by_id.setdefault(record["id"], record)
    return sorted(by_id.values(), key=lambda record: (record["saved"], record["id"]))
