#!/usr/bin/env python3
"""Facts from special hosts (YouTube, Vimeo, GitHub, Wikipedia, Open Library), into data/enrichment/facts/.

One adapter per host (tools/linking/adapters/), each asking that host's API
about the links it applies to: a video's title, channel and thumbnail, a
repository's description and stars, an article's short description, a book's
authors and cover. Incremental: links never asked first, in saved order, then
records 90 days old (30 for an error). Thumbnails and covers are downloaded
once to public/media/ and never overwritten; an image no record names any
more is removed. One request a second per host. Writes only under
<data>/enrichment/facts/ and the media directory. See tools/README.md.
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR, web  # noqa: E402
from linking import facts as fx  # noqa: E402
from linking import hosts as hs  # noqa: E402
from linking.adapters import ADAPTERS, BY_METHOD  # noqa: E402
from linking.adapters.base import AdapterError, Context, StopMethod  # noqa: E402
from linking.shards import ShardError, Store, now_utc  # noqa: E402

EXIT_OK, EXIT_ERROR = 0, 1
FLUSH_EVERY = 25
ID_RE = re.compile(r"[0-9a-f]{12}")


def log(message):
    print(f"enrich_facts: {message}", flush=True)


def split_values(values):
    found = []
    for value in values or []:
        found.extend(part.strip() for part in value.split(",") if part.strip())
    return found


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DATA_DIR, help="the data directory (default: data/)")
    parser.add_argument(
        "--media", type=Path, help="where images go (default: public/media/ beside the data directory)"
    )
    parser.add_argument("--limit", type=int, metavar="N", help="ask about at most N links")
    parser.add_argument(
        "--only-method",
        action="append",
        metavar="METHOD",
        help=f"only these adapters (repeat or comma-separate): {', '.join(BY_METHOD)}",
    )
    parser.add_argument(
        "--ids", action="append", metavar="ID", help="these link ids, whatever their state (repeat or comma-separate)"
    )
    parser.add_argument(
        "--recheck-after",
        type=float,
        metavar="DAYS",
        help=f"ask again about records at least DAYS old (default {fx.RECHECK_DAYS}, {fx.ERROR_RECHECK_DAYS} for an error)",
    )
    parser.add_argument("--dry-run", action="store_true", help="print the selection; no network, no writes")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 0:
        parser.error("--limit must not be negative")
    args.only_method = split_values(args.only_method) or None
    if args.only_method:
        unknown = [name for name in args.only_method if name not in BY_METHOD]
        if unknown:
            parser.error(f"no such method: {', '.join(unknown)} (known: {', '.join(BY_METHOD)})")
    args.ids = split_values(args.ids) or None
    if args.ids:
        bad = [value for value in args.ids if not ID_RE.fullmatch(value)]
        if bad:
            parser.error(f"not a link id (12 hex characters): {', '.join(bad)}")
    return args


def describe(record):
    if "error" in record:
        return f"error ({record['error']})"
    name = record.get("title") or record.get("full_name") or "untitled"
    by = record.get("author") or ", ".join(record.get("authors") or [])
    text = f"{name}{' by ' + by if by else ''}"
    if "image" in record:
        text += "; image" if record["image"] else "; no image"
    return text


def run(args, *, web_client=None, now=now_utc, clock=time.monotonic, environ=os.environ):
    started = clock()
    data_dir = args.data.resolve()
    media_dir = (args.media or data_dir.parent / "public" / "media").resolve()
    links = hs.load_links(data_dir / "links")
    by_id = {link["id"]: link for link in links}
    adapters_by_id = fx.plan(links)
    if args.ids:
        unknown = [value for value in args.ids if value not in by_id]
        if unknown:
            log(f"error: not a public link id: {', '.join(unknown)}")
            return EXIT_ERROR
        unapplied = [value for value in args.ids if value not in adapters_by_id]
        if unapplied:
            log(f"error: no adapter applies to: {', '.join(unapplied)}")
            return EXIT_ERROR
    expected = {link_id: fx.year_of(by_id[link_id]) for link_id in adapters_by_id}
    store = Store(data_dir / "enrichment" / "facts", expected, fx.SHARD_RE).load()
    if store.ignored:
        log(f"left alone (not shard files): {', '.join(store.ignored)}")
    if store.dropped or store.moved:
        log(f"{store.dropped} record(s) for links no longer public or no longer special dropped, {store.moved} moved")

    when = now()
    chosen = fx.select(
        links, adapters_by_id, store, when,
        methods=set(args.only_method) if args.only_method else None,
        ids=args.ids, limit=args.limit, recheck_after=args.recheck_after,
    )
    applying = {}
    for adapter in adapters_by_id.values():
        applying[adapter.METHOD] = applying.get(adapter.METHOD, 0) + 1
    if args.dry_run:
        for link, adapter, reason in chosen:
            log(f"would ask {adapter.METHOD} about {link['id']} {fx.year_of(link)} ({reason}) {link['url']}")
        per = ", ".join(f"{a.METHOD} {applying.get(a.METHOD, 0)}" for a in ADAPTERS)
        log(f"dry run: would ask about {len(chosen)} of {len(adapters_by_id):,} applying links ({per}); nothing written")
        return EXIT_OK

    token = (environ.get("GITHUB_TOKEN") or "").strip() or None
    web_client = web_client or web.Client()
    ctx = Context(web_client, media_dir, github_token=token)
    counts = {adapter.METHOD: {"ok": 0, "error": 0, "kept": 0, "skipped": 0} for adapter in ADAPTERS}
    stopped = {}
    written = set()
    status = EXIT_OK
    try:
        for number, (link, adapter, _reason) in enumerate(chosen, start=1):
            method = adapter.METHOD
            if method in stopped:
                counts[method]["skipped"] += 1
                continue
            previous = store.get(link["id"])
            try:
                fields = adapter.fetch(link, ctx)
                record = fx.facts_record(adapter, fields, now())
                counts[method]["ok"] += 1
            except StopMethod as stop:
                stopped[method] = str(stop)
                counts[method]["skipped"] += 1
                log(f"[{number}/{len(chosen)}] {method} stopped: {stop}")
                continue
            except AdapterError as error:
                if error.transient and fx.has_facts(previous, adapter):
                    counts[method]["kept"] += 1
                    log(f"[{number}/{len(chosen)}] {method} {link['id']}: kept the earlier facts ({error})")
                    continue
                record = fx.error_record(adapter, error, now())
                counts[method]["error"] += 1
            store.put(link["id"], record)
            log(f"[{number}/{len(chosen)}] {method} {link['id']} {fx.year_of(link)}: {describe(record)}")
            if number % FLUSH_EVERY == 0:
                written.update(store.flush())
    except KeyboardInterrupt:
        log("interrupted; writing what was asked")
        status = EXIT_ERROR
    finally:
        written.update(store.flush())
    removed = fx.prune_media(media_dir, fx.images(store.records()))
    if stopped:
        status = EXIT_ERROR
    elapsed = clock() - started
    parts = []
    for adapter in ADAPTERS:
        c = counts[adapter.METHOD]
        if any(c.values()):
            text = f"{adapter.METHOD} {c['ok']} ok, {c['error']} error"
            if c["kept"]:
                text += f", {c['kept']} kept"
            if c["skipped"]:
                text += f", {c['skipped']} not asked"
            parts.append(text)
    stops = "".join(f"; STOPPED {method}: {reason}" for method, reason in stopped.items())
    log(
        f"{'done' if status == EXIT_OK else 'stopped'}: asked about {len(chosen)} link(s)"
        f"{' (' + '; '.join(parts) + ')' if parts else ''}; images {ctx.images_saved} saved, "
        f"{ctx.images_kept} already there, {len(removed)} removed; {len(written)} shard file(s) changed; "
        f"{web_client.requests} http request(s); {elapsed:.0f} s{stops}"
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
