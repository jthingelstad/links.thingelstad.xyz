"""Give the over-long quoted notes a normal-length excerpt. One-shot, 2026-10.

  shorten_long.py <out_dir>          build <out_dir>/normal/changes.jsonl
  shorten_long.py <out_dir> --apply  fold the written excerpts back into changes.jsonl

trim_long.py cut the five quotes Pinboard refused (HTTP 414) to the longest
text that fit, around 7,000 characters, and the write-back placed those. Jamie
then asked for normal notes instead ("Those very long pinboard descriptions
should be replaced with more normal ones. You can edit as you would like to do
that.", 2026-10-25) and extended that to the rest of the very long quotes
("Approved: shorten the ten quoted notes over 5,000 characters to
opening-paragraph excerpts"). The median quoted note in the plan is 257
characters and the 95th percentile 1,244, so each of the fifteen keeps its
page's opening paragraphs, chosen by hand below, closed with " […]"; the page's
full text stays at the URL.

A quote saved as one paragraph of several thousand characters lost its
paragraph breaks on the way into Pinboard; where a sentence ends with no space
before the next capital, that is where a break was, and the text is split
there again before the opening is taken.

The rows written to normal/changes.jsonl expect the current quote as the live
note (old), so writeback.py run on that folder writes only where the quote
really is and skips anything that moved. --apply, run after that write-back
confirmed every row, rewrites <out_dir>/changes.jsonl so the plan records the
final text (new), the full quote (new_full) and, for the five, the trim
(new_trimmed)."""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trim_long import SENTENCE_END, quote, unquote  # noqa: E402

# hash prefix -> (first paragraph, last paragraph) of the page text to keep, or a
# character budget: opening paragraphs up to about that long (one at least, cut
# at a sentence end if the first alone is over)
SELECTION = {
    # the five that Pinboard refused at full length
    "3dd14f83": (2, 4),  # pmarca, An hour and a half with Barack Obama: the meeting itself
    "4ac80977": (0, 1),  # VentureBeat, EA's chief creative officer: the lead
    "40e015d5": (0, 0),  # VentureBeat, Carmack builds Doom Classic: the lead paragraph
    "99a739f9": (0, 2),  # EFF, Why We Need An Open Wireless Movement: the opening
    "039dc141": (0, 2),  # Opticality, Installing CrashPlan on a PogoPlug Pro: the opening
    # the ten over 5,000 characters that were written whole
    "bd6ec5ea": 750,     # Recovering Journalist, It's Not the News. It's the Packaging
    "a2f15c80": (1, 1),  # Scalzi, What I Think About Atlas Shrugged: the take, not the preamble
    "e5c51a4d": (0, 2),  # Joel on Software, Architecture astronauts take over: Hailstorm
    "b51d115d": (0, 3),  # unpossible, A Plan For Minnesota: the thesis and first examples
    "e9ee4079": (0, 2),  # iwilltri, Macca conference call: the synopsis opening
    "10229ecc": (0, 2),  # Daring Fireball, WWDC 2009 Wrap-Up: the JavaOne comparison
    "21c8bb39": (0, 2),  # tech.mn, John Tedesco: the introduction
    "b1192cc8": (0, 0),  # EFF at the UN Internet Governance Forum: the lead paragraph
    "85c363b2": 750,     # Google blog, Bing uses Google search results
    "6374a2d9": 750,     # Google blog, next generation of ad serving (DFP)
}
LONGEST = 1_300  # characters; above this an excerpt is not "normal"
# a sentence end (letter, digit or closer, then . ! ?, then maybe a closing
# quote or parenthesis) run straight into the next capital or opening quote
LOST_BREAK = re.compile(r'[a-z\d)"”’][.!?]["”’)]?(?=[A-Z“"])')


def read_jsonl(path):
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def split_lost_breaks(text):
    pieces, start = [], 0
    for match in LOST_BREAK.finditer(text):
        pieces.append(text[start:match.end()])
        start = match.end()
    pieces.append(text[start:])
    return [piece.strip() for piece in pieces if piece.strip()]


