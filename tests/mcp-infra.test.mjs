// The MCP server's infrastructure and delivery, with no AWS calls: the pins
// tools/validate-infra.mjs holds over infra/mcp.json and the MCP parts of
// infra/site.json and infra/delivery.json (each proven to bite on an edited
// copy), the deploy's rules (tools/mcp-plan.mjs) and the package
// (tools/package-mcp.mjs). Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import {
  KEY,
  STABLE,
  deployParameters,
  unexpectedChanges,
} from '../tools/mcp-plan.mjs';
import { bundle, packageMcp, zip } from '../tools/package-mcp.mjs';
import { readInfra, validate } from '../tools/validate-infra.mjs';

const infra = await readInfra();
const refused = (why, change) => {
  const copy = structuredClone(infra);
  change(copy);
  assert.throws(() => validate(copy), assert.AssertionError, why);
};
const resources = (copy) => copy.mcp.Resources;
const mcpBehavior = (copy) =>
  copy.site.Resources.Distribution.Properties.DistributionConfig.CacheBehaviors[
    'Fn::If'
  ][1][0];
const mcpOrigin = (copy) =>
  copy.site.Resources.Distribution.Properties.DistributionConfig.Origins.find(
    (o) => o['Fn::If'],
  )['Fn::If'][1];
const mcpDelivery = (copy) =>
  copy.delivery.Resources.DeploymentRole.Properties.Policies[1]['Fn::If'][1]
    .PolicyDocument.Statement;

test('the templates as committed validate', () => {
  validate(structuredClone(infra));
});

test('the endpoint stays IAM-only, small and slow to scale', () => {
  refused('auth', (c) => {
    resources(c).Endpoint.Properties.AuthType = 'None';
  });
  refused('rate', (c) => {
    resources(c).Endpoint.Properties.ThrottleConfig.RateLimit = 1000;
  });
  refused('scale', (c) => {
    resources(c).Endpoint.Properties.ScalingConfig.MaxEnvironments = 50;
  });
  refused('weights', (c) => {
    resources(c).Endpoint.Properties.RevisionWeights[0].Weight = 50;
  });
});

test('the revision reads the public site only, inside the origin wait', () => {
  refused('an environment variable', (c) => {
    resources(
      c,
    ).Revision.Properties.ServiceConfig.EnvironmentVariables.DATA_BUCKET =
      'links-site';
  });
  refused('a network connector', (c) => {
    resources(c).Revision.Properties.ServiceConfig.EgressNetworkConnectorArn =
      'arn:aws:lambda:us-east-1:999153317627:network-connector/x';
  });
  refused('timeout', (c) => {
    resources(c).Revision.Properties.ServiceConfig.TimeoutSeconds = 60;
  });
  refused('runtime', (c) => {
    resources(c).Revision.Properties.BuildConfig.RuntimeConfig.Runtime =
      'nodejs22.x';
  });
  refused('compute before code', (c) => {
    delete resources(c).Function.Condition;
  });
});

test('the execution role writes its logs and nothing else', () => {
  refused('another statement', (c) => {
    resources(
      c,
    ).ExecutionRole.Properties.Policies[0].PolicyDocument.Statement.push({
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: '*',
    });
  });
  refused('a managed policy', (c) => {
    resources(c).ExecutionRole.Properties.ManagedPolicyArns = [
      'arn:aws:iam::aws:policy/ReadOnlyAccess',
    ];
  });
  refused('another trusted service', (c) => {
    resources(
      c,
    ).ExecutionRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service =
      ['lambda.amazonaws.com', 'ec2.amazonaws.com'];
  });
  refused('log retention', (c) => {
    resources(c).Logs.Properties.RetentionInDays = 3653;
  });
});

test('the code bucket stays private, versioned and read by this function only', () => {
  refused('public policy', (c) => {
    resources(
      c,
    ).CodeBucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy =
      false;
  });
  refused('versioning', (c) => {
    resources(c).CodeBucket.Properties.VersioningConfiguration.Status =
      'Suspended';
  });
  refused('any principal', (c) => {
    resources(
      c,
    ).CodeBucketPolicy.Properties.PolicyDocument.Statement[0].Principal = '*';
  });
  refused('any function', (c) => {
    resources(
      c,
    ).CodeBucketPolicy.Properties.PolicyDocument.Statement[0].Condition.ArnLike =
      {
        'aws:SourceArn': {
          'Fn::Sub':
            'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:*',
        },
      };
  });
  refused('no TLS rule', (c) => {
    resources(c).CodeBucketPolicy.Properties.PolicyDocument.Statement.pop();
  });
});

