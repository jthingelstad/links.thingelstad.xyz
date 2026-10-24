// What a person sees who opens /mcp in a browser: the address to give an MCP
// client, that it needs no sign-in, and the tools. Everything on it is fixed
// at start; the one style block is allowed by its hash, nothing else loads.
import { createHash } from 'node:crypto';
import { tools } from './tools.ts';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

const style = `
:root { color-scheme: light dark; --ink: #16161a; --soft: #5a5a66; --ground: #ffffff; --rule: #e4e4ea; }
@media (prefers-color-scheme: dark) { :root { --ink: #ececf0; --soft: #9d9daa; --ground: #1e1e23; --rule: #34343c; } }
body { margin: 0; background: var(--ground); color: var(--ink); font: 18px/1.6 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 1rem; font-weight: 800; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.5rem; font-weight: 700; }
p, li { color: var(--ink); }
.soft { color: var(--soft); }
code { font: 0.95em ui-monospace, SFMono-Regular, Menlo, monospace; }
.address { display: block; padding: 0.75rem 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); font-size: 1.05rem; overflow-wrap: anywhere; }
ul { padding-left: 1.2rem; }
a { color: inherit; text-underline-offset: 3px; }
`;

export const styleHash = `sha256-${createHash('sha256').update(style).digest('base64')}`;

export function mcpPage(site: string) {
  const address = `${site}/mcp`;
  const rows = tools
    .map(
      (tool) =>
        `<li><code>${escape(tool.name)}</code>: ${escape(tool.title)}</li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Linking Things MCP</title>
<meta name="description" content="A read-only MCP server for Linking Things, every public link Jamie Thingelstad has saved since 2005.">
<style>${style}</style>
</head>
<body>
<main>
<h1>Linking Things MCP</h1>
<p>A read-only <a href="https://modelcontextprotocol.io/">Model Context Protocol</a> server for <a href="${escape(site)}/">Linking Things</a>, every public link Jamie Thingelstad has saved since 2005.</p>
<p>Add it to an MCP client as a remote server (Streamable HTTP) at this address:</p>
<code class="address">${escape(address)}</code>
<p class="soft">No sign-in and no key: it is public, like the site.</p>
<h2>Tools</h2>
<ul>
${rows}
</ul>
<p class="soft">Without MCP, the same data is on the site: <a href="${escape(site)}/llms.txt">llms.txt</a> is the map.</p>
</main>
</body>
</html>
`;
}
