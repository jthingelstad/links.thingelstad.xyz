# Join subscriber (prepared, off)

This PR remains unmerged and undeployed. The workflow defaults to a dry run
with contents-read permission, no checkout, source read, commit or deploy.
No live rehearsal ran. It does not change the nightly job or its checkout.

Real work has two independent gates: the sync stack's disabled rule and
explicit `ApproveLinksJoinRepair`, plus this repository's Actions variable
`SYNC_JOIN_APPROVED=true`. Jamie must approve repairing the WT354 example
before either gate opens. Until then it stays late and no generated data is
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
to one workflow; the connection endpoint and role pin sync-join.yml. No
token value enters a session. Configure the ping lane first and verify its
dry-run result. At-least-once deliveries may repeat a harmless unchanged
join; no exactly-once guarantee is claimed.
