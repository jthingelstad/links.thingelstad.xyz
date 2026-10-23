"""Checks that data/ keeps docs/DATA.md. Every problem is collected, not just the first."""

import json
import os
import re
from datetime import datetime
from pathlib import Path

from . import issues as issues_mod
from . import jsonio
from .pinboard import RECORD_FIELDS, STATE_FIELDS
from .urls import md5_hex

HEX12 = re.compile(r"[0-9a-f]{12}")
HEX32 = re.compile(r"[0-9a-f]{32}")
SAVED = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
YEAR_FILE = re.compile(r"(\d{4})\.json")

# Things that look like a credential. Messages name the pattern and the line,
# never the matched text.
CREDENTIAL_PATTERNS = (
    ("an auth_token parameter", re.compile(r"auth_token=", re.IGNORECASE)),
    ("a hex token after 'token'", re.compile(r"token[\"'\s:=]{1,4}[0-9a-f]{20,}", re.IGNORECASE)),
    ("a Pinboard API token (user:HEX)", re.compile(r"\b[A-Za-z0-9_.-]+:[0-9A-F]{20}\b")),
)


class Report:
    def __init__(self):
        self.errors = []

    def error(self, where, message):
        self.errors.append(f"{where}: {message}")

    @property
    def ok(self):
        return not self.errors


def _valid_stamp(text):
    if not isinstance(text, str) or not SAVED.fullmatch(text):
        return False
    try:
        datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def check_record(report, where, record, year):
    if not isinstance(record, dict):
        report.error(where, "not an object")
        return False
    keys = list(record)
    if "shared" in record:
        report.error(where, "has a 'shared' field: a raw Pinboard bookmark, possibly private")
    if keys != list(RECORD_FIELDS):
        extra = [key for key in keys if key not in RECORD_FIELDS]
        missing = [key for key in RECORD_FIELDS if key not in record]
        detail = []
        if extra:
            detail.append("unknown " + ", ".join(extra))
        if missing:
            detail.append("missing " + ", ".join(missing))
        if not detail:
            detail.append("fields out of order: " + ", ".join(keys))
        report.error(where, "; ".join(detail))
        if missing:
            return False
    url = record["url"]
    if not isinstance(url, str) or not url:
        report.error(where, "url is not a non-empty string")
        return False
    digest = md5_hex(url)
    if not isinstance(record["id"], str) or not HEX12.fullmatch(record["id"]):
        report.error(where, f"id {record['id']!r} is not 12 lower-case hex characters")
    elif record["id"] != digest[:12]:
        report.error(where, f"id {record['id']} is not md5(url)[:12] ({digest[:12]})")
    if not isinstance(record["hash"], str) or not HEX32.fullmatch(record["hash"]):
        report.error(where, "hash is not 32 lower-case hex characters")
    elif record["hash"] != digest:
        report.error(where, "hash is not md5(url)")
    for field in ("title", "note"):
        if not isinstance(record[field], str):
            report.error(where, f"{field} is not a string")
    if not _valid_stamp(record["saved"]):
        report.error(where, f"saved {record['saved']!r} is not YYYY-MM-DDTHH:MM:SSZ")
    elif record["saved"][:4] != year:
        report.error(where, f"saved {record['saved']} is not in {year}, the year of its file")
    tags = record["tags"]
    if not isinstance(tags, list) or not all(
        isinstance(tag, str) and tag and not re.search(r"\s", tag) for tag in tags
    ):
        report.error(where, "tags is not a list of tags")
    if not isinstance(record["toread"], bool):
        report.error(where, "toread is not a boolean")
    if not isinstance(record["meta"], str) or not HEX32.fullmatch(record["meta"]):
        report.error(where, "meta is not 32 lower-case hex characters")
    return True


