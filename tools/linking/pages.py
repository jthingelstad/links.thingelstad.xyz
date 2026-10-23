"""Pages: which saved links to observe, and their records.

docs/DATA.md, "data/enrichment/pages/<yyyy>.json". A record is filed by the
year the link was saved. Liveness is rechecked monthly for a dead page and
quarterly for a live one, by checked; Wayback has its own checked and is
looked up again quarterly.
"""

from . import wayback as wb
from .shards import VERSION, age_days, stamp

METHOD = "enrich_pages"
SHARD_RE = r"\d{4}\.json"
DEAD_RECHECK_DAYS = 30
ALIVE_RECHECK_DAYS = 90
WAYBACK_RECHECK_DAYS = 90


def year_of(link):
    return link["saved"][:4]


def liveness_due(record, now, recheck_after=None):
    """None when not due, else the reason it is."""
    if record is None:
        return "unobserved"
    age = age_days(record.get("checked"), now)
    if age is None:
        return "no checked stamp"
    limit = recheck_after
    if limit is None:
        limit = ALIVE_RECHECK_DAYS if record.get("alive") else DEAD_RECHECK_DAYS
    if age >= limit:
        return f"{'alive' if record.get('alive') else 'dead'}, checked {record.get('checked')}"
    return None


def wayback_due(record, now, recheck_after=None):
    if record is None:
        return None  # Wayback-only runs need a liveness record to attach to
    archived = record.get("wayback")
    if not archived:
        return "no wayback"
    age = age_days(archived.get("checked"), now)
    if age is None or age >= (recheck_after if recheck_after is not None else WAYBACK_RECHECK_DAYS):
        return f"wayback checked {archived.get('checked')}"
    return None


def spread(links, count):
    """count links spread evenly across the years they were saved in.

    Each year gets an equal share (the remainder going to the years with the
    most links); within a year the picks are evenly spaced in saved order, so
    the same input always gives the same sample.
    """
    groups = {}
    for link in links:
        groups.setdefault(year_of(link), []).append(link)
    quota = dict.fromkeys(groups, 0)
    order = sorted(groups, key=lambda year: (-len(groups[year]), year))
    remaining = count
    while remaining > 0:
        gave = False
        for year in order:
            if remaining and quota[year] < len(groups[year]):
                quota[year] += 1
                remaining -= 1
                gave = True
        if not gave:
            break
    chosen = []
    for year in sorted(groups):
        members, wanted = groups[year], quota[year]
        picks = sorted({int((i + 0.5) * len(members) / wanted) for i in range(wanted)}) if wanted else []
        chosen.extend(members[i] for i in picks)
    return chosen


def select(links, store, now, *, mode="liveness", year=None, ids=None, sample=None, limit=None, recheck_after=None):
    """Links to observe, as [(link, reason)].

    mode "liveness" (also the mode that adds Wayback): unobserved links first in
    saved order, then those due by the dead-monthly, alive-quarterly rule (or
    older than recheck_after days), oldest checked first. mode "wayback":
    links with a liveness record and no Wayback answer first, then Wayback
    answers older than the recheck. ids picks links whatever their state. year,
    then sample (spread over years) or limit, narrow the result.
    """
    wanted_ids = set(ids) if ids else None
    fresh, due = [], []
    for link in links:
        if year is not None and year_of(link) != year:
            continue
        if wanted_ids is not None:
            if link["id"] in wanted_ids:
                fresh.append((link, "named"))
            continue
        record = store.get(link["id"])
        if mode == "wayback":
            reason = wayback_due(record, now, recheck_after)
            if reason is None:
                continue
            if reason == "no wayback":
                fresh.append((link, reason))
            else:
                due.append((link, reason, record["wayback"].get("checked") or ""))
            continue
        reason = liveness_due(record, now, recheck_after)
        if reason is None:
            continue
        if reason == "unobserved":
            fresh.append((link, reason))
        else:
            due.append((link, reason, record.get("checked") or ""))
    due.sort(key=lambda item: (item[2], item[0]["saved"], item[0]["id"]))
    chosen = fresh + [(link, reason) for link, reason, _checked in due]
    if sample is not None:
        reasons = {link["id"]: reason for link, reason in chosen}
        chosen = [(link, reasons[link["id"]]) for link in spread([link for link, _ in chosen], sample)]
    if limit is not None:
        chosen = chosen[:limit]
    return chosen


def liveness_record(result, now, previous=None):
    """A page record from a web.follow() result, keeping any earlier Wayback answer."""
    record = {"checked": stamp(now), "method": METHOD, "version": VERSION}
    for field in ("status", "alive", "final_url", "redirects", "content_type", "error"):
        if field in result:
            record[field] = result[field]
    if previous is not None and "wayback" in previous:
        record["wayback"] = previous["wayback"]
    return record


def with_wayback(record, observed, now):
    """record with a fresh wayback object (checked last, as in the contract)."""
    updated = dict(record)
    updated["wayback"] = {**observed, "checked": stamp(now)}
    return updated


def observe_wayback(web, link):
    return wb.observe(web, link["url"])
