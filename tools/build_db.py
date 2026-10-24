#!/usr/bin/env python3
"""Build public/links.db, the site's data as one SQLite file (npm run db).

DIRECTION.md, "Pages": /links.db is the SQLite database the site is built
from, public fields only. It is read from data/ (the links, the Weekly Thing
join and the enrichment shards), never from pinboard/, and written to
public/, which Astro copies to dist/. public/links.db is not committed; the
build makes it first (npm run build runs npm run db).

Tables:

- links (id, url, title, note, saved, tags, meta, year, host): every public
  link as data/links has it; tags as JSON text, year in US Central, host as
  the site files it (tools/linking/hosts.py host_of);
- hosts (host, links, first, last): every host, its number of links and the
  first and latest saved;
- issues (key, number, slug, title, date, url) and appearances (issue_key,
  position, id, url, text, section): The Weekly Thing join, one appearance
  per link in an issue, id null when the link was never saved;
- host_facts (host, registered, registrar, expires, home_title, generator,
  hcard, webmention, feeds): RDAP and the home page; feeds as JSON text;
- wayback (id, first, last, count, count_capped): the Wayback Machine's
  captures of each page observed;
- facts (id, method, kind, json): the facts tool's record for a link;
- meta (key, value): built_at, the method, the version and the row counts.

Facts only (Jamie, 2026-10-23: "You don't need to validate the links. They
just are."): nothing that says whether a host or page works (dns, https,
status, alive, final_url, redirects, errors) is copied.

The file is deterministic: the same data/ makes the same bytes. Rows go in a
fixed order, the file is written fresh and vacuumed, and built_at is the
newest moment in the data (a link saved or a record checked), not the clock.

Standard library only; run it as python3 -I tools/build_db.py.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

from linking.hosts import host_of  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
METHOD = "build_db"
VERSION = 1
CENTRAL = ZoneInfo("America/Chicago")
YEAR_FILE = re.compile(r"\d{4}\.json")
HOST_SHARD = re.compile(r"[a-z0-9]\.json")
ARCHIVE_KEY = re.compile(r"^https://weekly\.thingelstad\.com/archive/([^/]+)/$")
# Liveness, never copied from a facts record.
LIVENESS = {"alive", "status", "final_url", "redirects", "error", "dns", "https", "content_type"}

SCHEMA = """
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL,
  saved TEXT NOT NULL,
  tags TEXT NOT NULL,
  meta TEXT,
  year INTEGER NOT NULL,
  host TEXT NOT NULL
);
CREATE INDEX links_host ON links (host);
CREATE INDEX links_year ON links (year);
CREATE TABLE hosts (
  host TEXT PRIMARY KEY,
  links INTEGER NOT NULL,
  first TEXT NOT NULL,
  last TEXT NOT NULL
);
CREATE TABLE issues (
  key TEXT PRIMARY KEY,
  number INTEGER,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  url TEXT NOT NULL
);
CREATE TABLE appearances (
  issue_key TEXT NOT NULL REFERENCES issues (key),
  position INTEGER NOT NULL,
  id TEXT REFERENCES links (id),
  url TEXT NOT NULL,
  text TEXT,
  section TEXT,
  PRIMARY KEY (issue_key, position)
);
CREATE INDEX appearances_id ON appearances (id);
CREATE TABLE host_facts (
  host TEXT PRIMARY KEY REFERENCES hosts (host),
  registered TEXT,
  registrar TEXT,
  expires TEXT,
  home_title TEXT,
  generator TEXT,
  hcard INTEGER NOT NULL,
  webmention TEXT,
  feeds TEXT NOT NULL
);
CREATE TABLE wayback (
  id TEXT PRIMARY KEY REFERENCES links (id),
  first TEXT,
  last TEXT,
  count INTEGER NOT NULL,
  count_capped INTEGER NOT NULL
);
CREATE TABLE facts (
  id TEXT PRIMARY KEY REFERENCES links (id),
  method TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def files(folder, pattern):
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if pattern.fullmatch(p.name))


def records(folder, pattern):
    """Every record of every shard in folder, by key, in key order."""
    out = {}
    for path in files(folder, pattern):
        for key, record in read_json(path).items():
            if isinstance(record, dict):
                out[key] = record
    return dict(sorted(out.items()))


def text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def web(value):
    url = text(value)
    return url if url and re.match(r"^https?://", url, re.I) else None


def central_year(saved):
    moment = datetime.fromisoformat(saved.replace("Z", "+00:00"))
    return moment.astimezone(CENTRAL).year


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load(root, enrichment):
    data = root / "data"
    links = [link for path in files(data / "links", YEAR_FILE) for link in read_json(path)]
    links.sort(key=lambda link: (link["saved"], link["id"]))
    issues = read_json(data / "derived/issues.json")["issues"]
    return {
        "links": links,
        "issues": issues,
        "hosts": records(enrichment / "hosts", HOST_SHARD),
        "pages": records(enrichment / "pages", YEAR_FILE),
        "facts": records(enrichment / "facts", YEAR_FILE),
    }


