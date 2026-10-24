"""Facts from special hosts: which links to ask about, their records, and the
images under public/media/.

docs/DATA.md, "data/enrichment/facts/<yyyy>.json". A record is keyed by link
id and filed by the year the link was saved, like pages. Each carries
checked, method, version and kind, then either the adapter's fields or error.
Rechecks: every 90 days, 30 for a record that is an error, and at once when
the adapter's method or version changed.
"""

from .adapters import ADAPTERS, for_link
from .shards import age_days, stamp

SHARD_RE = r"\d{4}\.json"
RECHECK_DAYS = 90
ERROR_RECHECK_DAYS = 30
MEDIA_DIRS = tuple(adapter.MEDIA for adapter in ADAPTERS if adapter.MEDIA)


def year_of(link):
    return link["saved"][:4]


def plan(links):
    """{id: adapter} for every link an adapter applies to."""
    chosen = {}
    for link in links:
        adapter = for_link(link)
        if adapter is not None:
            chosen[link["id"]] = adapter
    return chosen


def due(record, adapter, now, recheck_after=None):
    """None when the record is fresh, else the reason it is due."""
    if record is None:
        return "unobserved"
    if record.get("method") != adapter.METHOD:
        return f"method {record.get('method')}, now {adapter.METHOD}"
    version = record.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < adapter.VERSION:
        return f"version {version}, now {adapter.VERSION}"
    age = age_days(record.get("checked"), now)
    if age is None:
        return "no checked stamp"
    failed = "error" in record
    limit = recheck_after if recheck_after is not None else (ERROR_RECHECK_DAYS if failed else RECHECK_DAYS)
    if age >= limit:
        return f"{'error' if failed else 'facts'}, checked {record.get('checked')}"
    return None


def select(links, adapters_by_id, store, now, *, methods=None, ids=None, limit=None, recheck_after=None):
    """[(link, adapter, reason)]: unobserved links first in saved order, then
    due ones, oldest checked first. methods keeps those adapters; ids picks
    links whatever their state. limit applies last."""
    wanted = set(ids) if ids else None
    fresh, stale = [], []
    for link in links:
        adapter = adapters_by_id.get(link["id"])
        if adapter is None or (methods and adapter.METHOD not in methods):
            continue
        if wanted is not None:
            if link["id"] in wanted:
                fresh.append((link, adapter, "named"))
            continue
        record = store.get(link["id"])
        reason = due(record, adapter, now, recheck_after)
        if reason is None:
            continue
        if record is None:
            fresh.append((link, adapter, reason))
        else:
            stale.append((record.get("checked") or "", link, adapter, reason))
    stale.sort(key=lambda item: (item[0], item[1]["saved"], item[1]["id"]))
    chosen = fresh + [(link, adapter, reason) for _checked, link, adapter, reason in stale]
    return chosen[:limit] if limit is not None else chosen


def header(adapter, now):
    return {"checked": stamp(now), "method": adapter.METHOD, "version": adapter.VERSION, "kind": adapter.KIND}


def facts_record(adapter, fields, now):
    """A record with the adapter's fields, in the order of the shape they match."""
    shape = next((s for s in adapter.SHAPES if list(fields) == list(s)), None)
    if shape is None:
        raise ValueError(f"{adapter.METHOD} returned fields {list(fields)}, not one of its shapes")
    return {**header(adapter, now), **fields}


def error_record(adapter, reason, now):
    return {**header(adapter, now), "error": str(reason)}


def has_facts(record, adapter):
    return record is not None and record.get("method") == adapter.METHOD and "error" not in record


def images(records):
    """Every image path the records name (/media/<dir>/<name>.jpg)."""
    found = set()
    for _key, record in records:
        image = record.get("image") if isinstance(record, dict) else None
        if isinstance(image, str):
            found.add(image)
    return found


def prune_media(media_dir, referenced):
    """Remove images under the adapters' media directories that no record
    names (a link made private takes its thumbnail with it). Returns the
    site paths removed."""
    removed = []
    for subdir in MEDIA_DIRS:
        directory = media_dir / subdir
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if path.name.startswith(".") or not path.is_file() or path.suffix != ".jpg":
                continue
            site_path = f"/media/{subdir}/{path.name}"
            if site_path not in referenced:
                path.unlink()
                removed.append(site_path)
    return removed

