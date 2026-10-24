"""The one trial write: a bookmark's bare excerpt becomes a blockquote, and the
bookmark is read back. Refuses unless Pinboard still holds the note the export
recorded. One-shot, 2026-10.  trial.py <export> <url> [--write]"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pinboard_write import Client  # noqa: E402


def as_blockquote(note):
    paragraphs = [p.strip() for p in note.strip().split("\n\n") if p.strip()]
    return "\n>\n".join("> " + " ".join(p.split("\n")) for p in paragraphs)


def main():
    export, url = sys.argv[1], sys.argv[2]
    write = "--write" in sys.argv
    recorded = next(p for p in json.load(open(export, encoding="utf-8")) if p["href"] == url)
    client = Client()
    live = client.get(url)
    if live is None:
        sys.exit("Pinboard has no bookmark at that URL")
    for field in ("description", "extended", "time", "tags", "shared", "toread"):
        if live[field] != recorded[field]:
            sys.exit(f"refusing: live {field} differs from the export ({live[field]!r} vs {recorded[field]!r})")
    new = as_blockquote(recorded["extended"])
    print("live bookmark matches the export; new note:\n" + new)
    if not write:
        print("(dry run; pass --write to change it)")
        return
    client.replace(recorded, new)
    after = client.get(url)
    checks = {
        "time kept": after["time"] == recorded["time"],
        "note is the blockquote": after["extended"] == new,
        "title kept": after["description"] == recorded["description"],
        "tags kept": after["tags"] == recorded["tags"],
        "shared kept": after["shared"] == recorded["shared"],
        "toread kept": after["toread"] == recorded["toread"],
        "hash kept": after["hash"] == recorded["hash"],
    }
    print("read-back:", json.dumps(checks))
    print("after:", json.dumps({k: after[k] for k in ("time", "hash", "meta", "tags", "shared", "toread")}))
    print("note:", repr(after["extended"]))
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main()
