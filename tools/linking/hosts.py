"""Hosts: the set the site files links under, which to check, and the check.

docs/DATA.md, "data/enrichment/hosts/<a-z0-9>.json". The host rule is the
site's (src/lib/normalize.ts hostOf): the URL's netloc, lower case, without
user info, minus one leading "www.". Shards go by the host's first character.
"""

import re
from pathlib import Path
from urllib.parse import urlsplit

from . import jsonio
from .shards import VERSION, age_days, stamp

METHOD = "enrich_hosts"
SHARD_RE = r"[a-z0-9]\.json"
DEFAULT_RECHECK_DAYS = 30
DEFAULT_RDAP_MIN_LINKS = 5  # DIRECTION.md: RDAP for hosts with five or more links
DEFAULT_RDAP_RECHECK_DAYS = 90
YEAR_FILE_RE = re.compile(r"\d{4}\.json")


def host_of(url):
    """The host as the site shows and files it."""
    try:
        netloc = urlsplit(url.strip()).netloc.lower()
    except ValueError:
        return ""
    host = netloc[netloc.rfind("@") + 1 :]
    return host[4:] if host.startswith("www.") else host


def hostname(host):
    """The DNS name of a host (the site's host keeps a port; none do today)."""
    if host.startswith("["):
        return host[1 : host.index("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def shard_of(host):
    first = host[:1]
    return first if re.fullmatch(r"[a-z0-9]", first) else None


def load_links(links_dir):
    """Every public link, oldest year file first, in each file's order."""
    links = []
    for path in sorted(Path(links_dir).iterdir()):
        if YEAR_FILE_RE.fullmatch(path.name):
            links.extend(jsonio.load(path))
    return links


def index(links):
    """{host: {"count", "first"}} with first the earliest saved stamp."""
    hosts = {}
    for link in links:
        host = host_of(link["url"])
        if not host:
            continue
        entry = hosts.setdefault(host, {"count": 0, "first": link["saved"]})
        entry["count"] += 1
        if link["saved"] < entry["first"]:
            entry["first"] = link["saved"]
    return hosts


def select(hosts, existing, now, *, min_links=1, only=None, limit=None, recheck_after=DEFAULT_RECHECK_DAYS):
    """Hosts to check, as [(host, reason)].

    Hosts with at least min_links links qualify. Those with no record come
    first (most links first), then those whose record is at least
    recheck_after days old (oldest checked first). only names hosts to check
    whatever their state. limit applies last.
    """
    unobserved, due = [], []
    for host, entry in hosts.items():
        if entry["count"] < min_links:
            continue
        if only is not None and host not in only:
            continue
        record = existing.get(host)
        if record is None:
            unobserved.append((host, entry))
            continue
        age = age_days(record.get("checked"), now)
        if only is not None:
            due.append((host, entry, record.get("checked") or "", "named"))
        elif age is None or age >= recheck_after:
            due.append((host, entry, record.get("checked") or "", "due"))
    unobserved.sort(key=lambda item: (-item[1]["count"], item[0]))
    due.sort(key=lambda item: (item[2], -item[1]["count"], item[0]))
    chosen = [(host, "unobserved") for host, _entry in unobserved]
    chosen += [(host, f"{reason}, checked {checked or 'never'}") for host, _entry, checked, reason in due]
    return chosen[:limit] if limit is not None else chosen


def wants_rdap(entry, record, now, *, min_links, recheck_after):
    """Whether this check should ask RDAP: enough links, and no fresh answer."""
    if entry["count"] < min_links:
        return False
    if record is None or "rdap" not in record:
        return True
    rdap = record.get("rdap")
    if rdap is None:
        return True  # a refusal or a missing service is worth asking again
    age = age_days(rdap.get("checked"), now)
    return age is None or age >= recheck_after


def check_https(web, name):
    """(the https object, whether http://<name>/ answered at all).

    reachable: an HTTP response came back from https://<name>/ after its
    redirects; status is that response's. redirects_http: http://<name>/
    redirected, and its chain reached an https URL.
    """
    secure, _ = web.follow(f"https://{name}/", cap=0)
    https = {
        "reachable": secure["status"] is not None,
        "redirects_http": False,
        "status": secure["status"],
    }
    if secure["status"] is None:
        https["error"] = secure["error"]
    plain, _ = web.follow(f"http://{name}/", cap=0)
    hops = [plain["final_url"]] + [hop["url"] for hop in plain["redirects"]]
    https["redirects_http"] = bool(plain["redirects"]) and any(url.startswith("https://") for url in hops)
    return https, plain["status"] is not None


def check(host, entry, record, now, *, resolver, web, rdap_client, rdap_wanted):
    """(a fresh host record, whether the host answers over https or http).

    A previous RDAP answer is kept when RDAP is not asked again.
    """
    name = hostname(host)
    dns = resolver.lookup(name)
    answered_http = False
    if dns["resolves"]:
        https, answered_http = check_https(web, name)
    else:
        https = {"reachable": False, "redirects_http": False, "status": None, "error": "does not resolve"}
    fresh = {"checked": stamp(now), "method": METHOD, "version": VERSION, "dns": dns, "https": https}
    if rdap_wanted:
        found, reason = rdap_client.lookup(name)
        if found is not None:
            found["checked"] = stamp(now)
            fresh["rdap"] = found
        else:
            fresh["rdap"] = None
            fresh["rdap_error"] = reason
    elif record is not None and "rdap" in record:
        fresh["rdap"] = record["rdap"]
        if record.get("rdap") is None and "rdap_error" in record:
            fresh["rdap_error"] = record["rdap_error"]
    return fresh, dns["resolves"] and (https["reachable"] or answered_http)
