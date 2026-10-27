# Publishing bus receipts

This proposal stays unmerged and undeployed for Jamie's review. The Actions
variable `SYNC_RECEIVED_BUS` is empty by default. Set it to
`thingelstad-publishing` only after the reviewed sync stack grant allows
`links` / `received` or `ping` on that bus for the existing deployment role
`links-delivery-DeploymentRole-38md8sad6OG8`.

`/sync-fact.json` is an additive, scriptless build output containing only
the imported change stamp and newest joined issue id/time. It omits counts,
addresses, bookmark bodies and reader data. `src/lib/data.ts` remains the
sole data reader. No generated source file is edited by this change.

The site deploy snapshots the earlier public fact, publishes and verifies
its build, then reads the production fact again. A receipt requires a known
earlier identity, a strictly newer identity and exact agreement between the
built and served identity/time. A local join or stats write is not a public
arrival. The first deployment establishes a silent baseline; unchanged,
unknown, mismatched and regressing facts do not report. Issue dates remain
their editorial dates; the receipt's time is the actual public verification.

Reports are best effort, one per newly advanced kind, with per-entry
acknowledgements and generic warnings. They never undo a healthy site
deployment; polling remains the backstop. Rehearse with fixtures or ping,
never a real published event. No provider writes are needed.

This adds the hop 6 receiver for a future corrected join. It does not repair
the join or change its source, schedule or generated rows. WT354 remains
the worked example until Jamie explicitly approves its repair. Existing
URLs, schemas, MCP tools and browser behavior are unchanged.
