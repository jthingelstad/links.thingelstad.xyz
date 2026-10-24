"""Special-host adapters for enrich_facts.py (docs/DATA.md, "data/enrichment/facts/<yyyy>.json").

ADAPTERS is the registry, in the order they are asked; their hosts do not
overlap, so at most one applies to a link. base.py has the contract.
"""

from . import github, openlibrary, vimeo, wikipedia, youtube

ADAPTERS = (youtube, vimeo, github, wikipedia, openlibrary)
BY_METHOD = {adapter.METHOD: adapter for adapter in ADAPTERS}
COMMON_FIELDS = ("checked", "method", "version", "kind")


def for_link(link):
    """The adapter that applies to this link record, or None."""
    for adapter in ADAPTERS:
        if adapter.match(link["url"]) is not None:
            return adapter
    return None


def applies(adapter, link):
    return adapter.match(link["url"]) is not None
