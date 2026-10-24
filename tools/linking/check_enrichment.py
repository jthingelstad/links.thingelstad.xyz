"""Checks that data/enrichment/ keeps docs/DATA.md, and that public/media/
holds exactly the images the facts records name.

Every shard: the right file name, a JSON object in the canonical format with
sorted keys, keyed by a public host (hosts) or a public link id (pages and
facts) and filed in the shard its key belongs to. Every record: only the
contract's fields, in order, with the right types; no string longer than
MAX_STRING characters anywhere. Messages name the shard, the key and the
field, never a field's value.
"""

import json
import re
from pathlib import Path

from . import adapters, jsonio
from . import facts as facts_mod
from . import hosts as hosts_mod
from . import pages as pages_mod
from . import shards
from .adapters.base import MEDIA_NAME_RE

MAX_STRING = 2000
HOST_SHARD = re.compile(r"[a-z0-9]\.json")
YEAR_SHARD = re.compile(r"\d{4}\.json")

HOST_FIELDS = {
    1: ("checked", "method", "version", "dns", "https"),
    2: ("checked", "method", "version", "dns", "https", "home"),
}
HOST_OPTIONAL = ("rdap", "rdap_error")
DNS_FIELDS = ("resolves", "a", "aaaa", "cname", "ns", "mx")
HTTPS_FIELDS = ("reachable", "redirects_http", "status")
HOME_FIELDS = ("checked", "title", "generator", "feeds", "hcard", "rel_me", "webmention")
FEED_FIELDS = ("type", "url", "title")
FEED_TYPES = ("rss", "atom", "json")
RDAP_FIELDS = ("domain", "registrar", "registered", "expires", "status", "nameservers", "checked")
PAGE_HEADER = ("checked", "method", "version")
LIVENESS_REQUIRED = ("status", "alive", "final_url", "redirects", "content_type")
WAYBACK_FIELDS = ("first", "last", "count")
DATE = re.compile(r"\d{4}-\d\d-\d\d")

# Facts field types; any field not named here is a string or null.
FACT_TYPES = {
    "stars": "count",
    "archived": "bool",
    "fork": "bool",
    "files": "strings",
    "authors": "strings",
    "image": "image",
}


def _stamp(value):
    return shards.parse_stamp(value) is not None


def _str_or_none(value):
    return value is None or isinstance(value, str)


def _int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _web_url(value):
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def fields_problem(value, order, optional=()):
    """None when value has every field of order but those in optional, in that order, and no other."""
    if not isinstance(value, dict):
        return "not an object"
    keys = list(value)
    extra = [key for key in keys if key not in order]
    missing = [key for key in order if key not in value and key not in optional]
    detail = []
    if extra:
        detail.append("unknown " + ", ".join(extra))
    if missing:
        detail.append("missing " + ", ".join(missing))
    if not detail and keys != [key for key in order if key in value]:
        detail.append("fields out of order: " + ", ".join(keys))
    return "; ".join(detail) or None