test('the distribution signs every /mcp request and caches and forwards nothing', () => {
  refused('signing', (c) => {
    c.site.Resources.McpOriginAccess.Properties.OriginAccessControlConfig.SigningBehavior =
      'no-override';
  });
  refused('plain HTTP to the origin', (c) => {
    mcpOrigin(c).CustomOriginConfig.OriginProtocolPolicy = 'match-viewer';
  });
  refused('a cookie forwarded', (c) => {
    c.site.Resources.McpRequestPolicy.Properties.OriginRequestPolicyConfig.CookiesConfig =
      { CookieBehavior: 'all' };
  });
  refused('a query string forwarded', (c) => {
    c.site.Resources.McpRequestPolicy.Properties.OriginRequestPolicyConfig.QueryStringsConfig =
      { QueryStringBehavior: 'all' };
  });
  refused('another header forwarded', (c) => {
    c.site.Resources.McpRequestPolicy.Properties.OriginRequestPolicyConfig.HeadersConfig.Headers.push(
      'Authorization',
    );
  });
  refused('cached', (c) => {
    c.site.Resources.McpCachePolicy.Properties.CachePolicyConfig.DefaultTTL = 300;
  });
  refused('an edge function on /mcp', (c) => {
    mcpBehavior(c).FunctionAssociations = [
      { EventType: 'viewer-request', FunctionARN: 'x' },
    ];
  });
  refused('a wider path', (c) => {
    mcpBehavior(c).PathPattern = '/*';
  });
});

test("the deploy's MCP grants are exactly the listed ones", () => {
  refused('delete code', (c) => {
    mcpDelivery(c)[0].Action.push('s3:DeleteObject');
  });
  refused('any stack', (c) => {
    mcpDelivery(c)[1].Resource = {
      'Fn::Sub':
        'arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/*',
    };
  });
  refused('change who may invoke', (c) => {
    mcpDelivery(c)[2].Action.push('lambda:PutResourcePolicy');
  });
  refused('pass the role to anything', (c) => {
    delete mcpDelivery(c)[5].Condition;
  });
  refused('another statement', (c) => {
    mcpDelivery(c).push({ Effect: 'Allow', Action: 'lambda:*', Resource: '*' });
  });
  refused('granted before the stack exists', (c) => {
    c.delivery.Resources.DeploymentRole.Properties.Policies[1] =
      c.delivery.Resources.DeploymentRole.Properties.Policies[1]['Fn::If'][1];
  });
  refused('another stack name', (c) => {
    c.deployment.stacks.mcp = 'links-api';
  });
});

test("the CodeKey parameter and the deploy agree on a bundle's key", () => {
  const pattern = new RegExp(infra.mcp.Parameters.CodeKey.AllowedPattern);
  const good = `mcp/${'0123456789abcdef'.repeat(4)}.zip`;
  for (const key of [good]) {
    assert.ok(KEY.test(key));
    assert.ok(pattern.test(key));
  }
  assert.ok(pattern.test(''), 'empty is phase one');
  assert.ok(!KEY.test(''));
  for (const key of [
    `mcp/${'A'.repeat(64)}.zip`,
    `mcp/${'a'.repeat(63)}.zip`,
    `site/${'a'.repeat(64)}.zip`,
    `mcp/../${'a'.repeat(64)}.zip`,
    `mcp/${'a'.repeat(64)}.zip.bak`,
  ]) {
    assert.ok(!KEY.test(key), key);
    assert.ok(!pattern.test(key), key);
  }
});

test('a deploy changes the code parameters and keeps every other value', () => {
  const key = `mcp/${'b'.repeat(64)}.zip`;
  assert.deepEqual(
    deployParameters(
      [
        { ParameterKey: 'CodeKey', ParameterValue: 'old' },
        { ParameterKey: 'Other', ParameterValue: 'kept' },
        { ParameterKey: 'CodeVersion', ParameterValue: 'v1' },
      ],
      key,
      'v2',
    ),
    [
      { ParameterKey: 'CodeKey', ParameterValue: key },
      { ParameterKey: 'Other', UsePreviousValue: true },
      { ParameterKey: 'CodeVersion', ParameterValue: 'v2' },
    ],
  );
  const both = [{ ParameterKey: 'CodeKey' }, { ParameterKey: 'CodeVersion' }];
  assert.throws(
    () => deployParameters(both, 'mcp/x.zip', 'v2'),
    /Not a bundle key/,
  );
  assert.throws(() => deployParameters(both, key, ''), /No object version/);
  assert.throws(
    () => deployParameters([{ ParameterKey: 'CodeKey' }], key, 'v2'),
    /no CodeVersion/,
  );
});