def check_links(report, links_dir):
    """Returns {id: record} for every record that could be read."""
    by_id = {}
    links_dir = Path(links_dir)
    if not links_dir.is_dir():
        report.error(str(links_dir), "missing")
        return by_id
    for path in sorted(links_dir.iterdir()):
        if path.name.startswith("."):
            continue
        match = YEAR_FILE.fullmatch(path.name)
        if not match:
            report.error(str(path), "not a <yyyy>.json links file")
            continue
        year = match.group(1)
        text = path.read_text(encoding="utf-8")
        try:
            records = json.loads(text)
        except ValueError as error:
            report.error(str(path), f"not JSON ({error})")
            continue
        if not isinstance(records, list):
            report.error(str(path), "not a JSON array")
            continue
        if not records:
            report.error(str(path), "empty (a year with no public links has no file)")
        if text != jsonio.dumps(records):
            report.error(str(path), "not in the canonical format (indent 1, UTF-8, trailing newline)")
        previous = None
        for index, record in enumerate(records):
            where = f"{path.name}[{index}]"
            if not check_record(report, where, record, year):
                continue
            if record["id"] in by_id:
                report.error(where, f"duplicate id {record['id']}")
            else:
                by_id[record["id"]] = record
            key = (str(record["saved"]), str(record["id"]))
            if previous is not None and key <= previous:
                report.error(where, "out of order (sorted by saved then id, no repeats)")
            previous = key
    return by_id


def check_private(report, by_id, raw_path):
    """With the raw export at hand, no public record may be a private bookmark."""
    raw_path = Path(raw_path)
    if not raw_path.is_file():
        return False
    try:
        posts = jsonio.load(raw_path)
        private = {post["hash"][:12] for post in posts if post.get("shared") != "yes"}
    except (ValueError, KeyError, TypeError, AttributeError):
        report.error(str(raw_path), "unreadable, so the private-bookmark check could not run")
        return False
    for link_id in sorted(private & set(by_id)):
        report.error(f"links {link_id}", "is a private bookmark (shared=no at Pinboard)")
    return True


def check_issues(report, path, by_id):
    """Returns (issues, linked ids, unmatched rows), or None when unreadable."""
    path = Path(path)
    if not path.is_file():
        report.error(str(path), "missing")
        return None
    text = path.read_text(encoding="utf-8")
    try:
        document = json.loads(text)
    except ValueError as error:
        report.error(str(path), f"not JSON ({error})")
        return None
    if text != jsonio.dumps(document):
        report.error(str(path), "not in the canonical format (indent 1, UTF-8, trailing newline)")
    if not isinstance(document, dict) or list(document) != ["source", "issues"]:
        report.error(str(path), "must be an object with exactly source, issues")
        return None
    if document["source"] != issues_mod.SOURCE:
        report.error(str(path), f"source is not {issues_mod.SOURCE!r}")
    issues = document["issues"]
    if not isinstance(issues, list):
        report.error(str(path), "issues is not a list")
        return None
    linked, unmatched = set(), 0
    slugs, numbers, previous = set(), set(), None
    for index, issue in enumerate(issues):
        where = f"issues.json issue {index}"
        if not isinstance(issue, dict) or list(issue) != list(issues_mod.ISSUE_FIELDS):
            report.error(where, "fields are not exactly " + ", ".join(issues_mod.ISSUE_FIELDS))
            continue
        where = f"issues.json {issue['slug']}"
        number = issue["number"]
        if number is not None and (isinstance(number, bool) or not isinstance(number, int)):
            report.error(where, "number is not an integer or null")
        elif number is not None:
            if number in numbers:
                report.error(where, f"duplicate number {number}")
            numbers.add(number)
        if not isinstance(issue["slug"], str) or not issue["slug"]:
            report.error(where, "slug is not a non-empty string")
        elif issue["slug"] in slugs:
            report.error(where, "duplicate slug")
        slugs.add(issue["slug"])
        for field in ("title", "subject"):
            if not isinstance(issue[field], str):
                report.error(where, f"{field} is not a string")
        if not isinstance(issue["date"], str) or not issues_mod.DATE_RE.fullmatch(issue["date"]):
            report.error(where, f"date {issue['date']!r} is not an ISO 8601 UTC time")
        if not isinstance(issue["url"], str) or not issue["url"].startswith(
            issues_mod.SITE + "/archive/"
        ):
            report.error(where, "url is not an issue on weekly.thingelstad.com")
        key = (str(issue["date"]), str(issue["slug"]))
        if previous is not None and key <= previous:
            report.error(where, "out of order (sorted by date then slug)")
        previous = key
        if not isinstance(issue["links"], list):
            report.error(where, "links is not a list")
            continue
        for position, link in enumerate(issue["links"]):
            lwhere = f"{where} link {position}"
            if not isinstance(link, dict) or list(link) != list(issues_mod.LINK_FIELDS):
                report.error(lwhere, "fields are not exactly " + ", ".join(issues_mod.LINK_FIELDS))
                continue
            if link["position"] != position:
                report.error(lwhere, f"position {link['position']!r} (positions run 0, 1, 2, ...)")
            if link["id"] is None:
                unmatched += 1
            elif link["id"] not in by_id:
                report.error(lwhere, f"id {link['id']!r} is not a saved link")
            else:
                linked.add(link["id"])
            if not isinstance(link["url"], str) or not link["url"]:
                report.error(lwhere, "url is not a non-empty string")
            for field in ("text", "section", "heading_context"):
                if link[field] is not None and not isinstance(link[field], str):
                    report.error(lwhere, f"{field} is not a string or null")
    return len(issues), len(linked), unmatched


