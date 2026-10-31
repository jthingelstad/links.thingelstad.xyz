# Linking Things

Every link Jamie Thingelstad has saved to Pinboard since 2005, as a database: one page
per link, and what connects them. Astro, TypeScript and Pagefind, static, with a
small read-only MCP server at `/mcp` for agents.

```sh
npm install
npm run dev            # http://127.0.0.1:4321 (no search index in dev)
npm run build          # dist/, then the Pagefind index
npm run validate:site  # checks dist/ (pages, links, sitemap, feeds, data files)
npm run preview
PAGEFIND_MODULE=dist/pagefind/pagefind.js npm run mcp:serve   # the MCP server, 127.0.0.1:8790, reads the live site's data
npm run mcp:package    # .build/mcp/: the server zipped for Lambda, keyed by its contents
npm run mcp:plan       # what a deploy of that package would do; needs AWS credentials, writes nothing
```

`npm run infra:plan`, `infra:apply` and `infra:attach` manage the CloudFormation stacks
(`docs/deployment.md`).

## For machines

Everything a page shows is also data, built with the pages:

- `/links/<id>.json` and `/links/<id>.md`: each record's JSON and Markdown twins.
- `/feed.xml` (RSS 2.0) and `/feed.json` (JSON Feed 1.1): the newest 50 links. Every
  host page has its own pair, `/hosts/<host>/feed.xml` and `/hosts/<host>/feed.json`.
  Dates are US Central with the real offset.
- `/links.json`: every public record, newest first, with Pinboard's fields in
  Pinboard's order (`id, hash, url, title, note, saved, tags, toread, meta`) plus its
  `permalink` and its `kind` (`src/lib/kinds.ts`). `/hosts.json` (host, count, first,
  last, url) and `/issues.json` (the Weekly Thing join, with each issue's page here).
- `/links.db`: the same public data as one SQLite file (`tools/build_db.py`).
- `/llms.txt` (llmstxt.org), which lists `/years/<yyyy>/llms.txt`: every record saved
  that year (Central), newest first, as a slim row with the note in full. The largest
  year is under 1 MB.
- `/newest/` is the newest 50 as a page.
- `/sky/` is every link as a star, placed by what it says, its ten nearest in meaning a
  click away; `/sky/#<id>` opens on one link. On a phone, or without WebGL, it is one
  link at a time with its neighbours as doors.
- `/mcp` is a read-only MCP server with no authentication: add
  `https://links.thingelstad.xyz/mcp` to a client as a remote (Streamable HTTP) server.
  Seven tools: `links_search` (the site's own grammar and index: words, `site:`,
  `year:`, `wt:`, `kind:`), `links_get` (one link by id or URL), `links_list` (a year,
  host, kind or tag), `links_issue` (the links a Weekly Thing issue carried),
  `links_stats` (the collection's shape), `links_on_this_day` and `links_random`. Two
  resources: `links://llms.txt` and `links://link/{id}`, a record as Markdown.
  `/mcp/health` reports what the server holds. A browser visiting `/mcp` gets a page
  that lists the tools. The server's code is `src/mcp/`; `docs/deployment.md` has how
  it is hosted and deployed.

## Analytics

Tinylytics and the public Kudos on each record load only from a production build:
`PUBLIC_TINYLYTICS_ENABLED=true`, which the deploy workflow sets for `npm run build`
and `npm run validate:site`, and only on links.thingelstad.xyz. Every other build has
no reference to tinylytics.app, and `npm run validate:site` fails if it does
(`design/tinylytics.md`).

`docs/DIRECTION.md` is the design, `docs/DATA.md` the data contract, `AGENTS.md` the
rules, and `tools/README.md` the data tools.
