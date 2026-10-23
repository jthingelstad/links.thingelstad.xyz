#!/usr/bin/env python3
"""Observe the hosts Jamie links to: DNS, HTTPS and RDAP, into data/enrichment/hosts/.

Incremental: hosts never observed come first (most links first), then the
oldest observations. DNS through dig, HTTPS with one GET each of
https://<host>/ and http://<host>/, RDAP through rdap.org, one request a
second per service. Writes only under <data>/enrichment/hosts/. See
tools/README.md.
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR  # noqa: E402
from linking import dns, rdap, web  # noqa: E402
from linking import hosts as hs  # noqa: E402
from linking.shards import ShardError, Store, now_utc  # noqa: E402

EXIT_OK, EXIT_ERROR = 0, 1
FLUSH_EVERY = 10


def log(message):
    print(f"enrich_hosts: {message}", flush=True)


def split_names(values):
    names = []
    for value in values or []:
        names.extend(part.strip().lower() for part in value.split(",") if part.strip())
    return names


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DATA_DIR, help="the data directory (default: data/)")
    parser.add_argument("--min-links", type=int, default=1, metavar="N", help="only hosts with at least N links")
    parser.add_argument(
        "--only", action="append", metavar="HOST", help="check these hosts whatever their state (repeat or comma-separate)"
    )
    parser.add_argument("--limit", type=int, metavar="N", help="check at most N hosts")
    parser.add_argument(
        "--recheck-after",
        type=float,
        default=hs.DEFAULT_RECHECK_DAYS,
        metavar="DAYS",
        help=f"recheck hosts observed at least DAYS ago (default {hs.DEFAULT_RECHECK_DAYS})",
    )
    parser.add_argument(
        "--rdap-min-links",
        type=int,
        default=hs.DEFAULT_RDAP_MIN_LINKS,
        metavar="N",
        help=f"ask RDAP only for hosts with at least N links (default {hs.DEFAULT_RDAP_MIN_LINKS})",
    )
    parser.add_argument(
        "--rdap-recheck-after",
        type=float,
        default=hs.DEFAULT_RDAP_RECHECK_DAYS,
        metavar="DAYS",
        help=f"ask RDAP again once its answer is DAYS old (default {hs.DEFAULT_RDAP_RECHECK_DAYS})",
    )
    parser.add_argument("--no-rdap", action="store_true", help="skip RDAP; keep any earlier answer")
    parser.add_argument("--dry-run", action="store_true", help="print the selection; no network, no writes")
    args = parser.parse_args(argv)
    for name in ("min_links", "limit", "rdap_min_links"):
        value = getattr(args, name)
        if value is not None and value < 0:
            parser.error(f"--{name.replace('_', '-')} must not be negative")
    return args


def describe(record):
    dns_part = "resolves" if record["dns"]["resolves"] else f"no address ({record['dns'].get('error', 'none')})"
    https = record["https"]
    https_part = f"https {https['status']}" if https["reachable"] else f"https unreachable ({https.get('error')})"
    if https.get("redirects_http"):
        https_part += ", http→https"
    if "rdap" not in record:
        rdap_part = "rdap not asked"
    elif record["rdap"] is None:
        rdap_part = f"rdap none ({record.get('rdap_error')})"
    else:
        found = record["rdap"]
        rdap_part = f"rdap {found['domain']} registered {found['registered']}"
    return f"{dns_part}; {https_part}; {rdap_part}"


def run(args, *, resolver=None, web_client=None, rdap_client=None, now=now_utc, clock=time.monotonic):
    started = clock()
    data_dir = args.data.resolve()
    links = hs.load_links(data_dir / "links")
    index = hs.index(links)
    expected = {}
    for host in index:
        shard = hs.shard_of(host)
        if shard is None:
            log(f"skipping {host!r}: its first character names no shard")
            continue
        expected[host] = shard
    index = {host: entry for host, entry in index.items() if host in expected}
    store = Store(data_dir / "enrichment" / "hosts", expected, hs.SHARD_RE).load()
    if store.ignored:
        log(f"left alone (not shard files): {', '.join(store.ignored)}")
    if store.dropped or store.moved:
        log(f"{store.dropped} record(s) for hosts no longer linked dropped, {store.moved} moved")

    only = split_names(args.only) or None
    if only:
        unknown = [name for name in only if name not in index]
        if unknown:
            log(f"error: not a host of any public link: {', '.join(unknown)}")
            return EXIT_ERROR
    existing = dict(store.records())
    when = now()
    chosen = hs.select(
        index, existing, when, min_links=args.min_links, only=set(only) if only else None,
        limit=args.limit, recheck_after=args.recheck_after,
    )
    if args.dry_run:
        for host, reason in chosen:
            rdap_wanted = not args.no_rdap and hs.wants_rdap(
                index[host], existing.get(host), when,
                min_links=args.rdap_min_links, recheck_after=args.rdap_recheck_after,
            )
            log(f"would check {host} ({index[host]['count']} links; {reason}{'; rdap' if rdap_wanted else ''})")
        log(f"dry run: would check {len(chosen)} of {len(index):,} hosts; nothing written")
        return EXIT_OK

    gate = web.Gate()
    web_client = web_client or web.Client(gate=gate)
    resolver = resolver or dns.Resolver(gate)
    rdap_client = rdap_client or rdap.Client(web_client)
    counts = {"checked": 0, "alive": 0, "dead": 0, "rdap": 0, "rdap_none": 0}
    written = set()
    status = EXIT_OK
    try:
        for number, (host, _reason) in enumerate(chosen, start=1):
            entry, previous = index[host], store.get(host)
            rdap_wanted = not args.no_rdap and hs.wants_rdap(
                entry, previous, now(), min_links=args.rdap_min_links, recheck_after=args.rdap_recheck_after
            )
            record, alive = hs.check(
                host, entry, previous, now(),
                resolver=resolver, web=web_client, rdap_client=rdap_client, rdap_wanted=rdap_wanted,
            )
            store.put(host, record)
            counts["checked"] += 1
            counts["alive" if alive else "dead"] += 1
            if rdap_wanted:
                counts["rdap" if record.get("rdap") else "rdap_none"] += 1
            log(f"[{number}/{len(chosen)}] {host}: {describe(record)}")
            if number % FLUSH_EVERY == 0:
                written.update(store.flush())
    except KeyboardInterrupt:
        log("interrupted; writing what was checked")
        status = EXIT_ERROR
    finally:
        written.update(store.flush())
    elapsed = clock() - started
    log(
        f"{'done' if status == EXIT_OK else 'stopped'}: checked {counts['checked']} host(s), "
        f"{counts['alive']} alive (answer over https or http), {counts['dead']} dead, rdap found {counts['rdap']} "
        f"(none {counts['rdap_none']}); {len(written)} shard file(s) changed; "
        f"{web_client.requests} http request(s), {rdap_client.queries} rdap quer(ies); {elapsed:.0f} s"
    )
    return status


def main(argv=None, **deps):
    args = parse_args(argv)
    try:
        return run(args, **deps)
    except (ShardError, dns.DnsError, OSError, ValueError) as error:
        log(f"error: {error}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
