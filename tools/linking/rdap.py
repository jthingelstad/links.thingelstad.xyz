"""RDAP, WHOIS's JSON successor: who registered a host's domain, and when.

docs/DATA.md, "Enrichment (phase 2)". Queries go to the bootstrap redirector
https://rdap.org/domain/<domain>, which 302s to the registry's own server
(Verisign for .com and .net, PIR for .org, and so on); rdap.org answers 404
itself when the top-level domain has no RDAP service at all.

The registrable domain is found by asking: the obvious candidate first (the
last two labels, or three under a known two-level suffix such as co.uk), then
the longer names from the full host down, stripping labels from the left until
the registry answers. Every answer, found or not, is cached per domain for the
run, and a top-level domain without RDAP is remembered too, so hosts that
share a domain (blog.example.com, example.com) cost one call between them.
"""

import json
import re
from urllib.parse import urlsplit

from .dns import is_ip

RDAP_BASE = "https://rdap.org/domain/"
RDAP_CAP = 1024 * 1024
ACCEPT = "application/rdap+json, application/json;q=0.9"

# Second-level public suffixes, enough that the obvious cases cost one call.
# A host under a suffix missing here still resolves, a call or two later.
TWO_LEVEL_SUFFIXES = frozenset(
    """
    co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk
    com.au net.au org.au edu.au gov.au asn.au id.au
    co.nz net.nz org.nz ac.nz govt.nz geek.nz school.nz
    co.jp ne.jp or.jp ac.jp go.jp
    com.br net.br org.br gov.br
    co.za org.za ac.za gov.za
    co.il org.il ac.il
    co.in net.in org.in
    co.kr com.cn net.cn org.cn com.hk com.tw com.sg com.mx com.ar com.tr
    gov.ua com.ua ac.cy
    """.split()
)

NOT_HERE_STATUSES = (400, 404, 422)  # the registry does not hold this name
EPP_STATUS_RE = re.compile(r"(?<!^)(?=[A-Z])")


def registrable_guess(host):
    """The likely registered domain: example.com, or example.co.uk."""
    labels = host.lower().rstrip(".").split(".")
    if len(labels) >= 3 and ".".join(labels[-2:]) in TWO_LEVEL_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def candidates(host):
    """Domains to ask the registry for, in order: the guess, then longer names.

    The longer names go from the full host down, which is "strip labels from
    the left until RDAP answers". Never the top-level domain alone.
    """
    host = host.lower().rstrip(".")
    guess = registrable_guess(host)
    labels = host.split(".")
    order = [guess]
    for start in range(len(labels) - 1):
        name = ".".join(labels[start:])
        if name != guess and len(name) > len(guess):
            order.append(name)
    return order


def _vcard_fn(entity):
    vcard = entity.get("vcardArray")
    if not (isinstance(vcard, list) and len(vcard) == 2 and isinstance(vcard[1], list)):
        return None
    for prop in vcard[1]:
        if isinstance(prop, list) and len(prop) >= 4 and prop[0] == "fn":
            value = prop[3]
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _entities(doc):
    """Every entity, top level first, then the nested ones."""
    queue = list(doc.get("entities") or [])
    while queue:
        entity = queue.pop(0)
        if isinstance(entity, dict):
            yield entity
            queue.extend(entity.get("entities") or [])


def _registrar(doc):
    for entity in _entities(doc):
        roles = [str(role).lower() for role in entity.get("roles") or []]
        if "registrar" not in roles:
            continue
        name = _vcard_fn(entity)
        if name:
            return name
        handle = entity.get("handle")
        if isinstance(handle, str) and handle.strip():
            return handle.strip()
        for public_id in entity.get("publicIds") or []:
            if isinstance(public_id, dict) and public_id.get("identifier"):
                return f"{public_id.get('type', 'id')} {public_id['identifier']}"
    return None


def _date(value):
    if isinstance(value, str) and re.match(r"\d{4}-\d\d-\d\d", value):
        return value[:10]
    return None


