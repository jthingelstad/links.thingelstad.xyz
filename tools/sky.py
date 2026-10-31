#!/usr/bin/env python3
"""Keep the sky up to date with the links (docs/DATA.md, "The sky").

Embeds every public link that has no vector yet, or whose title or note
changed, through Bedrock (the AWS CLI, cloud-engineer profile), then gives each
new link its ten nearest neighbours, a topic and a place in both frozen
layouts, enters it into the lists of the links it is now nearest to, and takes
every link that is no longer public out of the sky. Writes data/derived/sky.json
and data/derived/sky/<yyyy>.json; the vectors stay in the cache outside the
repository (LINKS_VECTORS, default ~/Library/Application Support/
links.thingelstad.xyz/vectors).

  python3 -I tools/sky.py [--dry-run] [--embed-only] [--data DIR] [--vectors DIR]

--dry-run reads everything and says what a run would do: no network, no writes.
--embed-only fills the cache and stops, for tools/one-shot/sky_layout.py; it
needs no sky.

Exit codes: 0 done; 1 Bedrock or the identity check failed (what could be done
without it, taking removed links out, is still written) or the sky on disk is
broken; 64 a bad argument.
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking import DATA_DIR  # noqa: E402
from linking import sky, vectors  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DATA_DIR, help="the data directory (default: data/)")
    parser.add_argument("--vectors", type=Path, default=None, help="the vector cache (default: LINKS_VECTORS or ~/Library/Application Support/...)")
    parser.add_argument("--dry-run", action="store_true", help="no network, no writes; print the plan")
    parser.add_argument("--embed-only", action="store_true", help="fill the vector cache and stop")
    args = parser.parse_args(argv)
    cache_dir = args.vectors or vectors.default_dir()
    links = sky.load_links(args.data)
    cache = vectors.Cache.load(cache_dir)

    def embed(texts):
        vectors.check_identity()
        started = time.monotonic()

        def progress(done, total):
            if done == total or done % (vectors.BATCH * 20) == 0:
                print(f"sky: embedded {done:,}/{total:,} in {time.monotonic() - started:.0f} s", flush=True)

        return vectors.embed(texts, progress=progress)

    if args.embed_only:
        cache.keep(set(links))
        stale = [i for i, link in links.items() if cache.digest_of(i) != vectors.digest(vectors.text(link))]
        if args.dry_run or not stale:
            print(f"sky: {len(cache):,} vectors in {cache_dir}; {len(stale):,} to embed{' (dry run)' if stale else ''}")
            return 0
        try:
            made = embed([vectors.text(links[i]) for i in stale])
        except vectors.VectorError as error:
            print(f"sky: FAILED: {error}", file=sys.stderr)
            return 1
        for link_id, vector in zip(stale, made, strict=True):
            cache.put(link_id, vectors.digest(vectors.text(links[link_id])), vector)
        cache.save(cache_dir)
        print(f"sky: embedded {len(stale):,}; {len(cache):,} vectors in {cache_dir}")
        return 0

    try:
        sky_head, stars = sky.load(args.data)
    except sky.SkyError as error:
        print(f"sky: FAILED: {error}", file=sys.stderr)
        return 1
    if sky_head is None:
        print("sky: FAILED: no data/derived/sky.json; tools/one-shot/sky_layout.py makes the first sky", file=sys.stderr)
        return 1
    print(f"sky: {len(links):,} public links, {len(stars):,} stars, {len(cache):,} vectors in {cache_dir}")

    result = sky.update(links, sky_head, stars, cache, embed_texts=None if args.dry_run else embed)
    if args.dry_run:
        stale = sum(1 for link_id, link in links.items() if cache.digest_of(link_id) != vectors.digest(vectors.text(link)))
        print(f"sky: dry run: would embed {stale:,} link(s); nothing fetched or written")
        print(result.summary(len(stars)))
        return 0
    if result.embedded:
        cache.save(cache_dir)
    changed = sky.write(args.data, sky_head, stars, links)
    if changed:
        print(f"sky: wrote {len(changed)} file(s)")
    print(result.summary(len(stars)))
    return 1 if result.failure else 0


if __name__ == "__main__":
    sys.exit(main())