def long_strings(value, path=""):
    """The paths of every string in value longer than MAX_STRING."""
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            yield path or "(the record)"
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from long_strings(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from long_strings(item, f"{path}[{index}]")


class Checker:
    def __init__(self, report, by_id, media_dir):
        self.report = report
        self.by_id = by_id
        self.media_dir = Path(media_dir)
        self.hosts = hosts_mod.index(by_id.values())
        self.images = set()  # media paths the facts records name
        self.counts = {"hosts": 0, "pages": 0, "facts": 0, "images": 0}

    def error(self, where, message):
        self.report.error(where, message)

    # Shards

    def shards(self, directory, name_re, kind):
        """(where prefix, shard stem, {key: record}) for every readable shard."""
        directory = Path(directory)
        if not directory.is_dir():
            return
        for path in sorted(directory.iterdir()):
            if path.name.startswith("."):
                continue
            if not path.is_file() or not name_re.fullmatch(path.name):
                self.error(str(path), f"not a {kind} shard file")
                continue
            text = path.read_text(encoding="utf-8")
            try:
                records = json.loads(text)
            except ValueError as error:
                self.error(str(path), f"not JSON ({error})")
                continue
            if not isinstance(records, dict):
                self.error(str(path), "not a JSON object keyed by host or id")
                continue
            if not records:
                self.error(str(path), "empty (a shard with no records has no file)")
            if text != jsonio.dumps(records):
                self.error(str(path), "not in the canonical format (indent 1, UTF-8, trailing newline)")
            if list(records) != sorted(records):
                self.error(str(path), "keys are not sorted")
            where = f"{directory.name}/{path.name}"
            for key, record in records.items():
                for field in long_strings(record):
                    self.error(f"{where} {key}", f"{field} is longer than {MAX_STRING:,} characters")
            yield where, path.stem, records

    def header(self, where, record, method, newest):
        if record.get("method") != method:
            self.error(where, f"method is not {method}")
        version = record.get("version")
        if not _int(version) or not 1 <= version <= newest:
            self.error(where, f"version is not 1 to {newest}")
        if not _stamp(record.get("checked")):
            self.error(where, "checked is not YYYY-MM-DDTHH:MM:SSZ")

    def shape(self, where, value, order, optional=()):
        problem = fields_problem(value, order, optional)
        if problem:
            self.error(where, problem)
        return problem is None

    # Hosts

    def check_hosts(self, directory):
        for where, stem, records in self.shards(directory, HOST_SHARD, "hosts"):
            for host, record in records.items():
                here = f"{where} {host}"
                self.counts["hosts"] += 1
                if host not in self.hosts:
                    self.error(here, "is not the host of any public link")
                elif hosts_mod.shard_of(host) != stem:
                    self.error(here, f"belongs in hosts/{hosts_mod.shard_of(host)}.json")
                if not isinstance(record, dict):
                    self.error(here, "not an object")
                    continue
                version = record.get("version")
                required = HOST_FIELDS.get(version, HOST_FIELDS[hosts_mod.VERSION])
                self.header(here, record, hosts_mod.METHOD, hosts_mod.VERSION)
                if not self.shape(here, record, required + HOST_OPTIONAL, HOST_OPTIONAL):
                    continue
                self.dns(here, record["dns"])
                self.https(here, record["https"])
                if "home" in record:
                    self.home(here, record["home"], record["checked"])
                self.rdap(here, record)

    def dns(self, where, dns):
        where = f"{where} dns"
        if not self.shape(where, dns, DNS_FIELDS + ("error",), ("error",)):
            return
        if not isinstance(dns["resolves"], bool) or not isinstance(dns["mx"], bool):
            self.error(where, "resolves and mx are not booleans")
        if not all(_strings(dns[field]) for field in ("a", "aaaa", "ns")):
            self.error(where, "a, aaaa and ns are not lists of strings")
        if not _str_or_none(dns["cname"]) or not _str_or_none(dns.get("error")):
            self.error(where, "cname or error is not a string")

    def https(self, where, https):
        where = f"{where} https"
        if not self.shape(where, https, HTTPS_FIELDS + ("error",), ("error",)):
            return
        if not isinstance(https["reachable"], bool) or not isinstance(https["redirects_http"], bool):
            self.error(where, "reachable and redirects_http are not booleans")
        if https["status"] is not None and not _int(https["status"]):
            self.error(where, "status is not an integer or null")
        if not _str_or_none(https.get("error")):
            self.error(where, "error is not a string")

    def home(self, where, home, checked):
        where = f"{where} home"
        if not self.shape(where, home, HOME_FIELDS + ("error",), ("error",)):
            return
        if home["checked"] != checked:
            self.error(where, "checked is not the record's checked (one request reads both)")
        if not _str_or_none(home["title"]) or not _str_or_none(home["generator"]):
            self.error(where, "title and generator are not strings or null")
        if not _str_or_none(home.get("error")):
            self.error(where, "error is not a string")
        if not isinstance(home["hcard"], bool):
            self.error(where, "hcard is not a boolean")
        if not _strings(home["rel_me"]) or not all(_web_url(url) for url in home["rel_me"]):
            self.error(where, "rel_me is not a list of http(s) URLs")
        if home["webmention"] is not None and not _web_url(home["webmention"]):
            self.error(where, "webmention is not an http(s) URL or null")
        feeds = home["feeds"]
        if not isinstance(feeds, list):
            self.error(where, "feeds is not a list")
            return
        for index, feed in enumerate(feeds):
            fwhere = f"{where} feeds[{index}]"
            if not self.shape(fwhere, feed, FEED_FIELDS):
                continue
            if feed["type"] not in FEED_TYPES:
                self.error(fwhere, "type is not rss, atom or json")
            if not _web_url(feed["url"]) or not _str_or_none(feed["title"]):
                self.error(fwhere, "url is not an http(s) URL, or title is not a string or null")

    def rdap(self, where, record):
        if "rdap" not in record:
            if "rdap_error" in record:
                self.error(where, "rdap_error without rdap")
            return
        rdap = record["rdap"]
        if rdap is None:
            if not isinstance(record.get("rdap_error"), str):
                self.error(where, "rdap is null without an rdap_error saying why")
            return
        if "rdap_error" in record:
            self.error(where, "rdap_error beside an rdap answer")
        where = f"{where} rdap"
        if not self.shape(where, rdap, RDAP_FIELDS):
            return
        if not isinstance(rdap["domain"], str) or not _str_or_none(rdap["registrar"]):
            self.error(where, "domain or registrar is not a string")
        for field in ("registered", "expires"):
            if rdap[field] is not None and not (isinstance(rdap[field], str) and DATE.fullmatch(rdap[field])):
                self.error(where, f"{field} is not YYYY-MM-DD or null")
        if not _strings(rdap["status"]) or not _strings(rdap["nameservers"]):
            self.error(where, "status and nameservers are not lists of strings")
        if not _stamp(rdap["checked"]):
            self.error(where, "checked is not YYYY-MM-DDTHH:MM:SSZ")

    # Pages

    def link_for(self, where, key, stem, directory):
        link = self.by_id.get(key)
        if link is None:
            self.error(where, "is not the id of a public link")
            return None
        year = link["saved"][:4]
        if year != stem:
            self.error(where, f"belongs in {directory}/{year}.json, the year its link was saved")
        return link

    def check_pages(self, directory):
        for where, stem, records in self.shards(directory, YEAR_SHARD, "pages"):
            for key, record in records.items():
                here = f"{where} {key}"
                self.counts["pages"] += 1
                self.link_for(here, key, stem, "pages")
                if not isinstance(record, dict):
                    self.error(here, "not an object")
                    continue
                self.header(here, record, pages_mod.METHOD, shards.VERSION)
                liveness = [field for field in pages_mod.LIVENESS_FIELDS if field in record]
                if liveness and "alive" not in record:
                    self.error(
                        here,
                        "liveness fields with no liveness check (a Wayback-only record has only "
                        "checked, method, version, wayback): " + ", ".join(liveness),
                    )
                    continue
                if not liveness:
                    if self.shape(here, record, PAGE_HEADER + ("wayback",)):
                        self.wayback(here, record["wayback"])
                    continue
                order = PAGE_HEADER + LIVENESS_REQUIRED + ("error", "wayback")
                if not self.shape(here, record, order, ("error", "wayback")):
                    continue
                self.liveness(here, record)
                if "wayback" in record:
                    self.wayback(here, record["wayback"])

    def liveness(self, where, record):
        if record["status"] is not None and not _int(record["status"]):
            self.error(where, "status is not an integer or null")
        if not isinstance(record["alive"], bool):
            self.error(where, "alive is not a boolean")
        for field in ("final_url", "content_type", "error"):
            if not _str_or_none(record.get(field)):
                self.error(where, f"{field} is not a string or null")
        redirects = record["redirects"]
        if not isinstance(redirects, list) or not all(
            fields_problem(hop, ("status", "url")) is None and _int(hop["status"]) and isinstance(hop["url"], str)
            for hop in redirects
        ):
            self.error(where, "redirects is not a list of {status, url}")

    def wayback(self, where, wayback):
        where = f"{where} wayback"
        if not self.shape(where, wayback, WAYBACK_FIELDS + ("count_capped", "checked"), ("count_capped",)):
            return
        for field in ("first", "last"):
            if wayback[field] is not None and not _stamp(wayback[field]):
                self.error(where, f"{field} is not YYYY-MM-DDTHH:MM:SSZ or null")
        if not _int(wayback["count"]) or wayback["count"] < 0:
            self.error(where, "count is not a count")
        if "count_capped" in wayback and wayback["count_capped"] is not True:
            self.error(where, "count_capped is not true")
        if not _stamp(wayback["checked"]):
            self.error(where, "checked is not YYYY-MM-DDTHH:MM:SSZ")

    # Facts

    def check_facts(self, directory):
        for where, stem, records in self.shards(directory, YEAR_SHARD, "facts"):
            for key, record in records.items():
                here = f"{where} {key}"
                self.counts["facts"] += 1
                link = self.link_for(here, key, stem, "facts")
                if not isinstance(record, dict):
                    self.error(here, "not an object")
                    continue
                adapter = adapters.for_link(link) if link else adapters.BY_METHOD.get(record.get("method"))
                if adapter is None:
                    self.error(here, "no adapter applies to this link" if link else "method is not a known adapter")
                    continue
                self.header(here, record, adapter.METHOD, adapter.VERSION)
                if record.get("kind") != adapter.KIND:
                    self.error(here, f"kind is not {adapter.KIND}")
                if "error" in record:
                    if self.shape(here, record, adapters.COMMON_FIELDS + ("error",)) and not isinstance(
                        record["error"], str
                    ):
                        self.error(here, "error is not a string")
                    continue
                problems = [fields_problem(record, adapters.COMMON_FIELDS + shape) for shape in adapter.SHAPES]
                if all(problems):
                    self.error(here, f"not a {adapter.METHOD} record: {problems[0]}")
                    continue
                self.fact_types(here, record, adapter)

    def fact_types(self, where, record, adapter):
        for field, value in record.items():
            if field in adapters.COMMON_FIELDS:
                continue
            kind = FACT_TYPES.get(field, "text")
            if kind == "text" and not _str_or_none(value):
                self.error(where, f"{field} is not a string or null")
            elif kind == "count" and value is not None and not (_int(value) and value >= 0):
                self.error(where, f"{field} is not a count or null")
            elif kind == "bool" and not isinstance(value, bool):
                self.error(where, f"{field} is not a boolean")
            elif kind == "strings" and not _strings(value):
                self.error(where, f"{field} is not a list of strings")
            elif kind == "image" and value is not None:
                self.image(where, value, adapter)

    def image(self, where, value, adapter):
        prefix = f"/media/{adapter.MEDIA}/"
        well_formed = isinstance(value, str) and value.startswith(prefix) and value.endswith(".jpg")
        name = value[len(prefix) : -len(".jpg")] if well_formed else ""
        if not adapter.MEDIA or not MEDIA_NAME_RE.fullmatch(name):
            self.error(where, f"image is not {prefix}<name>.jpg")
            return
        relative = value[len("/media/") :]
        self.images.add(relative)
        if not (self.media_dir / relative).is_file():
            self.error(where, f"image public{value} does not exist")

    def check_media(self):
        """Every file under public/media/ is an image a facts record names."""
        if not self.media_dir.is_dir():
            return
        for path in sorted(self.media_dir.rglob("*")):
            relative = path.relative_to(self.media_dir)
            if any(part.startswith(".") for part in relative.parts) or path.is_dir():
                continue
            self.counts["images"] += 1
            where = f"public/media/{relative.as_posix()}"
            if len(relative.parts) != 2 or relative.parts[0] not in facts_mod.MEDIA_DIRS:
                self.error(where, "is not in an enrich_facts.py media directory (only that tool writes here)")
            elif relative.as_posix() not in self.images:
                self.error(where, "no facts record names this image (enrich_facts.py removes these)")


def check_enrichment(report, enrichment_dir, by_id, media_dir):
    """Check the three shard directories and public/media/. Returns record counts."""
    checker = Checker(report, by_id, media_dir)
    enrichment_dir = Path(enrichment_dir)
    checker.check_hosts(enrichment_dir / "hosts")
    checker.check_pages(enrichment_dir / "pages")
    checker.check_facts(enrichment_dir / "facts")
    checker.check_media()
    return checker.counts
