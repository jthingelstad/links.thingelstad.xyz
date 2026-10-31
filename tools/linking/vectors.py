"""Linking Things' own vectors (docs/DIRECTION.md, "Nearest neighbours").

Every public link has one vector: Cohere embed-english-v3 on Bedrock, input_type
clustering, made from text() below, the title and the note and never the date,
host or issue. The vectors stay on the Mac in a cache outside the repository
(68 MB, about $0.13 to make again), so they need no backup and never reach git.

Standard library only, like every tool the nightly runs under python3 -I.
Bedrock is reached through the AWS CLI (aws bedrock-runtime invoke-model) with
the cloud-engineer profile; nothing here holds or prints a credential.
"""

import hashlib
import heapq
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from array import array
from pathlib import Path
from urllib.parse import unquote, urlsplit

from . import jsonio
from .urls import normalise

MODEL = "cohere.embed-english-v3"
DIMS = 1024
# The text recipe's version. A change to text() bumps it, and every link is
# embedded again (the cache refuses vectors made from another recipe).
RECIPE = 1
BATCH = 96
NEIGHBOURS = 10

ACCOUNT = "999153317627"
ROLE = "assumed-role/ProjectsCloudEngineer/projects-cloud-engineer"
PROFILE = os.environ.get("LINKS_AWS_PROFILE", "cloud-engineer")
REGION = "us-east-1"

MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
URL = re.compile(r"https?://\S+")
QUOTE = re.compile(r"^\s*>\s?", re.M)
TAG = re.compile(r"<[^>]+>")
# A trailing " | Site" (or " - Site") of 30 characters or fewer.
SUFFIX = re.compile(r"\s+[|–—-]\s+[^|–—-]{1,30}$")
SLUG_JUNK = re.compile(
    r"^(\d+|[0-9a-f]{8,}|index|html?|php|aspx?|www|amp|p|post|posts|blog|article|story|s)$", re.I
)
NOTE_CHARS = 1800
TEXT_CHARS = 2048
SLUG_WORDS = 20


class VectorError(Exception):
    """Bedrock, the AWS CLI or the identity check failed; nothing was embedded."""


def clean_note(note):
    text = MD_LINK.sub(r"\1", note or "")
    text = URL.sub("", text)
    text = QUOTE.sub("", text)
    text = TAG.sub(" ", text)
    return " ".join(text.split())


def slug_words(url):
    path = unquote(urlsplit(url).path)
    words = [
        part.lower()
        for part in re.split(r"[/\-_.+]", path)
        if part and len(part) > 1 and not SLUG_JUNK.match(part)
    ]
    return " ".join(words[:SLUG_WORDS])


def text(link):
    """What a link's vector is made from: its title and cleaned note, or its title
    and the words of its URL's path when it has no note."""
    title = " ".join((link.get("title") or "").split())
    title = SUFFIX.sub("", title) or title
    note = clean_note(link.get("note") or "")
    if note:
        out = f"{title}\n\n{note[:NOTE_CHARS]}"
    else:
        words = slug_words(link["url"])
        out = f"{title}\n\n{words}" if words else title
    return (out or link["url"])[:TEXT_CHARS]


def digest(value):
    """A short fingerprint of a text, so an edited note is embedded again."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def default_dir():
    """The cache's home on the Mac, outside every checkout (LINKS_VECTORS overrides)."""
    override = os.environ.get("LINKS_VECTORS")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / "links.thingelstad.xyz" / "vectors"


