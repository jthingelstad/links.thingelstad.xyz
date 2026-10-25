"""Classify whose words each pool note is, with one model, through the Message
Batches API. One-shot, 2026-10.

  classify.py submit  <export> <out_dir> <model>      -> prints the batch id
  classify.py collect <export> <out_dir> <model> <id> -> writes model-<model>.jsonl

The key is CLAUDE_API_KEY in the environment; nothing here prints it."""

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import anthropic

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pool import clipped, load_pool  # noqa: E402

SYSTEM = """You sort the note field of bookmarks that Jamie Thingelstad saved between 2005 and May 2017. Decide whose words the note is.

Classes:
- jamie: Jamie's own words about the page: a reaction, a recommendation, why he saved it, a note to himself. Usually short. Markers: first person about his own life or work; his family (Tammy, Mazie, Tyler); Minneapolis, Minnesota; SPS Commerce, Dow Jones, MarketWatch; kubb; the wikis he ran; "via @name"; "recommended by". The page's author also writes "I", so first person alone does not make a note Jamie's.
- page: a coherent passage from the page itself, selected in the browser and saved as the note: a sentence or paragraphs in the article's or the site's own voice, including a site describing itself or its product.
- tool: text a tool put there, not chosen by a person: the opening of an article cut off (often ending in ... or …), a byline or date line, a feed footer, site chrome (Comments, Read more, player controls), the page title glued to the front of a description, or a whole page pasted with navigation and blank lines.
- tweet: a tweet's text (RT @, via @, @handles in the text).
- quoted: the whole note is wrapped in quotation marks.
- mixed: Jamie's own words and an unmarked passage from the page in the same note. Give the split: jamie_text and page_text, each copied verbatim from the note.

Answer with one JSON object and nothing else:
{"kind": "jamie|page|tool|tweet|quoted|mixed", "confidence": "high|medium|low", "jamie_text": "", "page_text": "", "reason": "at most 20 words"}

For mixed, fill both texts verbatim. For tool, put in page_text the one coherent passage worth keeping if there is one inside the junk, else leave it empty. For page, quoted, tweet and jamie leave both texts empty."""


def request_for(post):
    note = clipped(post["extended"].strip())
    host = urlsplit(post["href"]).hostname or ""
    user = (
        f"Saved: {post['time'][:10]}\nTitle: {post['description'].strip()}\nURL: {post['href']}\nHost: {host}\n"
        f"Note:\n<<<\n{note}\n>>>"
    )
    return {"role": "user", "content": user}


def submit(export, out_dir, model):
    _, pool = load_pool(export)
    client = anthropic.Anthropic(api_key=os.environ["CLAUDE_API_KEY"])
    requests = [
        {
            "custom_id": post["hash"],
            "params": {"model": model, "max_tokens": 500, "system": SYSTEM, "messages": [request_for(post)]},
        }
        for post in pool
    ]
    batch = client.messages.batches.create(requests=requests)
    Path(out_dir, f"batch-{model}.json").write_text(json.dumps({"id": batch.id, "model": model, "requests": len(requests), "submitted": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
    print(f"submitted {len(requests)} requests to {model}: batch {batch.id} ({batch.processing_status})")


JSON_RE = re.compile(r"\{.*\}", re.S)
KINDS = {"jamie", "page", "tool", "tweet", "quoted", "mixed"}


def parse(text):
    text = text or ""
    match = JSON_RE.search(text)
    data = None
    if match:
        try:
            data = json.loads(match.group(0))
        except ValueError:
            data = None
    if not isinstance(data, dict):
        # The answer hit max_tokens inside a long page_text: salvage the
        # fields that did arrive whole (kind, confidence, jamie_text).
        data = {}
        for key in ("kind", "confidence", "jamie_text"):
            field = re.search(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"\s*[,}]' % key, text)
            if field:
                data[key] = json.loads('"' + field.group(1) + '"')
        if data:
            data["truncated"] = True
    if data.get("kind") not in KINDS:
        return None
    return {
        "kind": data["kind"],
        "confidence": data.get("confidence") if data.get("confidence") in ("high", "medium", "low") else "low",
        "jamie_text": str(data.get("jamie_text") or ""),
        "page_text": str(data.get("page_text") or ""),
        "reason": str(data.get("reason") or "")[:200],
    }


def collect(export, out_dir, model, batch_id):
    client = anthropic.Anthropic(api_key=os.environ["CLAUDE_API_KEY"])
    batch = client.messages.batches.retrieve(batch_id)
    if batch.processing_status != "ended":
        print(f"{model}: {batch.processing_status}; counts {batch.request_counts}")
        return 3
    posts, pool = load_pool(export)
    by_hash = {p["hash"]: p for p in pool}
    rows, usage_in, usage_out, failed, unparsed = [], 0, 0, 0, 0
    for item in client.messages.batches.results(batch_id):
        post = by_hash.get(item.custom_id)
        if post is None:
            continue
        row = {"hash": item.custom_id, "model": model}
        if item.result.type == "succeeded":
            message = item.result.message
            usage_in += message.usage.input_tokens
            usage_out += message.usage.output_tokens
            text = "".join(block.text for block in message.content if getattr(block, "type", "") == "text")
            parsed = parse(text)
            if parsed is None:
                unparsed += 1
                row.update({"kind": None, "raw": text[:500]})
            else:
                row.update(parsed)
        else:
            failed += 1
            row.update({"kind": None, "error": item.result.type})
        rows.append(row)
    out = Path(out_dir, f"model-{model}.jsonl")
    with out.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    kinds = {}
    for row in rows:
        kinds[row.get("kind")] = kinds.get(row.get("kind"), 0) + 1
    print(f"{model}: {len(rows)} results of {len(pool)}; failed {failed}, unparsed {unparsed}; input {usage_in:,} output {usage_out:,} tokens; kinds {kinds}; wrote {out}")
    return 0


if __name__ == "__main__":
    mode, export, out_dir, model = sys.argv[1:5]
    if mode == "submit":
        submit(export, out_dir, model)
    elif mode == "collect":
        sys.exit(collect(export, out_dir, model, sys.argv[5]))
    else:
        sys.exit("submit or collect")
