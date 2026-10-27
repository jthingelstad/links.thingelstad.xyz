#!/usr/bin/env python3
"""Add verified public records captured by sync, without a full-account sync.

The private raw export and its credential stay on the Mac. This command
accepts only hash-addressed public captures from the dedicated private inbox.
It never runs enrichment or the Weekly Thing issue join.
"""

import argparse
import hashlib
import json
from pathlib import Path

from linking import jsonio
from linking.pinboard import SyncError, parse_posts, parse_stamp, read_state, shard
from linking.validate import Report, check_record

LEDGER = "data/derived/bookmarks.json"


def import_bookmarks(root, inbox):
    root, inbox = Path(root), Path(inbox)
    ledger_path = root / LEDGER
    ledger = jsonio.load(ledger_path) if ledger_path.exists() else {"version": 1, "captures": {}}
    if ledger.get("version") != 1 or not isinstance(ledger.get("captures"), dict):
        raise SyncError("unsupported bookmark capture ledger")
    state = read_state(root / "data/sync.json")
    years = {p.stem: jsonio.load(p) for p in sorted((root / "data/links").glob("[0-9][0-9][0-9][0-9].json"))}
    by_id = {record["id"]: record for records in years.values() for record in records}
    additions = []
    # Validate the whole batch before writing any data. Filenames bind the
    # bytes to the immutable capture the sender checkpointed.
    for path in sorted(inbox.glob("*.json")):
        if path.stem in ledger["captures"]:
            continue
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != path.stem:
            raise SyncError("capture digest does not match its name")
        capture = json.loads(raw)
        if capture.get("version") != 1:
            raise SyncError("unsupported bookmark capture")
        star = capture["star"]
        if not isinstance(star.get("id"), str) or not star["id"].isdigit():
            raise SyncError("invalid Feedbin identity")
        observed = parse_stamp(capture["observed_at"])
        posts = parse_posts(json.dumps([capture["post"]]))
        if posts[0]["shared"] != "yes" or posts[0]["href"] != star.get("url"):
            raise SyncError("capture is not an exact public bookmark")
        records = [record for group in shard(posts).values() for record in group]
        record = records[0]
        report = Report()
        check_record(report, "capture", record, record["saved"][:4])
        if not report.ok or posts[0]["toread"] not in ("yes", "no"):
            raise SyncError("capture does not meet the record contract")
        existing = by_id.get(record["id"])
        if existing and existing["url"] != record["url"]:
            raise SyncError("bookmark identity collision")
        # A newer full mirror is authoritative for deletion/privacy. Replaying
        # an older additive capture must never resurrect a removed bookmark.
        stale = not existing and state["fetched_at"] and observed <= parse_stamp(state["fetched_at"])
        ledger["captures"][path.stem] = {
            "id": star["id"], "url": star["url"], "link_id": record["id"],
            "observed_at": capture["observed_at"], "imported": not bool(stale),
            "record": record,
        }
        if not existing and not stale:
            additions.append(record)
            by_id[record["id"]] = record
        # Existing canonical records keep all fields, including later edits.
    jsonio.write_json(ledger_path, ledger)
    return len(additions)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--inbox", required=True)
    args = parser.parse_args()
    try:
        print(f"Imported {import_bookmarks(args.root, args.inbox)} public bookmarks.")
    except (SyncError, ValueError, KeyError, TypeError, IndexError):
        parser.exit(1, "Invalid public bookmark capture; no publication attempted.\n")
