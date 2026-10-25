"""A seeded random sample of the decisions for a human check, and a CSV of
every change for anyone who wants to look. One-shot, 2026-10.

  audit.py <out_dir> [n] [seed]"""

import csv
import json
import random
import sys
from pathlib import Path


def rows(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    out_dir = Path(sys.argv[1])
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 7
    everything = rows(out_dir / "changes.jsonl") + rows(out_dir / "kept.jsonl")
    everything = [r for r in everything if r["action"] != "markdown"]
    random.seed(seed)
    sample = sorted(random.sample(everything, n), key=lambda r: r["saved"])
    with (out_dir / "audit-sample.md").open("w", encoding="utf-8") as handle:
        handle.write(f"# Audit sample: {n} of {len(everything)} decisions (seed {seed})\n\n")
        for index, row in enumerate(sample, 1):
            votes = row["signals"].get("votes", {})
            page = row["signals"].get("page", {})
            handle.write(f"## {index}. [{row['saved'][:10]}] {row['title'][:90]}\n")
            handle.write(f"- url: {row['url']}\n- action: **{row['action']}**  ({row['why']})\n")
            handle.write(f"- votes: sonnet={votes.get('claude-sonnet-5-5')} opus={votes.get('claude-opus-5-5')}; signature={row['signals'].get('signature')!r}; page={page} via {row['signals'].get('page_source')}\n")
            handle.write(f"- old: {row['old'].strip()[:700]!r}\n")
            if row["action"] != "keep":
                handle.write(f"- new: {row['new'][:700]!r}\n")
            handle.write("\n")
    # Every row a deterministic rule decided for the small, nameable groups:
    # attribution lines, feed items and blanked chrome. Checked in full, not
    # sampled, because each group is one percent of the pool or less.
    groups = ("attribution", "feed", "nothing but", "linkblog", "tweet of Jamie", "short note not on the page", "only on how much", "kept the passage inside", "chrome", "tweet", "quotation marks")
    ruled = [r for r in everything if r["why"].startswith("rule:") and any(g in r["why"] for g in groups)]
    ruled.sort(key=lambda r: (r["why"], r["saved"]))
    with (out_dir / "audit-rules.md").open("w", encoding="utf-8") as handle:
        handle.write(f"# Rule decisions, every row: {len(ruled)}\n\n")
        last = None
        for row in ruled:
            if row["why"] != last:
                last = row["why"]
                handle.write(f"\n## {last}\n\n")
            page = row["signals"].get("page", {})
            handle.write(f"### [{row['saved'][:10]}] {row['title'][:90]}\n- url: {row['url']}\n- action: **{row['action']}**; page={page} via {row['signals'].get('page_source')}\n")
            handle.write(f"- old: {row['old'].strip()[:500]!r}\n")
            if row["action"] != "keep":
                handle.write(f"- new: {row['new'][:500]!r}\n")
            handle.write("\n")
    with (out_dir / "changes.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["saved", "action", "why", "title", "url", "old note", "new note"])
        for row in rows(out_dir / "changes.jsonl"):
            writer.writerow([row["saved"][:10], row["action"], row["why"], row["title"], row["url"], row["old"].strip(), row["new"]])
    print(f"wrote {out_dir / 'audit-sample.md'} ({n} rows), {out_dir / 'audit-rules.md'} ({len(ruled)} rows) and {out_dir / 'changes.csv'}")


if __name__ == "__main__":
    main()
