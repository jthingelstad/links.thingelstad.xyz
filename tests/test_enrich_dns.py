"""The dig output parser and the DNS lookup, with no network.

Run: python3 -I -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import dns  # noqa: E402
from linking.web import Gate  # noqa: E402
from test_enrich_web import FakeClock  # noqa: E402


def header(status):
    return (
        ";; Got answer:\n"
        f";; ->>HEADER<<- opcode: QUERY, status: {status}, id: 4242\n"
        ";; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1\n\n"
        ";; OPT PSEUDOSECTION:\n; EDNS: version: 0, flags:; udp: 1232\n"
    )


# dig +noall +answer +comments en.wikipedia.org A ... MX: every query follows
# the CNAME, so the chain shows in each answer.
WIKIPEDIA = (
    header("NOERROR")
    + "en.wikipedia.org.\t2472\tIN\tCNAME\tdyna.wikimedia.org.\n"
    + "dyna.wikimedia.org.\t124\tIN\tA\t208.80.154.224\n"
    + header("NOERROR")
    + "en.wikipedia.org.\t2472\tIN\tCNAME\tdyna.wikimedia.org.\n"
    + "dyna.wikimedia.org.\t13\tIN\tAAAA\t2620:0:861:ed1a::1\n"
    + header("NOERROR")
    + "en.wikipedia.org.\t2472\tIN\tCNAME\tdyna.wikimedia.org.\n"
    + header("NOERROR")
    + "en.wikipedia.org.\t2176\tIN\tCNAME\tdyna.wikimedia.org.\n"
    + "dyna.wikimedia.org.\t3600\tIN\tNS\tns0.wikimedia.org.\n"
    + header("NOERROR")
    + "en.wikipedia.org.\t2472\tIN\tCNAME\tdyna.wikimedia.org.\n"
)

APEX = (
    header("NOERROR")
    + "macstories.net.\t\t300\tIN\tA\t45.55.54.134\n"
    + "macstories.net.\t\t300\tIN\tA\t104.16.9.10\n"
    + "macstories.net.\t\t300\tIN\tA\t9.9.9.9\n"
    + header("NOERROR")
    + header("NOERROR")
    + header("NOERROR")
    + "macstories.net.\t\t86400\tIN\tNS\tRUSTAM.NS.CLOUDFLARE.COM.\n"
    + "macstories.net.\t\t86400\tIN\tNS\traquel.ns.cloudflare.com.\n"
    + header("NOERROR")
    + "macstories.net.\t\t300\tIN\tMX\t1 aspmx.l.google.com.\n"
    + "macstories.net.\t\t300\tIN\tMX\t5 alt1.aspmx.l.google.com.\n"
)

NULL_MX = header("NOERROR") + "nomail.example.\t300\tIN\tA\t93.184.216.34\n" + (header("NOERROR") * 3) + (
    header("NOERROR") + "nomail.example.\t300\tIN\tMX\t0 .\n"
)

NXDOMAIN = header("NXDOMAIN") * 5

TIMEOUT = ";; connection timed out; no servers could be reached\n" * 5


class ParseTest(unittest.TestCase):
    def test_a_cname_chain(self):
        record = dns.parse_dig(WIKIPEDIA, "en.wikipedia.org")
        self.assertEqual(
            record,
            {
                "resolves": True,
                "a": ["208.80.154.224"],
                "aaaa": ["2620:0:861:ed1a::1"],
                "cname": "dyna.wikimedia.org",
                "ns": [],  # the NS answer belongs to the CNAME target, not the host
                "mx": False,
            },
        )

    def test_a_zone_apex(self):
        record = dns.parse_dig(APEX, "macstories.net")
        self.assertEqual(record["a"], ["9.9.9.9", "45.55.54.134", "104.16.9.10"])  # numeric order
        self.assertEqual(record["aaaa"], [])
        self.assertIsNone(record["cname"])
        self.assertEqual(record["ns"], ["raquel.ns.cloudflare.com", "rustam.ns.cloudflare.com"])
        self.assertTrue(record["mx"])
        self.assertTrue(record["resolves"])
        self.assertNotIn("error", record)

    def test_a_null_mx_is_no_mail(self):
        self.assertFalse(dns.parse_dig(NULL_MX, "nomail.example")["mx"])

    def test_nxdomain(self):
        record = dns.parse_dig(NXDOMAIN, "gone.example")
        self.assertFalse(record["resolves"])
        self.assertEqual(record["error"], "NXDOMAIN")
        self.assertEqual((record["a"], record["aaaa"], record["ns"], record["mx"]), ([], [], [], False))

    def test_timeout(self):
        record = dns.parse_dig(TIMEOUT, "slow.example", returncode=9)
        self.assertFalse(record["resolves"])
        self.assertEqual(record["error"], "TIMEOUT")

    def test_no_output_at_all(self):
        self.assertEqual(dns.parse_dig("", "x.example", returncode=10)["error"], "dig exit 10")

    def test_names_are_lower_case_without_the_root_dot(self):
        text = header("NOERROR") + "Blog.Example.COM.\t60\tIN\tCNAME\tEdge.CDN.Example.NET.\n"
        self.assertEqual(dns.parse_dig(text, "blog.example.com")["cname"], "edge.cdn.example.net")

    def test_ipv6_addresses_are_compressed_and_sorted(self):
        text = header("NOERROR") + header("NOERROR")
        text += "h.example.\t60\tIN\tAAAA\t2606:4700:0000:0000:0000:0000:6812:1d07\n"
        text += "h.example.\t60\tIN\tAAAA\t2606:4700::6812:1c07\n"
        self.assertEqual(dns.parse_dig(text, "h.example")["aaaa"], ["2606:4700::6812:1c07", "2606:4700::6812:1d07"])


class CommandTest(unittest.TestCase):
    def test_one_dig_with_five_queries(self):
        command = dns.dig_command("macstories.net")
        self.assertEqual(command[0], "dig")
        self.assertIn("+noall", command)
        self.assertIn("+answer", command)
        self.assertEqual(command[-10:], ["macstories.net", "A", "macstories.net", "AAAA", "macstories.net", "CNAME",
                                         "macstories.net", "NS", "macstories.net", "MX"])

    def test_refuses_anything_that_is_not_a_dns_name(self):
        for bad in ("-x", "+short", "a b.example", "", "example.com;rm", "-f.example"):
            with self.assertRaises(ValueError, msg=bad):
                dns.dig_command(bad)


class ResolverTest(unittest.TestCase):
    def test_one_lookup_a_second(self):
        clock = FakeClock()
        calls = []

        def run(command):
            calls.append(command)
            return APEX, 0

        resolver = dns.Resolver(Gate(sleep=clock.sleep, clock=clock), run=run)
        resolver.lookup("macstories.net")
        resolver.lookup("macstories.net")
        self.assertEqual(len(calls), 2)
        self.assertEqual(clock.sleeps, [1.0])

    def test_an_ip_address_host_needs_no_lookup(self):
        resolver = dns.Resolver(Gate(), run=lambda command: self.fail("dig ran"))
        record = resolver.lookup("23.252.119.254")
        self.assertEqual(record["a"], ["23.252.119.254"])
        self.assertTrue(record["resolves"])


if __name__ == "__main__":
    unittest.main()
