# Linking Things

Every link Jamie Thingelstad has saved to Pinboard since 2005, as a database: one page
per link, and what connects them. Astro, TypeScript and Pagefind, static.

```sh
npm install
npm run dev            # http://127.0.0.1:4321 (no search index in dev)
npm run build          # dist/, then the Pagefind index
npm run validate:site  # checks dist/ (pages, links, sitemap, feeds, data files)
npm run preview
```

## For machines

Everything a page shows is also data, built with the pages:

- `/links/<id>.json` and `/links/<id>.md`: each record's JSON and Markdown twins.
- `/feed.xml` (RSS 2.0) and `/feed.json` (JSON Feed 1.1): the newest 50 links. Every
  host page has its own pair, `/hosts/<host>/feed.xml` and `/hosts/<host>/feed.json`.
  Dates are US Central with the real offset.
- `/links.json`: every public record, newest first, with Pinboard's fields in
  Pinboard's order (`id, hash, url, title, note, saved, tags, toread, meta`) plus its
  `permalink`. `/hosts.json` (host, count, first, last, url) and `/issues.json` (the
  Weekly Thing join, with each issue's page here).
- `/llms.txt` (llmstxt.org) and `/llms-full.txt`, every Markdown twin, newest first.

## Analytics

Tinylytics and the Like on each record load only from a production build:
`PUBLIC_TINYLYTICS_ENABLED=true`, which the deploy workflow sets for `npm run build`
and `npm run validate:site`, and only on links.thingelstad.xyz. Every other build has
no reference to tinylytics.app, and `npm run validate:site` fails if it does
(`design/tinylytics.md`).

`docs/DIRECTION.md` is the design, `docs/DATA.md` the data contract, `AGENTS.md` the
rules, and `tools/README.md` the data tools.
