#!/usr/bin/env python3
"""Fail (exit 1) when anything under data/ breaks docs/DATA.md.

Checks every links record (fields and their order, id and hash against the
URL, year file, sort order, types, uniqueness), issues.json (fields, ids that
exist, positions, order), data/sync.json, the enrichment shards (keys that are
public hosts or ids, filed in the right shard, only the contract's fields, no
string over 2,000 characters, images that exist) and public/media/ (only images
a facts record names), and scans every data file for anything that looks like
a credential, and the sky (every star a public link's, its neighbours public
links too). With the raw export at hand (pinboard/posts_all.json), also
proves no record is a private bookmark.
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR, RAW_EXPORT  # noqa: E402
from linking.validate import validate  # noqa: E402

MAX_LISTED = 50


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DATA_DIR, help="the data directory (default: data/)")
    parser.add_argument(
        "--raw",
        type=Path,
        default=RAW_EXPORT,
        help="the raw export for the private-bookmark check, skipped when absent "
        "(default: pinboard/posts_all.json)",
    )
    parser.add_argument(
        "--media",
        type=Path,
        default=None,
        help="the images enrich_facts.py writes (default: public/media/ beside the data directory)",
    )
    args = parser.parse_args(argv)
    token = os.environ.get("PINBOARD_API_TOKEN") or None
    report, summary = validate(args.data, raw_path=args.raw, token=token, media_dir=args.media)
    for line in report.errors[:MAX_LISTED]:
        print(f"validate_data: {line}", file=sys.stderr)
    if len(report.errors) > MAX_LISTED:
        print(f"validate_data: ... and {len(report.errors) - MAX_LISTED} more", file=sys.stderr)
    private = "checked against the raw export" if summary["private_checked"] else "raw export absent, not checked"
    status = "ok" if report.ok else f"FAILED with {len(report.errors)} problem(s)"
    print(
        f"validate_data: {status}: {summary['links']:,} links, {summary['years']} years, "
        f"{summary['issues']:,} issues, {summary['linked_ids']:,} linked ids, "
        f"{summary['unmatched']:,} unmatched rows; enrichment {summary['hosts']:,} hosts, "
        f"{summary['pages']:,} pages, {summary['facts']:,} facts, {summary['images']:,} images; "
        f"sky {summary['stars']:,} stars, {summary['starless']:,} waiting; "
        f"private bookmarks {private}"
    )
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
