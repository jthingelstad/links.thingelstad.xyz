# About

<!--
The About page, /about/, in Jamie's words. src/lib/about.ts reads this file
at build and renders it as Markdown on the page.

The first line outside this comment is the page's title, a single "# " heading.
Each section starts with a "## " heading. Paragraphs, "> " quotes, lists and
links work as Markdown. A link that starts with "/" goes to a page or file on
this site and must exist (npm run validate:site checks). Raw HTML is shown as
text, and images are off: nothing on this page is fetched from another host.

A file whose first heading is not a "# " title, with a second "# " title, with
no "## " section, or with text before the title fails the build with its line
number. Everything inside this comment is ignored.
-->

## What this is

Every link I have saved since August 2005, one page per link, and what connects
them: the host, the year, the tags, the links that point at each other, and the
issues of [The Weekly Thing](https://weekly.thingelstad.com/) that carried them.

> This isn't something that I do for the Weekly Thing but is instead something
> I've always done. The Weekly Thing is a result of this activity.

That is from [How I Find Links](https://www.thingelstad.com/2023/10/07/how-i-find.html),
where I also wrote: "To me this feels like an ever growing database of knowledge."

This is my fourth attempt at doing something with that database, after a wiki in
2012 and a link blog from 2017 to 2021. In
[January 2024](https://weekly.thingelstad.com/archive/274/) I wrote: "I may create
a link blog again in the future, but if I did I want it to not be
blog-date-centric but instead content-keyword-search centric." So this one starts
with a search box.

## Why links matter

The fundamental building block of the web "isn't HTML or a web page"; "it is the
link. The way that closed platforms fight links makes them feel rebellious to even
use. Long live the hyperlink!" ([Weekly Thing 352](https://weekly.thingelstad.com/archive/352/))

> Most (all?) of the major social platforms have largely pushed the hyperlink,
> what I would suggest is the most fundamental thing about the web, out.

> If a service does not support direct hyperlinking, without some scary warning,
> then we should understand that this is not a service that sees the web as a
> friend.

Both are from [Weekly Thing 295](https://weekly.thingelstad.com/archive/295/). And
from [two decades ago](https://www.thingelstad.com/2024/05/19/two-decades-ago.html):
"I would have never guessed that linking to websites, with no URL redirection or
tracking tags, would feel almost subversive now."

## How it is made

Static pages, built with [Astro](https://astro.build/) and searched with
[Pagefind](https://pagefind.app/). Every link's page has a JSON twin and a
Markdown twin. There are feeds for the newest links and for every host and every
kind, [llms.txt](/llms.txt) files for language models, an [MCP server](/mcp)
for agents, every link in [links.json](/links.json), and the same public data as
one SQLite file, [links.db](/links.db).

The site, its tools and its data are open source at
[github.com/jthingelstad/links.thingelstad.xyz](https://github.com/jthingelstad/links.thingelstad.xyz).
The Kudos button on each link's page is counted by Tinylytics. Agents built it
with me on October 23, 2026.