def check_state(report, path, public):
    path = Path(path)
    if not path.is_file():
        return
    try:
        state = jsonio.load(path)
    except ValueError as error:
        report.error(str(path), f"not JSON ({error})")
        return
    if not isinstance(state, dict) or list(state) != list(STATE_FIELDS):
        report.error(str(path), "fields are not exactly " + ", ".join(STATE_FIELDS))
        return
    for field in ("updated", "fetched_at"):
        if state[field] is not None and not _valid_stamp(state[field]):
            report.error(str(path), f"{field} is not YYYY-MM-DDTHH:MM:SSZ or null")
    if state["public"] != public:
        report.error(str(path), f"public is {state['public']!r} but the links hold {public}")
    if not isinstance(state["total"], int) or state["total"] < public:
        report.error(str(path), "total is not a count at least as large as public")


def scan_credentials(report, data_dir, token=None):
    """Any data file with something that looks like a credential fails."""
    secrets = []
    if token:
        secrets.append(token)
        secret = token.split(":", 1)[-1]
        if len(secret) >= 8:
            secrets.append(secret)
    for root, dirs, files in os.walk(data_dir):
        dirs.sort()
        for name in sorted(files):
            path = Path(root) / name
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                report.error(str(path), "not readable as UTF-8 text, so it could not be scanned")
                continue
            for number, line in enumerate(text.split("\n"), start=1):
                for label, pattern in CREDENTIAL_PATTERNS:
                    if pattern.search(line):
                        report.error(f"{path}:{number}", f"looks like a credential ({label})")
                if any(secret in line for secret in secrets):
                    report.error(f"{path}:{number}", "contains the PINBOARD_API_TOKEN value")


def validate(data_dir, raw_path=None, token=None):
    """Run every check. Returns (report, summary dict)."""
    data_dir = Path(data_dir)
    report = Report()
    by_id = check_links(report, data_dir / "links")
    years = {record["saved"][:4] for record in by_id.values()}
    private_checked = check_private(report, by_id, raw_path) if raw_path else False
    counts = check_issues(report, data_dir / "derived" / "issues.json", by_id)
    check_state(report, data_dir / "sync.json", len(by_id))
    scan_credentials(report, data_dir, token)
    issues, linked, unmatched = counts if counts else (0, 0, 0)
    summary = {
        "links": len(by_id),
        "years": len(years),
        "issues": issues,
        "linked_ids": linked,
        "unmatched": unmatched,
        "private_checked": private_checked,
    }
    return report, summary