test('a deploy executes only a new revision and the endpoint repointed at it', () => {
  const change = (LogicalResourceId, Action, Replacement) => ({
    ResourceChange: { LogicalResourceId, Action, Replacement },
  });
  const revision = change('Revision', 'Modify', 'True');
  const endpoint = change('Endpoint', 'Modify', 'False');
  assert.deepEqual(unexpectedChanges([revision, endpoint]), []);
  assert.deepEqual(
    unexpectedChanges([
      revision,
      endpoint,
      change('ExecutionRole', 'Modify', 'False'),
    ]),
    ['Modify ExecutionRole (replacement: False)'],
  );
  assert.deepEqual(
    unexpectedChanges([change('Revision', 'Modify', 'Conditional'), endpoint]),
    ['Modify Revision (replacement: Conditional)'],
  );
  assert.deepEqual(
    unexpectedChanges([revision, change('Endpoint', 'Modify', 'True')]),
    ['Modify Endpoint (replacement: True)'],
  );
  assert.deepEqual(
    unexpectedChanges([revision, endpoint, change('Function', 'Remove')]),
    ['Remove Function'],
  );
  assert.deepEqual(unexpectedChanges([revision]), [
    'the endpoint is not repointed',
  ]);
  assert.deepEqual(unexpectedChanges([]), [
    'no new revision',
    'the endpoint is not repointed',
  ]);
  assert.ok(STABLE.every((status) => status.endsWith('_COMPLETE')));
  assert.ok(
    !STABLE.includes('ROLLBACK_COMPLETE'),
    'a failed create is not deployable',
  );
});

// A zip, read back the way an unzipper reads it.
function unzip(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const madeBy = archive.readUInt16LE(at + 4);
    const method = archive.readUInt16LE(at + 10);
    const time = archive.readUInt16LE(at + 12);
    const date = archive.readUInt16LE(at + 14);
    const crc = archive.readUInt32LE(at + 16);
    const packed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const mode = archive.readUInt32LE(at + 38) >>> 16;
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start =
      local +
      30 +
      archive.readUInt16LE(local + 26) +
      archive.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(archive.subarray(start, start + packed));
    entries.push({
      name,
      madeBy: madeBy >> 8,
      method,
      time,
      date,
      crc,
      size,
      mode,
      data,
    });
    at += 46 + nameLength;
  }
  return entries;
}

test('the package zip is deterministic and every entry reads back', () => {
  const files = [
    {
      name: 'pagefind.js',
      data: Buffer.from('export const createInstance = () => ({});\n'),
    },
    { name: 'index.js', data: Buffer.from('console.log("hi");\n'.repeat(50)) },
    { name: 'package.json', data: Buffer.from('{"type":"module"}\n') },
  ];
  const archive = zip(files);
  assert.ok(
    archive.equals(zip([...files].reverse())),
    'the order given does not matter',
  );
  const entries = unzip(archive);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['index.js', 'package.json', 'pagefind.js'],
  );
  for (const entry of entries) {
    const file = files.find((f) => f.name === entry.name);
    assert.ok(entry.data.equals(file.data), entry.name);
    assert.equal(entry.size, file.data.length);
    assert.equal(entry.crc, zlib.crc32(file.data));
    assert.equal(entry.method, 8, 'deflate');
    assert.equal(entry.madeBy, 3, 'Unix, so the mode holds');
    assert.equal(entry.mode, 0o100644);
    assert.equal(entry.time, 0);
    assert.equal(entry.date, (1 << 5) | 1, '1980-01-01');
  }
});

test('the server bundles to one module that imports only Node built-ins', async () => {
  const code = (await bundle()).toString('utf8');
  const imports = [
    ...code.matchAll(/^import\s.*?from\s*["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) assert.match(specifier, /^node:/, specifier);
  assert.match(code, /pagefind\.js/, 'Pagefind is loaded from beside it');
  assert.doesNotMatch(code, /pinboard/i);
});

test('packaging without a site build says to build first and writes nothing', async () => {
  await assert.rejects(
    packageMcp({ pagefind: 'no-such-dir/pagefind.js', out: 'no-such-dir/out' }),
    /run npm run build first/,
  );
});
