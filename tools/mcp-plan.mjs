// The MCP deploy's rules (tools/deploy-mcp.mjs), with no AWS calls, so the
// tests can pin them: what a bundle's key looks like, the parameters a deploy
// changes, and the only change set it will execute.

export const KEY = /^mcp\/[0-9a-f]{64}\.zip$/;
export const STABLE = [
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
];

/** The change set's parameters: the new code, every other value kept. */
export function deployParameters(parameters, key, version) {
  if (!KEY.test(key)) throw new Error(`Not a bundle key: ${key}`);
  if (!version) throw new Error('No object version');
  const names = parameters.map((p) => p.ParameterKey);
  for (const name of ['CodeKey', 'CodeVersion'])
    if (!names.includes(name)) throw new Error(`The stack has no ${name}`);
  return parameters.map(({ ParameterKey }) =>
    ParameterKey === 'CodeKey'
      ? { ParameterKey, ParameterValue: key }
      : ParameterKey === 'CodeVersion'
        ? { ParameterKey, ParameterValue: version }
        : { ParameterKey, UsePreviousValue: true },
  );
}

/** What a change set does beyond replacing the revision and repointing the
 * endpoint at it; empty when that is all it does. */
export function unexpectedChanges(changes) {
  const problems = [];
  const seen = new Set();
  for (const { ResourceChange: c } of changes) {
    seen.add(c.LogicalResourceId);
    if (
      c.LogicalResourceId === 'Revision' &&
      c.Action === 'Modify' &&
      c.Replacement === 'True'
    )
      continue;
    if (
      c.LogicalResourceId === 'Endpoint' &&
      c.Action === 'Modify' &&
      c.Replacement === 'False'
    )
      continue;
    problems.push(
      `${c.Action} ${c.LogicalResourceId}${c.Replacement ? ` (replacement: ${c.Replacement})` : ''}`,
    );
  }
  if (!seen.has('Revision')) problems.push('no new revision');
  if (!seen.has('Endpoint')) problems.push('the endpoint is not repointed');
  return problems;
}
