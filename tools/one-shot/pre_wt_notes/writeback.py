"""Write the decided notes back to Pinboard, by year, resumably. One-shot, 2026-10.

  writeback.py <out_dir> [--year YYYY ...] [--limit N] [--write]

Reads changes.jsonl (from decide.py) and skips rows whose action is "keep".
Before anything is written it takes one fresh posts/all snapshot (allowed once
every five minutes) and compares every bookmark's current note with the
recorded old value: a note that moved since the decision is skipped, never
overwritten. Each write is posts/add with replace=yes and dt set to the
bookmark's own time, which the trial proved keeps time, title, tags, flags and
hash. Progress goes to writeback-log.jsonl so a stopped run resumes. After the
writes, one more posts/all confirms every written note landed. Without --write
it only reports what it would do. The token never prints."""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pinboard_write import Client, PinboardWriteError  # noqa: E402

ALL_SPACING = 5 * 60 + 5
WRITE_ACTIONS = {"quote", "blank", "split", "markdown"}


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_jsonl(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def snapshot(client, out_dir, label):
    """One posts/all, saved under out_dir, paced to Pinboard's five-minute rule."""
    stamps = sorted(out_dir.glob("snapshot-*.json"))
    if stamps:
        age = time.time() - stamps[-1].stat().st_mtime
        if age < ALL_SPACING:
            wait = ALL_SPACING - age
            print(f"waiting {wait:.0f}s for the posts/all window", flush=True)
            time.sleep(wait)
    posts = client.all()
    path = out_dir / f"snapshot-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{label}.json"
    path.write_text(json.dumps(posts, ensure_ascii=False), encoding="utf-8")
    path.chmod(0o600)
    print(f"snapshot {label}: {len(posts)} bookmarks -> {path.name}", flush=True)
    return {post["hash"]: post for post in posts}


def main():
    args = sys.argv[1:]
    write = "--write" in args
    years, limit = set(), None
    positional = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--year":
            years.add(args[index + 1])
            index += 2
        elif arg == "--limit":
            limit = int(args[index + 1])
            index += 2
        elif arg == "--write":
            index += 1
        else:
            positional.append(arg)
            index += 1
    out_dir = Path(positional[0])
    changes = [row for row in read_jsonl(out_dir / "changes.jsonl") if row["action"] in WRITE_ACTIONS]
    if years:
        changes = [row for row in changes if row["saved"][:4] in years]
    changes.sort(key=lambda row: row["saved"])
    log_path = out_dir / "writeback-log.jsonl"
    done = {row["hash"] for row in read_jsonl(log_path) if row["status"] in ("done", "already")}
    todo = [row for row in changes if row["hash"] not in done]
    if limit is not None:
        todo = todo[:limit]
    print(f"{len(changes)} changes in scope, {len(done)} already written, {len(todo)} to do, "
          f"{'WRITING' if write else 'dry run'}", flush=True)
    if not todo:
        return

    client = Client()
    current = snapshot(client, out_dir, "before")
    counts = {"done": 0, "already": 0, "differs": 0, "missing": 0, "failed": 0, "planned": 0}
    written = []
    with log_path.open("a", encoding="utf-8") as log:
        def record(row, status, **extra):
            counts[status] += 1
            log.write(json.dumps({"hash": row["hash"], "url": row["url"], "action": row["action"], "status": status,
                                  "when": now(), **extra}, ensure_ascii=False) + "\n")
            log.flush()

        for number, row in enumerate(todo, 1):
            live = current.get(row["hash"])
            if live is None:
                record(row, "missing")
                continue
            if live["extended"] == row["new"]:
                record(row, "already", meta=live["meta"])
                continue
            if live["extended"] != row["old"]:
                record(row, "differs", meta=live["meta"])
                continue
            if not write:
                counts["planned"] += 1
                continue
            try:
                client.replace(live, row["new"])
            except PinboardWriteError as error:
                record(row, "failed", error=str(error))
                print(f"{number}/{len(todo)} {row['hash'][:8]} FAILED {error}", flush=True)
                if counts["failed"] >= 5:
                    print("five failures; stopping", flush=True)
                    break
                continue
            record(row, "done", meta_before=live["meta"], time=live["time"])
            written.append(row)
            if number % 50 == 0 or number == len(todo):
                print(f"{number}/{len(todo)} {row['saved'][:10]} {row['action']}", flush=True)

        if written:
            after = snapshot(client, out_dir, "after")
            confirmed = failed = 0
            for row in written:
                live = after.get(row["hash"])
                ok = bool(live) and live["extended"] == row["new"] and live["time"] == current[row["hash"]]["time"]
                confirmed += ok
                failed += not ok
                if not ok:
                    log.write(json.dumps({"hash": row["hash"], "url": row["url"], "status": "unconfirmed", "when": now()}) + "\n")
            print(f"confirmed {confirmed} of {len(written)} written; unconfirmed {failed}", flush=True)
    print(json.dumps(counts), flush=True)


if __name__ == "__main__":
    main()