class Cache:
    """The vectors, one unit-length float32 row per link.

    On disk: vectors.f32 (the rows, little-endian, in order) and vectors.json
    (the model, recipe and dimensions, the SHA-256 of vectors.f32, and each row's
    id and text digest). The JSON is written last, and a JSON that does not
    describe the rows beside it is no cache, so a run that dies half way costs a
    full embedding, never a vector under the wrong id.
    """

    def __init__(self, rows=None, vectors=None):
        self.rows = list(rows or [])  # [id, digest] in file order
        self.vectors = list(vectors or [])  # one array("f") per row
        self.index = {row[0]: n for n, row in enumerate(self.rows)}

    def __contains__(self, link_id):
        return link_id in self.index

    def __len__(self):
        return len(self.rows)

    def digest_of(self, link_id):
        n = self.index.get(link_id)
        return None if n is None else self.rows[n][1]

    def vector(self, link_id):
        return self.vectors[self.index[link_id]]

    def put(self, link_id, text_digest, vector):
        if len(vector) != DIMS:
            raise VectorError(f"a vector of {len(vector)} dimensions for {link_id}")
        row = unit(vector)
        if link_id in self.index:
            n = self.index[link_id]
            self.rows[n] = [link_id, text_digest]
            self.vectors[n] = row
        else:
            self.index[link_id] = len(self.rows)
            self.rows.append([link_id, text_digest])
            self.vectors.append(row)

    def keep(self, link_ids):
        """Drop every row whose link is not in link_ids. Returns how many went."""
        before = len(self.rows)
        kept = [(row, vec) for row, vec in zip(self.rows, self.vectors) if row[0] in link_ids]
        self.rows = [row for row, _ in kept]
        self.vectors = [vec for _, vec in kept]
        self.index = {row[0]: n for n, row in enumerate(self.rows)}
        return before - len(self.rows)

    @classmethod
    def load(cls, directory):
        """The cache in directory, or an empty one when there is none or it was
        made by another model or recipe (everything is then embedded again)."""
        directory = Path(directory)
        try:
            head = jsonio.load(directory / "vectors.json")
            raw = (directory / "vectors.f32").read_bytes()
        except FileNotFoundError:
            return cls()
        if head.get("model") != MODEL or head.get("recipe") != RECIPE or head.get("dims") != DIMS:
            return cls()
        rows = head["rows"]
        if len(raw) != len(rows) * DIMS * 4 or head.get("sha256") != hashlib.sha256(raw).hexdigest():
            return cls()
        flat = array("f")
        flat.frombytes(raw)
        if flat.itemsize != 4:
            raise VectorError("this Python's array('f') is not 32-bit")
        if sys.byteorder != "little":
            flat.byteswap()
        vectors = [flat[n * DIMS : (n + 1) * DIMS] for n in range(len(rows))]
        return cls(rows, vectors)

    def save(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        flat = array("f")
        for vec in self.vectors:
            flat.extend(vec)
        if sys.byteorder != "little":
            flat.byteswap()
        raw = flat.tobytes()
        jsonio.write_bytes_atomic(directory / "vectors.f32", raw)
        head = {
            "model": MODEL,
            "recipe": RECIPE,
            "dims": DIMS,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "rows": self.rows,
        }
        jsonio.write_bytes_atomic(directory / "vectors.json", (json.dumps(head) + "\n").encode("utf-8"))


def unit(vector):
    row = array("f", vector)
    norm = math.sqrt(math.sumprod(row, row)) or 1.0
    return array("f", (value / norm for value in row))


# ---------- Bedrock, through the AWS CLI ----------


def _aws(args, run=subprocess.run):
    command = ["aws", *args, "--profile", PROFILE, "--region", REGION, "--output", "json"]
    try:
        done = run(command, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VectorError(f"aws {args[0]} {args[1]}: {error}") from None
    if done.returncode != 0:
        last = (done.stderr or "").strip().splitlines()[-1:] or ["no message"]
        raise VectorError(f"aws {args[0]} {args[1]} exited {done.returncode}: {last[0]}")
    return done.stdout


def check_identity(run=subprocess.run):
    """Refuse to call Bedrock as anyone but the cloud-engineer role."""
    try:
        who = json.loads(_aws(["sts", "get-caller-identity"], run))
    except ValueError:
        raise VectorError("aws sts get-caller-identity did not answer JSON") from None
    if who.get("Account") != ACCOUNT or ROLE not in str(who.get("Arn")):
        raise VectorError(f"the AWS identity is {who.get('Arn')}, not the cloud-engineer role")


def embed(texts, run=subprocess.run, progress=None):
    """One vector per text, in order, in batches of 96."""
    out = []
    with tempfile.TemporaryDirectory(prefix="links-embed-") as work:
        body_path = Path(work) / "body.json"
        answer_path = Path(work) / "answer.json"
        for start in range(0, len(texts), BATCH):
            batch = texts[start : start + BATCH]
            body = {"texts": batch, "input_type": "clustering", "truncate": "END"}
            body_path.write_text(json.dumps(body), encoding="utf-8")
            _aws(
                [
                    "bedrock-runtime",
                    "invoke-model",
                    "--model-id",
                    MODEL,
                    "--content-type",
                    "application/json",
                    "--accept",
                    "application/json",
                    "--body",
                    f"fileb://{body_path}",
                    str(answer_path),
                ],
                run,
            )
            try:
                vectors = json.loads(answer_path.read_text(encoding="utf-8"))["embeddings"]
            except (OSError, ValueError, KeyError):
                raise VectorError(f"Bedrock's answer for texts {start} on was not embeddings") from None
            if len(vectors) != len(batch):
                raise VectorError(f"Bedrock sent {len(vectors)} vectors for {len(batch)} texts")
            out.extend(vectors)
            if progress:
                progress(start + len(batch), len(texts))
    return out


# ---------- neighbours ----------


def same_url_key(link):
    """Two saves of one URL share this key; neither is the other's neighbour."""
    return normalise(link["url"])


def similarities(vector, vectors):
    return [math.sumprod(vector, other) for other in vectors]


def nearest(me, ids, vectors, keys, k=NEIGHBOURS, sims=None):
    """The k ids nearest ids[me] by cosine, nearest first, skipping itself and any
    other save of the same URL. Ties go to the earlier row."""
    if sims is None:
        sims = similarities(vectors[me], vectors)
    mine = keys[me]
    best = heapq.nlargest(
        k,
        ((sims[j], -j) for j in range(len(ids)) if j != me and keys[j] != mine),
    )
    return [ids[-negative] for _, negative in best]