def paragraphs_of(text):
    """The quote's paragraphs; a single huge one is split where its breaks were lost."""
    paragraphs = unquote(text)
    if len(paragraphs) == 1:
        pieces = split_lost_breaks(paragraphs[0])
        if len(pieces) > 1:
            return pieces, True
    return paragraphs, False


def opening(paragraphs, budget):
    kept, total = [], 0
    for paragraph in paragraphs:
        if kept and total + len(paragraph) > budget:
            break
        kept.append(paragraph)
        total += len(paragraph)
    if len(kept) == 1 and total > budget:
        ends = [m.end() for m in SENTENCE_END.finditer(kept[0] + " ") if m.end() <= budget + 1]
        if ends:
            kept = [kept[0][:ends[-1]].rstrip()]
    return kept


def excerpt(row):
    choice = SELECTION[row["hash"][:8]]
    paragraphs, recovered = paragraphs_of(row.get("new_full") or row["new"])
    if isinstance(choice, tuple):
        kept = paragraphs[choice[0]:choice[1] + 1]
    else:
        kept = opening(paragraphs, choice)
    text = quote(kept) + " […]"
    if len(text) > LONGEST:
        raise SystemExit(f"{row['hash'][:8]}: excerpt is {len(text)} characters, over {LONGEST}")
    return text, recovered, len(paragraphs)


def build(out_dir):
    rows = [row for row in read_jsonl(out_dir / "changes.jsonl") if row["hash"][:8] in SELECTION]
    if len(rows) != len(SELECTION):
        found = {row["hash"][:8] for row in rows}
        raise SystemExit(f"expected {len(SELECTION)} rows, found {len(rows)}; missing {sorted(set(SELECTION) - found)}")
    if any(row["action"] != "quote" for row in rows):
        raise SystemExit("every selected row must be a quote")
    normal = []
    for row in rows:
        new, recovered, count = excerpt(row)
        note = f"{count} paragraphs recovered from one" if recovered else f"{count} paragraphs"
        print(f"{row['hash'][:8]} {row['saved'][:10]} {len(row['new']):>5} -> {len(new):>4} chars  {row['title'][:60]}  ({note})")
        fresh = {k: v for k, v in row.items() if k != "trimmed"}
        fresh.update(old=row["new"], new=new, new_full=row.get("new_full") or row["new"], normal=True)
        if row.get("trimmed"):
            fresh["new_trimmed"] = row["new"]
        normal.append(fresh)
    folder = out_dir / "normal"
    folder.mkdir(exist_ok=True)
    write_jsonl(folder / "changes.jsonl", normal)
    print(f"wrote {len(normal)} rows to {folder / 'changes.jsonl'}; next: writeback.py {folder} --write")


def apply(out_dir):
    folder = out_dir / "normal"
    log = {row["hash"]: row["status"] for row in read_jsonl(folder / "writeback-log.jsonl")}
    normal = {row["hash"]: row for row in read_jsonl(folder / "changes.jsonl")}
    not_done = [h[:8] for h in normal if log.get(h) not in ("done", "already")]
    if not_done:
        raise SystemExit(f"not written yet: {not_done}; nothing applied")
    rows = read_jsonl(out_dir / "changes.jsonl")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    write_jsonl(out_dir / f"changes-before-normal-{stamp}.jsonl", rows)
    changed = 0
    for row in rows:
        done = normal.get(row["hash"])
        if done is None:
            continue
        if row.pop("trimmed", None):
            row["new_trimmed"] = row["new"]
        row["new_full"] = row.get("new_full") or row["new"]
        row["new"], row["normal"] = done["new"], True
        changed += 1
    write_jsonl(out_dir / "changes.jsonl", rows)
    print(f"applied {changed} normal excerpts to {out_dir / 'changes.jsonl'} (previous copy: changes-before-normal-{stamp}.jsonl)")


def main():
    args = sys.argv[1:]
    if not args or len(args) > 2 or (len(args) == 2 and args[1] != "--apply"):
        raise SystemExit(__doc__)
    out_dir = Path(args[0])
    (apply if len(args) == 2 else build)(out_dir)


if __name__ == "__main__":
    main()
