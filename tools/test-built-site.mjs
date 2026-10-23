// Serve dist/ on loopback the way CloudFront does, and run the browser checks
// (tools/check-site.mjs) against it: every request goes through the
// viewer-request function from infra/site.json (directory routes, the
// trailing-slash redirect), objects get the Content-Type the deploy stores
// (tools/delivery-plan.mjs), and a miss is the 404 page with status 404.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { contentType } from './delivery-plan.mjs';
import { indexFunction, viewerRequest } from './edge-function.mjs';

const root = path.resolve('dist');
const handler = await indexFunction();

async function object(uri) {
  const target = path.resolve(root, '.' + decodeURIComponent(uri));
  if (!target.startsWith(root + path.sep)) return null;
  try {
    return { body: await fs.readFile(target), type: contentType(target) };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const result = handler(viewerRequest(req.url));
    if (result.statusCode) {
      res.writeHead(result.statusCode, {
        location: result.headers.location.value,
      });
      res.end();
      return;
    }
    const found = await object(result.uri);
    const served = found || (await object('/404.html'));
    res.writeHead(found ? 200 : 404, { 'content-type': served.type });
    res.end(req.method === 'HEAD' ? undefined : served.body);
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['tools/check-site.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SITE_TEST_URL: `http://127.0.0.1:${server.address().port}`,
    SITE_TEST_EDGE: '1',
  },
});
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
