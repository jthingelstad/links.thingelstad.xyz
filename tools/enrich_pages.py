#!/usr/bin/env python3
"""Observe the saved pages: liveness and Wayback captures, into data/enrichment/pages/.

Incremental: links never observed come first, then dead ones checked a month
ago and live ones checked a quarter ago. Liveness is one GET per link (15 s
timeout, up to five redirects walked and recorded, at most 256 KB read and
dropped), one request a second per host; it stays in the tool and is not run
for the site. Wayback is one CDX request per link at a six-second pace;
--wayback-only picks links with no Wayback answer, then answers older than
90 days, whatever their liveness. Writes only under <data>/enrichment/pages/.
See tools/README.md.
"""

import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR, web  # noqa: E402
from linking import hosts as hs  # noqa: E402
from linking import pages as pg  # noqa: E402
from linking import wayback as wb  # noqa: E402
from linking.shards import ShardError, Store, now_utc  # noqa: E402

EXIT_OK, EXIT_ERROR = 0, 1
FLUSH_EVERY = 25
ID_RE = re.compile(r"[0-9a-f]{12}")


def log(message):
    print(f"enrich_pages: {message}", flush=True)


def split_ids(values):
    ids = []
    for value in values or []:
        ids.extend(part.strip() for part in value.split(",") if part.strip())
    return ids


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DATA_DIR, help="the data directory (default: data/)")
    parser.add_argument("--limit", type=int, metavar="N", help="observe at most N links")
    parser.add_argument("--year", metavar="YYYY", help="only links saved in this year")
    parser.add_argument("--ids", action="append", metavar="ID", help="these link ids, whatever their state (repeat or comma-separate)")
    parser.add_argument("--sample", type=int, metavar="N", help="N links spread evenly across the years")
    parser.add_argument(
        "--recheck-after",
        type=float,
        metavar="DAYS",
        help="recheck anything observed at least DAYS ago (default: dead after 30, alive after 90)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--no-wayback", action="store_true", help="liveness only")
    mode.add_argument(
        "--wayback-only",
        action="store_true",
        help="Wayback only: links with no Wayback answer first, in saved order, then answers older than 90 days",
    )
    parser.add_argument("--dry-run", action="store_true", help="print the selection; no network, no writes")
    args = parser.parse_args(argv)
    if args.year is not None and not re.fullmatch(r"\d{4}", args.year):
        parser.error("--year takes a four-digit year")
    for name in ("limit", "sample"):
        value = getattr(args, name)
        if value is not None and value < 0:
            parser.error(f"--{name} must not be negative")
    args.ids = split_ids(args.ids) or None
    if args.ids:
        bad = [value for value in args.ids if not ID_RE.fullmatch(value)]
        if bad:
            parser.error(f"not a link id (12 hex characters): {', '.join(bad)}")
    return args


def describe(record):
    if record.get("alive"):
        text = f"alive {record['status']}"
    else:
        text = f"dead ({record.get('error')})"
    if record.get("redirects"):
        text += f", {len(record['redirects'])} redirect(s) to {record['final_url']}"
    return text


def run(args, *, web_client=None, now=now_utc, clock=time.monotonic):
    started = clock()
    data_dir = args.data.resolve()
    links = hs.load_links(data_dir / "links")
    by_id = {link["id"]: link for link in links}
    if args.ids:
        unknown = [value for value in args.ids if value not in by_id]
        if unknown:
            log(f"error: not a public link id: {', '.join(unknown)}")
            return EXIT_ERROR
    expected = {link["id"]: pg.year_of(link) for link in links}
    store = Store(data_dir / "enrichment" / "pages", expected, pg.SHARD_RE).load()
    if store.ignored:
        log(f"left alone (not shard files): {', '.join(store.ignored)}")
    if store.dropped or store.moved:
        log(f"{store.dropped} record(s) for links no longer public dropped, {store.moved} moved")

    mode = "wayback" if args.wayback_only else "liveness"
    when = now()
    chosen = pg.select(
        links, store, when, mode=mode, year=args.year, ids=args.ids,
        sample=args.sample, limit=args.limit, recheck_after=args.recheck_after,
    )
    if args.dry_run:
        for link, reason in chosen:
            log(f"would observe {link['id']} {pg.year_of(link)} ({reason}) {link['url']}")
        what = "Wayback for" if args.wayback_only else ("liveness of" if args.no_wayback else "liveness and Wayback of")
        log(f"dry run: would observe {what} {len(chosen)} of {len(links):,} links; nothing written")
        return EXIT_OK

    web_client = web_client or web.Client()
    do_liveness = not args.wayback_only
    do_wayback = not args.no_wayback
    counts = {"checked": 0, "alive": 0, "dead": 0, "wayback": 0, "archived": 0, "wayback_failed": 0}
    written = set()
    status = EXIT_OK
    blocked = None
    try:
        for number, (link, _reason) in enumerate(chosen, start=1):
            previous = store.get(link["id"])
            record = previous
            parts = []
            if do_liveness:
                result, _body = web_client.follow(link["url"])  # the body is never kept
                record = pg.liveness_record(result, now(), previous)
                counts["checked"] += 1
                counts["alive" if record["alive"] else "dead"] += 1
                parts.append(describe(record))
            if do_wayback and blocked is None:
                if args.wayback_only or args.ids or pg.wayback_due(record, now(), args.recheck_after):
                    try:
                        observed = pg.observe_wayback(web_client, link)
                    except wb.Blocked as error:
                        blocked = str(error)
                        parts.append(f"Wayback refused us ({blocked}); no more Wayback this run")
                    except wb.LookupFailed as error:
                        counts["wayback_failed"] += 1
                        parts.append(f"Wayback failed ({error})")
                    else:
                        record = pg.with_wayback(record, observed, now())
                        counts["wayback"] += 1
                        counts["archived"] += 1 if observed["count"] else 0
                        parts.append(f"wayback {observed['count']} capture(s) from {observed['first'] or 'none'}")
            if record is not None and record is not previous:
                store.put(link["id"], record)
            log(f"[{number}/{len(chosen)}] {link['id']} {pg.year_of(link)}: {'; '.join(parts)}")
            if number % FLUSH_EVERY == 0:
                written.update(store.flush())
    except KeyboardInterrupt:
        log("interrupted; writing what was observed")
        status = EXIT_ERROR
    finally:
        written.update(store.flush())
    if blocked is not None:
        status = EXIT_ERROR
    elapsed = clock() - started
    wayback_part = (
        f"wayback {counts['wayback']} looked up, {counts['archived']} with captures, "
        f"{counts['wayback_failed']} failed{', STOPPED: ' + blocked if blocked else ''}"
        if do_wayback
        else "wayback skipped"
    )
    liveness_part = (
        f"checked {counts['checked']} link(s), {counts['alive']} alive, {counts['dead']} dead"
        if do_liveness
        else f"liveness skipped ({len(chosen)} link(s) selected)"
    )
    log(
        f"{'done' if status == EXIT_OK else 'stopped'}: {liveness_part}; {wayback_part}; "
        f"{len(written)} shard file(s) changed; {web_client.requests} http request(s); {elapsed:.0f} s"
    )
    return status


def main(argv=None, **deps):
    args = parse_args(argv)
    try:
        return run(args, **deps)
    except (ShardError, OSError, ValueError) as error:
        log(f"error: {error}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
