"""Trim the few quoted notes whose posts/add query would overflow Pinboard's GET
limit (HTTP 414 at about 8,000 encoded characters). One-shot, 2026-10-25, on
Jamie's line "Approved: trim the five over-long quoted notes to fit Pinboard's
limit and write them".

  trim_long.py <out_dir> [--cap 7800]

For every row of changes.jsonl whose encoded query (with the live title, tags
and time from the newest snapshot) passes the cap, the quoted text is cut at
the last sentence end that fits and closed with " […]". The full text is kept
in the row as new_full, the row is marked trimmed, and changes.jsonl is
rewritten (a copy is saved first). writeback.py then writes the trimmed rows
like any other."""

import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

SENTENCE_END = re.compile(r"[.!?][\"”’)]?\s")
TOKEN_SHAPE = "x" * 33


def encoded_length(row, live, new):
    params = {
        "url": row["url"], "description": live["description"], "extended": new, "tags": live["tags"],
        "dt": live["time"], "replace": "yes", "shared": live["shared"], "toread": live["toread"],
        "format": "json", "auth_token": TOKEN_SHAPE,
    }
    return len(urlencode(params))


def unquote(text):
    """The paragraphs of a quoted note (decide.quote's form: "> " lines, a bare
    ">" between paragraphs)."""
    paragraphs, current = [], []
    for line in text.strip().split("\n"):
        assert line == ">" or line.startswith("> "), f"not a quote line: {line[:40]!r}"
        if line == ">":
            if current:
                paragraphs.append(" ".join(current))
                current = []
        else:
            current.append(line[2:].strip())
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


def quote(paragraphs):
    return "\n>\n".join("> " + p for p in paragraphs)


def trim(row, live, cap):
    flat = "\n\n".join(unquote(row["new"]))
    ends = [m.end() for m in SENTENCE_END.finditer(flat)]
    for end in reversed(ends):
        kept = flat[:end].rstrip()
        candidate = quote([p for p in kept.split("\n\n") if p.strip()])
        candidate += " […]"
        if encoded_length(row, live, candidate) <= cap:
            return candidate
    raise SystemExit(f"{row['hash'][:8]}: no sentence end fits under {cap}")


def main():
    args = sys.argv[1:]
    cap = int(args[args.index("--cap") + 1]) if "--cap" in args else 7800
    out_dir = Path([a for a in args if not a.startswith("--") and not a.isdigit()][0])
    snapshot = sorted(out_dir.glob("snapshot-*.json"))[-1]
    live = {p["hash"]: p for p in json.loads(snapshot.read_text(encoding="utf-8"))}
    path = out_dir / "changes.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    # Only a note the write-back could not place is trimmed; one already written
    # at full length (Pinboard's real limit sits a little above the cap) stays.
    log_path = out_dir / "writeback-log.jsonl"
    written = set()
    if log_path.exists():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                entry = json.loads(line)
                if entry["status"] in ("done", "already"):
                    written.add(entry["hash"])
    trimmed = 0
    for row in rows:
        if row["action"] != "quote" or row.get("trimmed") or row["hash"] in written:
            continue
        post = live.get(row["hash"])
        if post is None:
            continue
        before = encoded_length(row, post, row["new"])
        if before <= cap:
            continue
        new = trim(row, post, cap)
        row["new_full"], row["new"], row["trimmed"] = row["new"], new, True
        trimmed += 1
        print(f"{row['hash'][:8]} {row['saved'][:10]} {row['title'][:50]!r}: {len(row['new_full']):,} -> {len(new):,} chars, "
              f"query {before:,} -> {encoded_length(row, post, new):,}", flush=True)
        print("   ends:", repr(new[-120:]), flush=True)
    if trimmed:
        backup = out_dir / f"changes-untrimmed-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl"
        shutil.copy2(path, backup)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
        print(f"{trimmed} rows trimmed; changes.jsonl rewritten, copy at {backup.name}")
    else:
        print("nothing to trim")


if __name__ == "__main__":
    main()
