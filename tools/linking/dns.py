"""DNS facts for a host, from dig (docs/DATA.md, "Enrichment (phase 2)").

The standard library's resolver answers A and AAAA only, so the lookup runs
dig once per host with five queries (A, AAAA, CNAME, NS, MX) and reads the
answer section. That is the typed form of what `dig +short` prints: the same
records, with owner and type kept, so a CNAME target is never mistaken for a
name server. Header comments give each query's status (NOERROR, NXDOMAIN...).
"""

import ipaddress
import re
import subprocess

QUERY_TYPES = ("A", "AAAA", "CNAME", "NS", "MX")
DIG_OPTIONS = ("+noall", "+answer", "+comments", "+time=5", "+tries=2")
HOST_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?")
STATUS_RE = re.compile(r";; ->>HEADER<<- opcode: \w+, status: (\w+)")
NO_SERVERS = "no servers could be reached"


class DnsError(Exception):
    """dig is missing or could not run at all."""


def is_ip(host):
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


def dig_command(host):
    if not HOST_RE.fullmatch(host):
        raise ValueError(f"not a DNS name: {host!r}")
    command = ["dig", *DIG_OPTIONS]
    for kind in QUERY_TYPES:
        command += [host, kind]
    return command


def _name(text):
    return text.rstrip(".").lower()


def parse_dig(output, host, returncode=0):
    """The dns object of a host record from dig's output.

    A and AAAA are every address in their answers (after any CNAME chain),
    sorted. cname is the host's own CNAME target or None. ns is the NS records
    owned by the host itself (empty for a name that is not a zone apex). mx is
    whether any MX record names a mail server (a null MX, "0 .", does not).
    error is present when the A query did not come back NOERROR.
    """
    host = _name(host)
    a, aaaa, ns = set(), set(), set()
    cname = None
    mx = False
    statuses = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(";"):
            match = STATUS_RE.search(line)
            if match:
                statuses.append(match.group(1))
            elif NO_SERVERS in line:
                statuses.append("TIMEOUT")
            continue
        fields = line.split()
        if len(fields) < 5 or fields[2] != "IN":
            continue
        owner, kind, data = _name(fields[0]), fields[3].upper(), fields[4:]
        if kind == "A":
            try:
                a.add(str(ipaddress.IPv4Address(data[0])))
            except ValueError:
                pass
        elif kind == "AAAA":
            try:
                aaaa.add(str(ipaddress.IPv6Address(data[0])))
            except ValueError:
                pass
        elif kind == "CNAME" and owner == host:
            cname = _name(data[0])
        elif kind == "NS" and owner == host:
            ns.add(_name(data[0]))
        elif kind == "MX" and len(data) >= 2 and _name(data[1]) != "":
            mx = True
    record = {
        "resolves": bool(a or aaaa),
        "a": sorted(a, key=ipaddress.IPv4Address),
        "aaaa": sorted(aaaa, key=ipaddress.IPv6Address),
        "cname": cname,
        "ns": sorted(ns),
        "mx": mx,
    }
    status = statuses[0] if statuses else None
    if status is None and returncode:
        record["error"] = f"dig exit {returncode}"
    elif status not in (None, "NOERROR"):
        record["error"] = status
    return record


def literal_record(address):
    """The dns object for a host that is an IP address: nothing to look up."""
    value = ipaddress.ip_address(address.strip("[]"))
    return {
        "resolves": True,
        "a": [str(value)] if value.version == 4 else [],
        "aaaa": [str(value)] if value.version == 6 else [],
        "cname": None,
        "ns": [],
        "mx": False,
    }


def run_dig(command):
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
    except FileNotFoundError:
        raise DnsError("dig is not installed") from None
    except subprocess.TimeoutExpired:
        return "", 9
    return done.stdout, done.returncode


class Resolver:
    """One dig per host, at most one a second (the "dns" service)."""

    def __init__(self, gate, *, run=run_dig, spacing=1.0):
        self._gate = gate
        self._run = run
        self._spacing = spacing
        self.lookups = 0

    def lookup(self, host):
        if is_ip(host):
            return literal_record(host)
        command = dig_command(host)
        with self._gate.slot("dns", self._spacing):
            self.lookups += 1
            output, returncode = self._run(command)
        return parse_dig(output, host, returncode)
