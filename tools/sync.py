#!/usr/bin/env python3
"""Mirror the public Pinboard bookmarks into data/links/<yyyy>.json.

Live: calls posts/update, and posts/all only when the update stamp moved (or
with --force), never more than once per five minutes. Offline (--from): writes
the shards from a saved posts/all export with no network call. The token is
read from PINBOARD_API_TOKEN and never printed. See tools/README.md.
"""

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR, RAW_EXPORT, jsonio  # noqa: E402
from linking import pinboard as pb  # noqa: E402

EXIT_OK, EXIT_ERROR, EXIT_RATE_LIMITED = 0, 1, 3
MAX_SHRINK = 0.10  # refuse an export that loses more than a tenth of the public links


def log(message):
    print(f"sync: {message}")


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def write_mirror(posts, data_dir):
    """Write the public shards. Returns (public count, total count)."""
    years = pb.shard(posts)
    changed, removed = pb.write_shards(data_dir / "links", years)
    public = sum(len(records) for records in years.values())
    log(
        f"{public:,} public of {len(posts):,} bookmarks in {len(years)} years; "
        f"rewrote {len(changed)} year file(s){', removed ' + ', '.join(removed) if removed else ''}"
    )
    return public, len(posts)


def offline(args):
    source = args.source.resolve()
    raw = source.read_bytes()
    posts = pb.parse_posts(raw)
    state_path = args.data / "sync.json"
    state = pb.read_state(state_path)
    public, total = write_mirror(posts, args.data)
    fetched_at = state["fetched_at"]
    if fetched_at is None:
        # First run from an export the live sync did not record: its file
        # time is when it was fetched.
        fetched_at = pb.utc_stamp(datetime.fromtimestamp(source.stat().st_mtime, timezone.utc))
    pb.write_state(state_path, state["updated"], fetched_at, public, total)
    log(f"offline from {source.name}; no network call made; state {state_path}")
    return EXIT_OK


def check_shrink(posts, state, allow_shrink):
    previous = state.get("public")
    if not previous or allow_shrink:
        return
    public = sum(1 for post in posts if pb.is_public(post))
    if public < previous * (1 - MAX_SHRINK):
        raise pb.SyncError(
            f"the export has {public:,} public bookmarks, down from {previous:,}; "
            "nothing written (pass --allow-shrink if that is real)"
        )


def live(args, client, now=now_utc):
    state_path = args.data / "sync.json"
    marker = args.raw.parent / ".posts_all_called_at"
    state = pb.read_state(state_path)

    def refuse_if_too_soon():
        wait = pb.posts_all_wait(state, marker, now())
        if wait:
            log(
                f"posts/all was called less than five minutes ago (Pinboard's limit); "
                f"refusing, try again in {wait} s"
            )
            return True
        return False

    if args.force and not args.check and refuse_if_too_soon():
        return EXIT_RATE_LIMITED
    stamp = client.posts_update()
    recorded = state["updated"]
    moved = stamp != recorded
    log(f"posts/update: {stamp} (recorded: {recorded or 'none'}){'' if moved else ', unchanged'}")
    if args.check:
        if moved or args.force:
            wait = pb.posts_all_wait(state, marker, now())
            log("a sync would call posts/all" + (f" in {wait} s (five-minute limit)" if wait else " now"))
        else:
            log("a sync would not call posts/all")
        return EXIT_OK
    if not moved and not args.force:
        log("nothing changed at Pinboard; no posts/all call")
        return EXIT_OK
    if refuse_if_too_soon():
        return EXIT_RATE_LIMITED
    called_at = pb.utc_stamp(now())
    marker.parent.mkdir(parents=True, exist_ok=True)
    jsonio.write_bytes_atomic(marker, (called_at + "\n").encode("ascii"), mode=0o600)
    raw = client.posts_all()
    posts = pb.parse_posts(raw)
    check_shrink(posts, state, args.allow_shrink)
    # The raw export holds the private bookmarks: owner-only, outside data/.
    jsonio.write_bytes_atomic(args.raw, raw, mode=0o600)
    log(f"posts/all: {len(raw):,} bytes saved to {args.raw}")
    public, total = write_mirror(posts, args.data)
    pb.write_state(state_path, stamp, called_at, public, total)
    log(f"state {state_path}: updated {stamp}, fetched_at {called_at}")
    return EXIT_OK


def main(argv=None, client_factory=pb.PinboardClient, now=now_utc):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--from",
        dest="source",
        type=Path,
        help="offline: write the shards from this posts/all export; no network call",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="call posts/update only and say whether a sync would pull; write nothing",
    )
    parser.add_argument(
        "--force", action="store_true", help="call posts/all even when the update stamp has not moved"
    )
    parser.add_argument(
        "--allow-shrink",
        action="store_true",
        help="write an export even when it loses more than a tenth of the public links",
    )
    parser.add_argument(
        "--data", type=Path, default=DATA_DIR, help="the data directory (default: data/)"
    )
    parser.add_argument(
        "--raw",
        type=Path,
        default=RAW_EXPORT,
        help="where the live sync saves the raw export (default: pinboard/posts_all.json)",
    )
    args = parser.parse_args(argv)
    if args.source and (args.check or args.force):
        parser.error("--from is offline; it takes neither --check nor --force")

    data_dir = args.data.resolve()
    raw_path = args.raw.resolve()
    if raw_path == data_dir or data_dir in raw_path.parents:
        log("refusing: the raw export holds private bookmarks and may not be written under the data directory")
        return EXIT_ERROR
    args.data, args.raw = data_dir, raw_path

    token = os.environ.get("PINBOARD_API_TOKEN", "")
    try:
        if args.source:
            return offline(args)
        if not token:
            log("PINBOARD_API_TOKEN is not set (source .env first, or use --from for offline)")
            return EXIT_ERROR
        return live(args, client_factory(token), now)
    except (pb.PinboardError, pb.SyncError) as error:
        log(f"error: {pb.redact(error, token)}")
        return EXIT_ERROR
    except Exception as error:  # noqa: BLE001 - never let a traceback echo a request
        log(f"error: {type(error).__name__}: {pb.redact(error, token)}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
