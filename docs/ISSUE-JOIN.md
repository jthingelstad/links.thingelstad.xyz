# Issue associations from a pinned source

`python3 -I tools/join_issues.py` fetches Weekly's public main once, resolves a
full commit id and exports that revision's archive into a temporary directory.
It neither updates nor reads another worker's active checkout. The source id
is logged with the generated join's summary. A failed fetch or missing source
revision stops before replacing `data/derived/issues.json`; cached working
files are never a fallback. `--archive DIR` remains an explicit offline input
for fixtures and isolated CI checkouts. Matching and the public schema are
unchanged.

The normal nightly calls this same default, so an unrelated branch or dirty
Weekly checkout cannot silently omit a published issue on the next run. This
does not replay WT Builder, send a publication event, enable a bus workflow or
read a new credential. CodeBuild continues to publish only reviewed canonical
source packages and the existing durable public bookmark captures.

## The WT354 test

Jamie originally held the gap as an example, then lifted the hold on October
28: “the hold repair was to use it as a test which we are now ready to do...”.
The bounded change regenerates the derived issue associations through normal
PR, CI and AWS publication, preserving bookmark records and unrelated data.

Before-state captured October 28 at 7:55 a.m. CDT:

- The public `/issues/354/` returned 404 and `links_search` for `wt:354`
  returned `not_found`.
- Sync compared published WT354 with Linking Things' WT353. Its snapshot was
  late on hop 6, not an unavailable reader.
- All 23 affected public bookmark JSON twins existed. Their records were
  preserved for comparison; missing issue associations were not lost bookmarks.
- The local Weekly checkout remained on `share-images` without `354.md`.
  This working tree was left untouched.

The repair was generated from pinned Weekly main
[`8495f487cdeba183014b30fbf85579363139ef08`](https://github.com/jthingelstad/weekly.thingelstad.com/blob/8495f487cdeba183014b30fbf85579363139ef08/apps/site/archive/354.md).
The generated diff adds only WT354 and its 23 matched bookmark associations;
all 354 existing issue entries are identical. No year shard, bookmark field,
enrichment or full-mirror stamp is edited.

Completion requires the published issue page, all 23 search associations,
unchanged bookmark fields, the destination's actual `received` receipt and a
subsequent Sync observation. A local generation, a successful CI job, or a
successful publisher exit alone is not completion. This is a manual bounded
test; the next natural 00:30 Central nightly remains separate acceptance of
the scheduled runner.

## A successful exit is not source freshness

The owner also reported an October 28 02:15:06 CDT WT backfill that could not
fast-forward its website checkout, then exited zero saying the back catalogue
was complete. [The recorded observation](https://github.com/jthingelstad/projects-sysadmin/issues/70#issuecomment-6465601531)
does not establish that it used the same checkout as this join. No backfill is
replayed here and its missing-exit-code health defect remains Maintain-owned.

Regression tests prove that an active stale/dirty branch is unchanged while
the join reads remote main, the exported tree stays pinned if the remote ref
moves, a zero-exit response without a source revision is refused, and a source
failure leaves the previous derived output intact. They require no network or
production write.
