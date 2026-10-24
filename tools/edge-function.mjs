// The viewer-request and viewer-response functions from infra/site.json,
// runnable in Node, so the tests and the local browser check exercise the
// code CloudFront runs.
import fs from 'node:fs/promises';

export function functionCode(template, name = 'IndexFunction') {
  const code = template.Resources[name].Properties.FunctionCode;
  if (typeof code === 'string') return code;
  const [separator, lines] = code['Fn::Join'];
  return lines.join(separator);
}

async function load(name, file) {
  const template = JSON.parse(await fs.readFile(file, 'utf8'));
  return new Function(`${functionCode(template, name)}\nreturn handler;`)();
}
export const indexFunction = (file = 'infra/site.json') =>
  load('IndexFunction', file);
export const crawlerFunction = (file = 'infra/site.json') =>
  load('CrawlerFunction', file);

// A viewer-response event: the response as the origin sent it, its headers
// keyed in lower case.
export function viewerResponse(uri, contentType) {
  const headers = contentType ? { 'content-type': { value: contentType } } : {};
  return {
    request: { method: 'GET', uri, querystring: {}, headers: {} },
    response: { statusCode: 200, headers },
  };
}

// The event CloudFront passes for a request line such as /search?q=dns&x=1:
// the path as received, and the query parameters with their values still
// encoded, a repeated name under multiValue.
export function viewerRequest(target) {
  const at = target.indexOf('?');
  const uri = at === -1 ? target : target.slice(0, at);
  const querystring = {};
  if (at !== -1)
    for (const pair of target.slice(at + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = { value: eq === -1 ? '' : pair.slice(eq + 1) };
      const field = querystring[name];
      if (!field) querystring[name] = value;
      else (field.multiValue ??= [{ value: field.value }]).push(value);
    }
  return { request: { method: 'GET', uri, querystring, headers: {} } };
}
