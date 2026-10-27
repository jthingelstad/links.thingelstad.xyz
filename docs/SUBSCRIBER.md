# Join subscriber (off)

Merged 2026-10-27 and inert. The workflow defaults to a dry run with
contents-read permission, no checkout, source read, commit or deploy.
No live rehearsal ran. It does not change the nightly job or its checkout.

On 2026-10-27 the sync stack folded its per-destination parameters into one,
`ReceiverRoles` (deploy override `SYNC_RECEIVER_ROLES`, a comma-separated
list of role names), and removed its subscriber scaffolding, the disabled
rule and its approval parameter among it. This workflow stays, but nothing
on the bus starts it now. Real work also needs this repository's Actions
variable `SYNC_JOIN_APPROVED=true`, set only after Jamie approves repairing
the WT354 example. Until then it stays late and no generated data is
changed. Do not dispatch the real workflow as a test.

After approval, the join reads the public weekly repository's main checkout
in an isolated runner, uses the existing Python generator and validates its
output. It stages only data/derived/issues.json, refuses a moved main,
pushes without force and dispatches the existing full CI/deploy workflow
(a GITHUB_TOKEN push alone would not run it). An unchanged join skips CI only
when the public revision already matches this commit. A repeated delivery
dispatches CI again if a previous push succeeded but its dispatch was lost;
an unknown public revision also keeps this recovery path open.
The step-5 sender reports only after the public deployment, not here.

Jamie adds `github_links_actions_token` to sync-runtime, a fine-grained PAT
limited to this repository with Actions write. GitHub cannot limit that PAT
to one workflow; a future sync subscriber (the shape is in sync's
docs/SUBSCRIBERS.md; nothing is built) would pin sync-join.yml. No
token value enters a session. Configure the ping lane first and verify its
dry-run result. At-least-once deliveries may repeat a harmless unchanged
join; no exactly-once guarantee is claimed.
