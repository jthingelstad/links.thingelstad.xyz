#!/usr/bin/env python3
"""Join The Weekly Thing's issue links to the saved links: data/derived/issues.json.

Fetches Weekly main into an isolated temporary repository and pins its source
revision before reading issue pages. --archive uses an explicit local source
without network. Writes only the derived join. See tools/README.md and docs/DATA.md.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR, jsonio  # noqa: E402
from linking.issues import IssueError, build, summary  # noqa: E402
from linking.weekly import ArchiveError, published_archive  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--archive",
        type=Path,
        help="explicit local issue archive (offline); default: isolated, pinned Weekly main",
    )
    parser.add_argument(
        "--links",
        type=Path,
        default=DATA_DIR / "links",
        help="the links shards (default: data/links)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR / "derived" / "issues.json",
        help="where to write (default: data/derived/issues.json)",
    )
    args = parser.parse_args(argv)
    if args.archive is not None and not args.archive.is_dir():
        print(f"join_issues: no issue archive at {args.archive} (pass --archive)", file=sys.stderr)
        return 1
    try:
        if args.archive is not None:
            document = build(args.archive, args.links)
            revision = None
        else:
            with published_archive() as (archive, revision):
                document = build(archive, args.links)
    except (IssueError, ArchiveError) as error:
        print(f"join_issues: {error}", file=sys.stderr)
        return 1
    changed = jsonio.write_json(args.out, document)
    counts = summary(document)
    print(
        f"join_issues: {counts['issues']:,} issues, {counts['rows']:,} link rows, "
        f"{counts['linked_ids']:,} linked ids, {counts['unmatched']:,} unmatched rows; "
        f"{args.out} {'written' if changed else 'unchanged'}"
        f"{f'; Weekly main {revision}' if revision else '; explicit local archive'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