def _status_words(value):
    """RDAP status words; EPP-style "clientTransferProhibited" becomes words too."""
    text = str(value).strip()
    if " " not in text and any(ch.isupper() for ch in text[1:]):
        text = EPP_STATUS_RE.sub(" ", text)
    return text.lower()


def parse_domain(doc, domain):
    """The rdap object of a host record from an RDAP domain response.

    registrar is the vCard name of the entity with the registrar role;
    registered and expires are the dates (YYYY-MM-DD, UTC) of the registration
    and expiration events; status and nameservers are sorted, lower case.
    """
    if not isinstance(doc, dict) or doc.get("objectClassName", "domain") != "domain":
        raise ValueError("not an RDAP domain object")
    events = {}
    for event in doc.get("events") or []:
        if isinstance(event, dict):
            action = str(event.get("eventAction", "")).lower()
            date = _date(event.get("eventDate"))
            if action and date and action not in events:
                events[action] = date
    nameservers = set()
    for server in doc.get("nameservers") or []:
        if isinstance(server, dict) and isinstance(server.get("ldhName"), str):
            nameservers.add(server["ldhName"].rstrip(".").lower())
    status = sorted({_status_words(value) for value in doc.get("status") or [] if str(value).strip()})
    return {
        "domain": domain,
        "registrar": _registrar(doc),
        "registered": events.get("registration"),
        "expires": events.get("expiration"),
        "status": status,
        "nameservers": sorted(nameservers),
    }


class Outcome:
    """One registry answer: found (with the record), not_found, no_service or refused."""

    __slots__ = ("kind", "record", "reason")

    def __init__(self, kind, record=None, reason=None):
        self.kind = kind
        self.record = record
        self.reason = reason


class Client:
    """RDAP lookups through rdap.org with the shared web client and a per-run cache."""

    def __init__(self, web):
        self._web = web
        self.cache = {}  # domain -> Outcome
        self.no_service = {}  # top-level domain -> reason
        self.queries = 0

    def query(self, domain):
        if domain in self.cache:
            return self.cache[domain]
        self.queries += 1
        result, body = self._web.follow(RDAP_BASE + domain, cap=RDAP_CAP, accept=ACCEPT)
        status = result["status"]
        server = urlsplit(result["final_url"]).hostname or "?"
        if status is not None and 200 <= status < 300:
            try:
                outcome = Outcome("found", parse_domain(json.loads(body), domain))
            except (ValueError, UnicodeDecodeError):
                outcome = Outcome("refused", reason=f"{server} sent something that is not an RDAP domain")
        elif status == 404 and server == "rdap.org":
            tld = domain.rsplit(".", 1)[-1]
            outcome = Outcome("no_service", reason=f"no RDAP service for .{tld}")
        elif status in NOT_HERE_STATUSES:
            outcome = Outcome("not_found", reason=f"not found at {server}")
        elif status is None:
            outcome = Outcome("refused", reason=f"{server}: {result.get('error')}")
        else:
            outcome = Outcome("refused", reason=f"{server} answered {result.get('error')}")
        self.cache[domain] = outcome
        return outcome

    def lookup(self, host):
        """(rdap object, None) when found, else (None, the reason)."""
        if is_ip(host):
            return None, "the host is an IP address"
        host = host.lower().rstrip(".")
        if "." not in host:
            return None, "the host has no registrable domain"
        tld = host.rsplit(".", 1)[-1]
        if tld in self.no_service:
            return None, self.no_service[tld]
        last = None
        for domain in candidates(host):
            outcome = self.query(domain)
            if outcome.kind == "found":
                return dict(outcome.record), None
            if outcome.kind == "no_service":
                self.no_service[tld] = outcome.reason
                return None, outcome.reason
            if outcome.kind == "refused":
                return None, f"refused: {outcome.reason}"
            last = outcome
        return None, last.reason if last else "not found"
