"""Which notes the page must settle: every note either model called Jamie's
words or mixed, plus the rule probes from decide.probes (attribution lines,
feed bodies). Writes candidates.jsonl for page_check.py. One-shot, 2026-10.

  candidates.py <export> <out_dir>"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decide import probes  # noqa: E402
from pool import load_pool  # noqa: E402

MODELS = ("claude-sonnet-5-5", "claude-opus-5-5")


def read_model(out_dir, model):
    """hash -> vote row; empty while that model's batch is still running, so
    the page check can start on the first model's candidates and resume."""
    rows = {}
    path = Path(out_dir, f"model-{model}.jsonl")
    if not path.exists():
        print(f"no {path.name} yet; candidates come from the other model only", file=sys.stderr)
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["hash"]] = row
    return rows


def main():
    export, out_dir = sys.argv[1], sys.argv[2]
    _, pool = load_pool(export)
    votes = {model: read_model(out_dir, model) for model in MODELS}
    candidates = []
    for post in pool:
        texts = {}
        for model in MODELS:
            vote = votes[model].get(post["hash"]) or {}
            if vote.get("kind") == "jamie":
                texts["note"] = post["extended"].strip()
            elif vote.get("kind") == "mixed":
                if vote.get("jamie_text", "").strip():
                    texts[f"jamie:{model}"] = vote["jamie_text"].strip()
                if vote.get("page_text", "").strip():
                    texts[f"page:{model}"] = vote["page_text"].strip()
        texts.update(probes(post))
        if texts:
            candidates.append({"hash": post["hash"], "url": post["href"], "saved": post["time"][:10],
                               "texts": [{"label": label, "text": text} for label, text in texts.items()]})
    out = Path(out_dir, "candidates.jsonl")
    with out.open("w", encoding="utf-8") as handle:
        for row in candidates:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"{len(candidates)} candidates of {len(pool)} -> {out}")


if __name__ == "__main__":
    main()