def host_fact_row(host, record):
    """RDAP and the home page; None when there is nothing to show."""
    rdap = record.get("rdap") if isinstance(record.get("rdap"), dict) else {}
    home = record.get("home") if isinstance(record.get("home"), dict) else {}
    if text(home.get("error")):
        home = {}  # a bot wall or a timeout tells nothing about the host
    feeds = [
        {key: feed[key] for key in ("type", "url", "title") if text(feed.get(key))}
        for feed in home.get("feeds") or []
        if isinstance(feed, dict)
        and feed.get("type") in ("rss", "atom", "json")
        and web(feed.get("url"))
    ]
    row = (
        host,
        text(rdap.get("registered")),
        text(rdap.get("registrar")),
        text(rdap.get("expires")),
        text(home.get("title")),
        text(home.get("generator")),
        1 if home.get("hcard") is True else 0,
        web(home.get("webmention")),
        dumps(feeds),
    )
    shown = row[1] or row[4] or row[5] or row[6] or row[7] or feeds
    return row if shown else None


def wayback_row(link_id, record):
    wayback = record.get("wayback")
    if not isinstance(wayback, dict):
        return None
    count = wayback.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return None
    return (
        link_id,
        text(wayback.get("first")),
        text(wayback.get("last")),
        count,
        1 if wayback.get("count_capped") is True else 0,
    )


def fact_row(link_id, record):
    kind, method = text(record.get("kind")), text(record.get("method"))
    if not kind or not method or "error" in record:
        return None  # an adapter that failed observed nothing
    kept = {key: value for key, value in record.items() if key not in LIVENESS}
    return (link_id, method, kind, dumps(kept))


def checked_moments(*groups):
    for group in groups:
        for record in group.values():
            for moment in (record.get("checked"), (record.get("rdap") or {}).get("checked")):
                if text(moment):
                    yield moment


def rows(source):
    """Every table's rows, in a fixed order."""
    links = source["links"]
    ids = {link["id"] for link in links}
    link_rows = [
        (
            link["id"],
            link["url"],
            link["title"],
            link["note"],
            link["saved"],
            dumps(link.get("tags") or []),
            link.get("meta"),
            central_year(link["saved"]),
            host_of(link["url"]),
        )
        for link in links
    ]
    hosts = {}
    for row in link_rows:
        entry = hosts.setdefault(row[8], [0, row[4], row[4]])
        entry[0] += 1
        entry[2] = row[4]  # links are oldest first
    host_rows = [(host, n, first, last) for host, (n, first, last) in sorted(hosts.items())]

    issue_rows, appearance_rows = [], []
    for issue in source["issues"]:
        match = ARCHIVE_KEY.match(issue["url"])
        if not match:
            raise SystemExit(f"issue {issue.get('slug')}: url {issue['url']} has no archive key")
        key = match.group(1)
        issue_rows.append(
            (key, issue.get("number"), issue["slug"], issue["title"], issue["date"], issue["url"])
        )
        for item in sorted(issue["links"], key=lambda item: item["position"]):
            appearance_rows.append(
                (
                    key,
                    item["position"],
                    item["id"] if item.get("id") in ids else None,
                    item["url"],
                    item.get("text"),
                    item.get("section"),
                )
            )

    host_fact_rows = [
        row
        for host, record in source["hosts"].items()
        if host in hosts and (row := host_fact_row(host, record))
    ]
    wayback_rows = [
        row
        for link_id, record in source["pages"].items()
        if link_id in ids and (row := wayback_row(link_id, record))
    ]
    fact_rows = [
        row
        for link_id, record in source["facts"].items()
        if link_id in ids and (row := fact_row(link_id, record))
    ]
    moments = [link["saved"] for link in links] + list(
        checked_moments(source["hosts"], source["pages"], source["facts"])
    )
    built_at = max(
        moments, key=lambda m: datetime.fromisoformat(m.replace("Z", "+00:00")), default=""
    )
    tables = {
        "links": link_rows,
        "hosts": host_rows,
        "issues": issue_rows,
        "appearances": appearance_rows,
        "host_facts": host_fact_rows,
        "wayback": wayback_rows,
        "facts": fact_rows,
    }
    meta = [
        ("built_at", built_at),
        ("method", METHOD),
        ("version", str(VERSION)),
        ("site", "https://links.thingelstad.xyz"),
    ] + [(f"count.{name}", str(len(table))) for name, table in tables.items()]
    tables["meta"] = sorted(meta)
    return tables


def write(tables, out):
    """Write the tables to a fresh file beside out, then move it into place."""
    out.parent.mkdir(parents=True, exist_ok=True)
    temp = out.with_name(out.name + ".tmp")
    if temp.exists():
        temp.unlink()
    db = sqlite3.connect(temp)
    try:
        db.execute("PRAGMA page_size = 4096")
        db.executescript(SCHEMA)
        with db:
            for name, table in tables.items():
                if table:
                    marks = ",".join("?" * len(table[0]))
                    db.executemany(f"INSERT INTO {name} VALUES ({marks})", table)
        db.execute("VACUUM")
    finally:
        db.close()
    os.replace(temp, out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="the repository (data/ inside)")
    parser.add_argument("--out", type=Path, help="the file to write (default public/links.db)")
    parser.add_argument(
        "--enrichment",
        type=Path,
        help="the enrichment shards (default $LINKS_ENRICHMENT or data/enrichment)",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()
    enrichment = args.enrichment or (
        Path(os.environ["LINKS_ENRICHMENT"])
        if os.environ.get("LINKS_ENRICHMENT")
        else root / "data/enrichment"
    )
    out = args.out or root / "public/links.db"
    tables = rows(load(root, enrichment.resolve()))
    write(tables, out)
    counts = ", ".join(f"{len(table)} {name}" for name, table in tables.items() if name != "meta")
    print(f"{out}: {counts}")


if __name__ == "__main__":
    main()
