"""RDAP: the response parser, the registrable domain, and the cached client.
No network.

Run: python3 -I -m unittest discover -s tests -v
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import rdap, web  # noqa: E402
from test_enrich_web import FakeClock, FakeTransport, public_resolver  # noqa: E402

# A thin-registry answer in Verisign's shape (rdap.verisign.com/com/v1/domain/...).
VERISIGN = {
    "objectClassName": "domain",
    "handle": "2336799_DOMAIN_COM-VRSN",
    "ldhName": "EXAMPLE-BLOG.COM",
    "links": [
        {
            "value": "https://rdap.verisign.com/com/v1/domain/example-blog.com",
            "rel": "related",
            "href": "https://rdap.markmonitor.com/rdap/domain/EXAMPLE-BLOG.COM",
            "type": "application/rdap+json",
        }
    ],
    "status": ["client update prohibited", "client delete prohibited", "client transfer prohibited"],
    "entities": [
        {
            "objectClassName": "entity",
            "handle": "292",
            "roles": ["registrar"],
            "publicIds": [{"type": "IANA Registrar ID", "identifier": "292"}],
            "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "MarkMonitor Inc."]]],
            "entities": [
                {
                    "objectClassName": "entity",
                    "roles": ["abuse"],
                    "vcardArray": [
                        "vcard",
                        [
                            ["version", {}, "text", "4.0"],
                            ["fn", {}, "text", ""],
                            ["tel", {"type": "voice"}, "uri", "tel:+1.2086851750"],
                            ["email", {}, "text", "abusecomplaints@markmonitor.com"],
                        ],
                    ],
                }
            ],
        }
    ],
    "events": [
        {"eventAction": "registration", "eventDate": "1994-11-01T05:00:00Z"},
        {"eventAction": "expiration", "eventDate": "2027-10-31T04:00:00Z"},
        {"eventAction": "last changed", "eventDate": "2026-07-31T19:44:05Z"},
        {"eventAction": "last update of RDAP database", "eventDate": "2026-10-23T21:09:50Z"},
    ],
    "secureDNS": {"delegationSigned": False},
    "nameservers": [
        {"objectClassName": "nameserver", "ldhName": "NS-264.AWSDNS-33.COM"},
        {"objectClassName": "nameserver", "ldhName": "NS-1447.AWSDNS-52.ORG"},
    ],
    "rdapConformance": ["rdap_level_0", "icann_rdap_technical_implementation_guide_1"],
    "notices": [{"title": "Terms of Use", "description": ["Service subject to Terms of Use."]}],
}

# A registrar's own answer (a thick record): a redacted registrant comes first,
# EPP-style status codes, name servers with a root dot, fractional seconds.
REGISTRAR = {
    "rdapConformance": ["rdap_level_0", "icann_rdap_response_profile_1", "redacted"],
    "objectClassName": "domain",
    "ldhName": "personal-site.org",
    "unicodeName": "personal-site.org",
    "status": ["clientTransferProhibited", "active"],
    "entities": [
        {
            "objectClassName": "entity",
            "roles": ["registrant"],
            "vcardArray": [
                "vcard",
                [["version", {}, "text", "4.0"], ["fn", {}, "text", "REDACTED FOR PRIVACY"], ["kind", {}, "text", "individual"]],
            ],
            "remarks": [{"title": "REDACTED FOR PRIVACY", "type": "object redacted due to authorization"}],
        },
        {
            "objectClassName": "entity",
            "roles": ["technical"],
            "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "REDACTED FOR PRIVACY"]]],
        },
        {
            "objectClassName": "entity",
            "handle": "69",
            "roles": ["registrar"],
            "publicIds": [{"type": "IANA Registrar ID", "identifier": "69"}],
            "vcardArray": [
                "vcard",
                [
                    ["version", {}, "text", "4.0"],
                    ["fn", {}, "text", "Tucows Domains Inc."],
                    ["adr", {}, "text", ["", "", "96 Mowat Ave", "Toronto", "ON", "M6K 3M1", "CA"]],
                ],
            ],
        },
    ],
    "events": [
        {"eventAction": "registration", "eventDate": "2003-02-14T16:20:11.000+00:00"},
        {"eventAction": "expiration", "eventDate": "2027-02-14T16:20:11.000+00:00"},
        {"eventAction": "last changed", "eventDate": "2026-01-20T08:01:44.000+00:00"},
    ],
    "nameservers": [
        {"objectClassName": "nameserver", "ldhName": "ns2.example-dns.net."},
        {"objectClassName": "nameserver", "ldhName": "NS1.EXAMPLE-DNS.NET"},
        {"objectClassName": "nameserver", "ldhName": "ns1.example-dns.net"},
    ],
}


class ParseTest(unittest.TestCase):
    def test_verisign_style(self):
        self.assertEqual(
            rdap.parse_domain(VERISIGN, "example-blog.com"),
            {
                "domain": "example-blog.com",
                "registrar": "MarkMonitor Inc.",
                "registered": "1994-11-01",
                "expires": "2027-10-31",
                "status": ["client delete prohibited", "client transfer prohibited", "client update prohibited"],
                "nameservers": ["ns-1447.awsdns-52.org", "ns-264.awsdns-33.com"],
            },
        )

    def test_registrar_style(self):
        record = rdap.parse_domain(REGISTRAR, "personal-site.org")
        self.assertEqual(record["registrar"], "Tucows Domains Inc.")  # not the redacted registrant
        self.assertEqual((record["registered"], record["expires"]), ("2003-02-14", "2027-02-14"))
        self.assertEqual(record["status"], ["active", "client transfer prohibited"])
        self.assertEqual(record["nameservers"], ["ns1.example-dns.net", "ns2.example-dns.net"])

    def test_a_registrar_without_a_vcard_falls_back_to_its_handle(self):
        doc = {"objectClassName": "domain", "entities": [{"roles": ["registrar"], "handle": "REG-ACME"}]}
        self.assertEqual(rdap.parse_domain(doc, "a.example")["registrar"], "REG-ACME")
        doc = {"objectClassName": "domain", "entities": [{"roles": ["registrar"], "publicIds": [{"type": "IANA Registrar ID", "identifier": "9"}]}]}
        self.assertEqual(rdap.parse_domain(doc, "a.example")["registrar"], "IANA Registrar ID 9")

    def test_missing_parts_are_none_or_empty(self):
        record = rdap.parse_domain({"objectClassName": "domain"}, "bare.example")
        self.assertEqual(
            record,
            {"domain": "bare.example", "registrar": None, "registered": None, "expires": None, "status": [], "nameservers": []},
        )

    def test_an_error_object_is_not_a_domain(self):
        with self.assertRaises(ValueError):
            rdap.parse_domain({"objectClassName": "entity"}, "x.example")
        with self.assertRaises(ValueError):
            rdap.parse_domain(["not", "an", "object"], "x.example")


class RegistrableTest(unittest.TestCase):
    def test_guess(self):
        cases = {
            "macstories.net": "macstories.net",
            "blog.cloudflare.com": "cloudflare.com",
            "aws.amazon.com": "amazon.com",
            "en.wikipedia.org": "wikipedia.org",
            "blog.google": "blog.google",
            "news.bbc.co.uk": "bbc.co.uk",
            "bbc.co.uk": "bbc.co.uk",
            "a.b.example.com.au": "example.com.au",
            "jamie.github.io": "github.io",
        }
        for host, domain in cases.items():
            self.assertEqual(rdap.registrable_guess(host), domain, host)

    def test_candidates_guess_first_then_strip_from_the_left(self):
        self.assertEqual(rdap.candidates("macstories.net"), ["macstories.net"])
        self.assertEqual(rdap.candidates("a.b.example.com"), ["example.com", "a.b.example.com", "b.example.com"])
        self.assertEqual(rdap.candidates("x.example.co.uk"), ["example.co.uk", "x.example.co.uk"])
        self.assertNotIn("uk", rdap.candidates("x.example.co.uk"))


class FakeWeb:
    """follow() answers by URL: (status, final_url, body)."""

    def __init__(self, answers):
        self.answers = answers
        self.urls = []

    def follow(self, url, **_kwargs):
        self.urls.append(url)
        status, final_url, body = self.answers.get(url, (404, "https://rdap.example-registry.net/x", b""))
        result = {"status": status, "alive": status is not None and 200 <= status < 300, "final_url": final_url,
                  "redirects": [], "content_type": "application/rdap+json"}
        if not result["alive"]:
            result["error"] = f"HTTP {status}" if status else "timeout"
        return result, body if result["alive"] else b""


def found(domain, doc=VERISIGN):
    return (200, f"https://rdap.verisign.com/com/v1/domain/{domain}", json.dumps(doc).encode())


class ClientTest(unittest.TestCase):
    def test_the_obvious_case_costs_one_call(self):
        fake = FakeWeb({rdap.RDAP_BASE + "example-blog.com": found("example-blog.com")})
        client = rdap.Client(fake)
        record, reason = client.lookup("blog.example-blog.com")
        self.assertIsNone(reason)
        self.assertEqual(record["domain"], "example-blog.com")
        self.assertEqual(fake.urls, [rdap.RDAP_BASE + "example-blog.com"])

    def test_answers_are_cached_per_domain(self):
        fake = FakeWeb({rdap.RDAP_BASE + "example-blog.com": found("example-blog.com")})
        client = rdap.Client(fake)
        client.lookup("example-blog.com")
        client.lookup("www2.example-blog.com")
        client.lookup("shop.example-blog.com")
        self.assertEqual(len(fake.urls), 1)
        self.assertEqual(client.queries, 1)

    def test_strips_from_the_left_when_the_guess_is_wrong(self):
        # An unlisted two-level suffix: the registry knows site.club.example, not club.example.
        fake = FakeWeb({rdap.RDAP_BASE + "site.club.example": found("site.club.example")})
        record, reason = rdap.Client(fake).lookup("www2.site.club.example")
        self.assertEqual(record["domain"], "site.club.example")
        self.assertEqual(
            fake.urls,
            [rdap.RDAP_BASE + "club.example", rdap.RDAP_BASE + "www2.site.club.example", rdap.RDAP_BASE + "site.club.example"],
        )

    def test_a_top_level_domain_without_rdap(self):
        fake = FakeWeb({rdap.RDAP_BASE + "tech.mn": (404, rdap.RDAP_BASE + "tech.mn", b"")})
        client = rdap.Client(fake)
        self.assertEqual(client.lookup("tech.mn"), (None, "no RDAP service for .mn"))
        self.assertEqual(client.lookup("other.mn"), (None, "no RDAP service for .mn"))
        self.assertEqual(len(fake.urls), 1)  # the second .mn host costs nothing

    def test_a_refusal_is_recorded_with_the_registry(self):
        fake = FakeWeb({rdap.RDAP_BASE + "closed.xx": (403, "https://rdap.nic.xx/domain/closed.xx", b"")})
        record, reason = rdap.Client(fake).lookup("closed.xx")
        self.assertIsNone(record)
        self.assertEqual(reason, "refused: rdap.nic.xx answered HTTP 403")

    def test_not_found_anywhere(self):
        fake = FakeWeb({})
        record, reason = rdap.Client(fake).lookup("a.nowhere.example")
        self.assertIsNone(record)
        self.assertEqual(reason, "not found at rdap.example-registry.net")
        self.assertEqual(len(fake.urls), 2)

    def test_an_ip_address_is_never_looked_up(self):
        fake = FakeWeb({})
        self.assertEqual(rdap.Client(fake).lookup("23.252.119.254"), (None, "the host is an IP address"))
        self.assertEqual(fake.urls, [])

    def test_follows_the_redirect_to_the_registry(self):
        clock = FakeClock()
        transport = FakeTransport(
            {
                "https://rdap.org/domain/example-blog.com": (
                    302,
                    {"Location": "https://rdap.verisign.com/com/v1/domain/example-blog.com"},
                ),
                "https://rdap.verisign.com/com/v1/domain/example-blog.com": (
                    200,
                    {"Content-Type": "application/rdap+json"},
                    json.dumps(VERISIGN).encode(),
                ),
            }
        )
        client = web.Client(transport=transport, resolve=public_resolver(), sleep=clock.sleep, clock=clock)
        record, reason = rdap.Client(client).lookup("example-blog.com")
        self.assertIsNone(reason)
        self.assertEqual(record["registrar"], "MarkMonitor Inc.")
        self.assertEqual(transport.calls[0][1]["Accept"], rdap.ACCEPT)


if __name__ == "__main__":
    unittest.main()
