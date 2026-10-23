#!/usr/bin/env python3
"""Join The Weekly Thing's issue links to the saved links: data/derived/issues.json.

Reads the issue pages' front matter and data/links/<yyyy>.json; writes nothing
else and calls no network. See tools/README.md and docs/DATA.md.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR, ROOT, jsonio  # noqa: E402
from linking.issues import IssueError, build, summary  # noqa: E402

DEFAULT_ARCHIVE = ROOT.parent / "thingelstad.com" / "weekly.thingelstad.com" / "apps" / "site" / "archive"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--archive",
        type=Path,
        default=DEFAULT_ARCHIVE,
        help="the issue pages, weekly.thingelstad.com/apps/site/archive (default: the sibling checkout)",
    )
    parser.add_argument(
        "--links", type=Path, default=DATA_DIR / "links", help="the links shards (default: data/links)"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR / "derived" / "issues.json",
        help="where to write (default: data/derived/issues.json)",
    )
    args = parser.parse_args(argv)
    if not args.archive.is_dir():
        print(f"join_issues: no issue archive at {args.archive} (pass --archive)", file=sys.stderr)
        return 1
    try:
        document = build(args.archive, args.links)
    except IssueError as error:
        print(f"join_issues: {error}", file=sys.stderr)
        return 1
    changed = jsonio.write_json(args.out, document)
    counts = summary(document)
    print(
        f"join_issues: {counts['issues']:,} issues, {counts['rows']:,} link rows, "
        f"{counts['linked_ids']:,} linked ids, {counts['unmatched']:,} unmatched rows; "
        f"{args.out} {'written' if changed else 'unchanged'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
