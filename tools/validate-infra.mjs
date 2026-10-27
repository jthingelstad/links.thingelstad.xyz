// Pin the parts of infra/*.json that the site's privacy, security and
// delivery depend on, so a template edit that weakens one fails CI before any
// change set is made. cfn-lint checks the schema; this checks the intent.
// tests/mcp-infra.test.mjs runs validate() on edited copies to prove the MCP
// pins bite.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const DOMAIN = 'links.thingelstad.xyz';
// GitHub's immutable subject (owner and repository ids), so a renamed or
// recreated repository with the same name cannot assume the role.
const SUBJECT = 'repo:jthingelstad@5351/links.thingelstad.xyz@1431527619';
export const NAMES = [
  'storage',
  'site',
  'delivery',
  'certificate',
  'deployment',
  'mcp',
  'publisher',
];

export async function readInfra(folder = 'infra') {
  const templates = {};
  for (const name of NAMES)
    templates[name] = JSON.parse(
      await fs.readFile(`${folder}/${name}.json`, 'utf8'),
    );
  return templates;
}

export function validate({
  storage,
  site,
  delivery,
  certificate,
  deployment,
  mcp,
  publisher,
}) {
  // One private, retained, versioned, encrypted web bucket.
  assert.deepEqual(
    Object.entries(storage.Resources)
      .filter(([, r]) => r.Type === 'AWS::S3::Bucket')
      .map(([name]) => name),
    ['SiteBucket', 'BookmarkInbox'],
    'storage has the public origin and the separate private bookmark inbox',
  );
  const bucket = storage.Resources.SiteBucket;
  const inbox = storage.Resources.BookmarkInbox;
  assert.equal(inbox.DeletionPolicy, 'Retain');
  assert.equal(inbox.UpdateReplacePolicy, 'Retain');
  assert.equal(
    inbox.Properties.BucketName['Fn::Sub'],
    '${AWS::StackName}-inbox-${AWS::AccountId}',
  );
  for (const property of [
    'PublicAccessBlockConfiguration',
    'BucketEncryption',
    'OwnershipControls',
    'VersioningConfiguration',
  ])
    assert.deepEqual(inbox.Properties[property], bucket.Properties[property]);
  const inboxPolicy =
    storage.Resources.BookmarkInboxPolicy.Properties.PolicyDocument.Statement;
  assert.equal(
    inboxPolicy.length,
    1,
    'the inbox has no CloudFront or public grant',
  );
  assert.equal(inboxPolicy[0].Effect, 'Deny');
  assert.deepEqual(inboxPolicy[0].Condition, {
    Bool: { 'aws:SecureTransport': 'false' },
  });
  const p = bucket.Properties;
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  assert.deepEqual(p.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  });
  assert.equal(
    p.OwnershipControls.Rules[0].ObjectOwnership,
    'BucketOwnerEnforced',
  );
  assert.equal(p.VersioningConfiguration.Status, 'Enabled');
  // SSE-S3 keeps a single-part upload's ETag equal to its md5, which the
  // deploy's diff relies on (tools/delivery-plan.mjs). SSE-KMS would not.
  assert.equal(
    p.BucketEncryption.ServerSideEncryptionConfiguration[0]
      .ServerSideEncryptionByDefault.SSEAlgorithm,
    'AES256',
  );
  const rules = p.LifecycleConfiguration.Rules;
  assert.ok(
    rules.some(
      (rule) =>
        rule.Status === 'Enabled' &&
        rule.NoncurrentVersionExpiration?.NoncurrentDays === 30,
    ),
    'removed and replaced objects are kept 30 days',
  );
  assert.ok(
    rules.some(
      (rule) =>
        rule.Status === 'Enabled' &&
        rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7,
    ),
  );
  const statements =
    storage.Resources.SiteBucketPolicy.Properties.PolicyDocument.Statement;
  assert.ok(
    statements.some(
      (s) =>
        s.Effect === 'Deny' &&
        s.Condition?.Bool?.['aws:SecureTransport'] === 'false',
    ),
  );
  const grant = statements.find((s) => s['Fn::If'])['Fn::If'][1];
  assert.equal(grant.Principal.Service, 'cloudfront.amazonaws.com');
  assert.equal(grant.Action, 's3:GetObject');
  assert.match(
    grant.Condition.StringEquals['AWS:SourceArn']['Fn::Sub'],
    /:distribution\/\$\{DistributionId\}$/,
    'only this distribution reads the bucket',
  );

  assert.equal(certificate.Resources.Certificate.Properties.DomainName, DOMAIN);
  assert.equal(
    certificate.Resources.Certificate.Properties.ValidationMethod,
    'DNS',
  );

  // HTTPS through a signed origin; nothing reaches the bucket directly.
  assert.ok(
    !JSON.stringify(site).includes('s3-website'),
    'Use signed HTTPS origins',
  );
  const oac = site.Resources.OriginAccess.Properties.OriginAccessControlConfig;
  assert.equal(oac.SigningBehavior, 'always');
  assert.equal(oac.OriginAccessControlOriginType, 's3');
  const dist = site.Resources.Distribution.Properties.DistributionConfig;
  const behavior = dist.DefaultCacheBehavior;
  assert.equal(behavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.deepEqual(behavior.AllowedMethods, ['GET', 'HEAD']);
  assert.equal(behavior.Compress, true);
  assert.deepEqual(dist.Aliases['Fn::If'][1], [DOMAIN]);
  assert.equal(
    dist.ViewerCertificate['Fn::If'][1].MinimumProtocolVersion,
    'TLSv1.2_2021',
  );
  assert.equal(dist.DefaultRootObject, 'index.html');
  assert.deepEqual(
    behavior.FunctionAssociations.map((f) => [
      f.EventType,
      f.FunctionARN['Fn::GetAtt'][0],
    ]),
    [
      ['viewer-request', 'IndexFunction'],
      ['viewer-response', 'CrawlerFunction'],
    ],
  );
  for (const name of ['IndexFunction', 'CrawlerFunction'])
    assert.equal(
      site.Resources[name].Properties.FunctionConfig.Runtime,
      'cloudfront-js-2.0',
    );
  for (const code of [403, 404]) {
    const page = dist.CustomErrorResponses.find((e) => e.ErrorCode === code);
    assert.equal(page.ResponseCode, 404);
    assert.equal(page.ResponsePagePath, '/404.html');
  }
  // The cache key is the path alone: no query string, cookie or header reaches
  // the origin, so a ?ts= or a tracking parameter never splits the cache.
  const cache = site.Resources.CachePolicy.Properties.CachePolicyConfig;
  const key = cache.ParametersInCacheKeyAndForwardedToOrigin;
  assert.equal(cache.MinTTL, 0);
  assert.equal(key.EnableAcceptEncodingGzip, true);
  assert.equal(key.EnableAcceptEncodingBrotli, true);
  assert.equal(key.QueryStringsConfig.QueryStringBehavior, 'none');
  assert.equal(key.CookiesConfig.CookieBehavior, 'none');
  assert.equal(key.HeadersConfig.HeaderBehavior, 'none');
  assert.ok(!behavior.OriginRequestPolicyId, 'nothing extra is forwarded');
  const security =
    site.Resources.Headers.Properties.ResponseHeadersPolicyConfig
      .SecurityHeadersConfig;
  assert.equal(security.ContentTypeOptions.Override, true);
  assert.equal(
    security.StrictTransportSecurity.AccessControlMaxAgeSec,
    31536000,
  );

  // The access log keeps no client address and no cookie, for 14 days.
  const accessLog = site.Resources.AccessLogDelivery.Properties.RecordFields;
  assert.ok(accessLog.includes('time-to-first-byte'));
  assert.ok(
    !accessLog.some((field) =>
      /^c-ip|^c-port|x-forwarded-for|cs\(Cookie\)|cs\(Referer\)/i.test(field),
    ),
    'The access log records no client addresses, cookies or referrers',
  );
  assert.equal(site.Resources.AccessLogGroup.Properties.RetentionInDays, 14);
  const alarm = site.Resources.Distribution5xxAlarm.Properties;
  assert.equal(alarm.MetricName, '5xxErrorRate');
  assert.equal(
    alarm.AlarmActions[0]['Fn::Sub'].split(':').at(-1),
    deployment.alarmTopic.split(':').at(-1),
  );

  // One role, assumable only from this repository's main branch, that can
  // publish objects and invalidate this distribution and nothing else.
  assert.deepEqual(Object.keys(delivery.Resources), ['DeploymentRole']);
  const role = delivery.Resources.DeploymentRole.Properties;
  const trust = role.AssumeRolePolicyDocument.Statement;
  assert.equal(trust.length, 1);
  assert.equal(trust[0].Action, 'sts:AssumeRoleWithWebIdentity');
  assert.match(
    trust[0].Principal.Federated['Fn::Sub'],
    /:oidc-provider\/token\.actions\.githubusercontent\.com$/,
  );
  const claim = trust[0].Condition.StringEquals;
  assert.deepEqual(Object.keys(trust[0].Condition), ['StringEquals']);
  assert.equal(
    claim['token.actions.githubusercontent.com:aud'],
    'sts.amazonaws.com',
  );
  assert.equal(
    claim['token.actions.githubusercontent.com:sub'],
    `${SUBJECT}:ref:refs/heads/main`,
  );
  // GitHub can promote one package and start/watch one publisher. It cannot
  // write the website, read captures, or deploy the MCP server.
  assert.equal(role.Policies.length, 1);
  assert.equal(role.Policies[0].PolicyName, 'PromotePublisher');
  assert.deepEqual(role.Policies[0].PolicyDocument.Statement, [
    {
      Effect: 'Allow',
      Action: ['s3:PutObject'],
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:s3:::${PublisherBucket}/releases/current.zip',
      },
    },
    {
      Effect: 'Allow',
      Action: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:codebuild:${AWS::Region}:${AWS::AccountId}:project/${PublisherProject}',
      },
    },
  ]);
  assert.ok(!role.ManagedPolicyArns);
  const project = publisher.Resources.Project.Properties;
  assert.equal(project.ConcurrentBuildLimit, 1);
  assert.deepEqual(project.Source, {
    Type: 'S3',
    Location: { 'Fn::Sub': '${InboxBucket}/releases/current.zip' },
    BuildSpec: 'tools/publisher-buildspec.yml',
  });
  assert.equal(project.Environment.PrivilegedMode, false);
  const start =
    publisher.Resources.StartRole.Properties.Policies[0].PolicyDocument
      .Statement;
  assert.deepEqual(start, [
    {
      Effect: 'Allow',
      Action: ['codebuild:StartBuild'],
      Resource: { 'Fn::GetAtt': ['Project', 'Arn'] },
    },
  ]);
  const rule = publisher.Resources.BookmarkRule.Properties;
  assert.deepEqual(rule.EventPattern, {
    source: ['pinboard'],
    'detail-type': ['bookmarks-ready'],
  });
  assert.equal(rule.EventBusName.Ref, 'PublishingBus');
  assert.ok(!JSON.stringify(publisher).includes('DeleteObjectVersion'));
  const publisherRole = publisher.Resources.PublisherRole.Properties;
  assert.equal(
    publisherRole.AssumeRolePolicyDocument.Statement[0].Principal.Service,
    'codebuild.amazonaws.com',
  );
  assert.equal(publisherRole.Policies[0].PolicyName, 'SiteDelivery');
  assert.deepEqual(publisherRole.Policies[0].PolicyDocument.Statement, [
    {
      Effect: 'Allow',
      Action: ['s3:ListBucket', 's3:GetBucketLocation'],
      Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${SiteBucket}' },
    },
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${SiteBucket}/*' },
    },
    {
      Effect: 'Allow',
      Action: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${DistributionId}',
      },
    },
  ]);
  assert.equal(deployment.account, '999153317627');
  assert.equal(deployment.region, 'us-east-1');
  assert.equal(deployment.productionUrl, `https://${DOMAIN}/`);
  assert.equal(
    deployment.siteBucket,
    `${deployment.stacks.storage}-web-${deployment.account}`,
  );
  assert.equal(
    site.Parameters.SiteBucket.Default,
    deployment.siteBucket,
    'site.json names the bucket storage.json makes',
  );
  assert.equal(
    deployment.stackTags.Repository,
    'jthingelstad/links.thingelstad.xyz',
  );
  validateMcp({ site, publisher, deployment, mcp });
}

// The MCP server: a Lambda Web Function whose endpoint answers only signed
// requests (IamAuth), from the site's distribution, at /mcp. Its role writes
// its logs and nothing else; the deploy can upload a bundle, swap the revision
// on the links-mcp stack and pass that one role, and nothing else.
export function validateMcp({ site, publisher, deployment, mcp }) {
  const STACK = deployment.stacks.mcp;
  assert.equal(STACK, 'links-mcp');
  assert.equal(deployment.mcpCodeBucket, `${STACK}-code-${deployment.account}`);
  const r = mcp.Resources;
  const active = 'NativeWebActive';

  // One private, retained, versioned, encrypted code bucket that only this
  // function's revisions read, over TLS.
  assert.deepEqual(
    Object.entries(r)
      .filter(([, x]) => x.Type === 'AWS::S3::Bucket')
      .map(([name]) => name),
    ['CodeBucket'],
  );
  const code = r.CodeBucket;
  assert.equal(code.DeletionPolicy, 'Retain');
  assert.equal(code.UpdateReplacePolicy, 'Retain');
  assert.equal(
    code.Properties.BucketName['Fn::Sub'],
    '${AWS::StackName}-code-${AWS::AccountId}',
  );
  assert.deepEqual(code.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  });
  assert.equal(code.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.equal(
    code.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
      .ServerSideEncryptionByDefault.SSEAlgorithm,
    'AES256',
  );
  const statements = r.CodeBucketPolicy.Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 2, 'a read grant and the TLS rule');
  const [read, tls] = statements;
  assert.deepEqual(read.Principal, { Service: 'lambda.amazonaws.com' });
  assert.deepEqual(read.Action, ['s3:GetObject', 's3:GetObjectVersion']);
  assert.equal(read.Resource['Fn::Sub'], '${CodeBucket.Arn}/mcp/*');
  assert.deepEqual(read.Condition.StringEquals, {
    'aws:SourceAccount': { Ref: 'AWS::AccountId' },
  });
  assert.match(
    read.Condition.ArnLike['aws:SourceArn']['Fn::Sub'],
    /:web-function\/\$\{AWS::StackName\}\/\*$/,
  );
  assert.equal(tls.Effect, 'Deny');
  assert.equal(tls.Condition.Bool['aws:SecureTransport'], 'false');

  // The execution role writes its two log groups and nothing else.
  const exec = r.ExecutionRole.Properties;
  assert.deepEqual(exec.AssumeRolePolicyDocument.Statement, [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ]);
  assert.ok(!exec.ManagedPolicyArns, 'no managed policies');
  assert.equal(exec.Policies.length, 1);
  assert.deepEqual(exec.Policies[0].PolicyDocument.Statement, [
    {
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: [
        { 'Fn::GetAtt': ['Logs', 'Arn'] },
        { 'Fn::GetAtt': ['LocalLogs', 'Arn'] },
      ],
    },
  ]);
  for (const [name, suffix] of [
    ['Logs', ''],
    ['LocalLogs', '.local'],
  ]) {
    assert.equal(
      r[name].Properties.LogGroupName['Fn::Sub'],
      `/aws/lambda-web/\${AWS::StackName}${suffix}`,
    );
    assert.equal(r[name].Properties.RetentionInDays, 30);
  }

  // Compute exists only with code: an empty CodeKey is phase one.
  for (const name of ['Function', 'Revision', 'Endpoint', 'Endpoint5xxAlarm'])
    assert.equal(r[name].Condition, active, `${name} waits for code`);
  assert.equal(
    mcp.Parameters.CodeKey.AllowedPattern,
    '^$|^mcp/[0-9a-f]{64}\\.zip$',
  );
  const revision = r.Revision;
  assert.equal(revision.DeletionPolicy, 'Retain');
  assert.equal(revision.UpdateReplacePolicy, 'Retain');
  const build = revision.Properties.BuildConfig;
  assert.deepEqual(build.CodeConfig.S3Object, {
    Bucket: { Ref: 'CodeBucket' },
    Key: { Ref: 'CodeKey' },
    VersionId: { Ref: 'CodeVersion' },
  });
  assert.equal(build.RuntimeConfig.Runtime, 'nodejs24.x');
  const service = revision.Properties.ServiceConfig;
  assert.deepEqual(service.ExecutionRoleArn, {
    'Fn::GetAtt': ['ExecutionRole', 'Arn'],
  });
  assert.ok(service.TimeoutSeconds <= 28, 'inside the 30 second origin wait');
  assert.equal(service.MaxConcurrencyPerEnvironment, 8);
  assert.deepEqual(service.EnvironmentVariables, {
    LINKS_SITE: `https://${DOMAIN}`,
    LINKS_MCP_CODE: { Ref: 'CodeKey' },
  });
  assert.deepEqual(revision.Properties.Description, { Ref: 'CodeKey' });
  assert.ok(
    !service.EgressNetworkConnectorArn,
    'the server reaches the public site only',
  );

  // The endpoint answers signed requests only, at a small rate and scale.
  const endpoint = r.Endpoint.Properties;
  assert.equal(endpoint.AuthType, 'IamAuth');
  assert.equal(endpoint.EndpointType, 'HomeRegion');
  assert.equal(endpoint.EndpointName, 'live');
  assert.deepEqual(endpoint.RevisionWeights, [
    { RevisionId: { 'Fn::GetAtt': ['Revision', 'RevisionId'] }, Weight: 100 },
  ]);
  // The smallest of each the endpoint accepts: a rate limit is 0 (closed),
  // 100 to 1000 by hundreds or 2000 to 10000 by thousands, and at least two
  // environments (the WebFunctionEndpoint template reference).
  assert.deepEqual(endpoint.ThrottleConfig, { RateLimit: 100 });
  assert.deepEqual(endpoint.ScalingConfig, { MaxEnvironments: 2 });
  const alarm = r.Endpoint5xxAlarm.Properties;
  assert.equal(alarm.MetricName, 'HTTPResponseStatusClass5XX');
  assert.equal(
    alarm.AlarmActions[0]['Fn::Sub'].split(':').at(-1),
    deployment.alarmTopic.split(':').at(-1),
  );

  // The site reaches it at /mcp* through a lambda OAC that signs every
  // request, with nothing cached and no cookie or query string forwarded.
  const oac = site.Resources.McpOriginAccess;
  assert.equal(oac.Condition, 'HasMcp');
  assert.deepEqual(oac.Properties.OriginAccessControlConfig, {
    Name: { 'Fn::Sub': '${AWS::StackName}-mcp' },
    OriginAccessControlOriginType: 'lambda',
    SigningBehavior: 'always-amz-auth',
    SigningProtocol: 'sigv4',
  });
  const dist = site.Resources.Distribution.Properties.DistributionConfig;
  const [originIf, origin, none] = dist.Origins.find((o) => o['Fn::If'])[
    'Fn::If'
  ];
  assert.equal(originIf, 'HasMcp');
  assert.deepEqual(none, { Ref: 'AWS::NoValue' });
  assert.equal(origin.Id, 'mcp');
  assert.deepEqual(origin.DomainName, { Ref: 'McpOriginDomain' });
  assert.deepEqual(origin.OriginAccessControlId, { Ref: 'McpOriginAccess' });
  assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, 'https-only');
  assert.deepEqual(origin.CustomOriginConfig.OriginSSLProtocols, ['TLSv1.2']);
  const [behaviorIf, behaviors, noBehaviors] = dist.CacheBehaviors['Fn::If'];
  assert.equal(behaviorIf, 'HasMcp');
  assert.deepEqual(noBehaviors, { Ref: 'AWS::NoValue' });
  assert.equal(behaviors.length, 1, 'one extra behaviour, /mcp*');
  const [behavior] = behaviors;
  assert.equal(behavior.PathPattern, '/mcp*');
  assert.equal(behavior.TargetOriginId, 'mcp');
  assert.ok(!behavior.FunctionAssociations, 'no edge function on /mcp');
  assert.deepEqual(behavior.CachedMethods, ['GET', 'HEAD']);
  assert.ok(behavior.AllowedMethods.includes('POST'));
  const cache =
    site.Resources[behavior.CachePolicyId.Ref].Properties.CachePolicyConfig;
  assert.equal(cache.MinTTL, 0);
  assert.equal(cache.DefaultTTL, 0);
  assert.ok(cache.MaxTTL <= 1, 'nothing from /mcp is cached');
  const key = cache.ParametersInCacheKeyAndForwardedToOrigin;
  assert.equal(key.CookiesConfig.CookieBehavior, 'none');
  assert.equal(key.QueryStringsConfig.QueryStringBehavior, 'none');
  assert.equal(key.HeadersConfig.HeaderBehavior, 'none');
  const forwarded =
    site.Resources[behavior.OriginRequestPolicyId.Ref].Properties
      .OriginRequestPolicyConfig;
  assert.equal(forwarded.CookiesConfig.CookieBehavior, 'none');
  assert.equal(forwarded.QueryStringsConfig.QueryStringBehavior, 'none');
  assert.deepEqual(forwarded.HeadersConfig.Headers, [
    'Origin',
    'Content-Type',
    'Accept',
    'User-Agent',
    'MCP-Protocol-Version',
    'Mcp-Session-Id',
  ]);

  // The deploy's MCP actions, exactly, and only once the mcp stack exists.
  const role = publisher.Resources.PublisherRole.Properties;
  assert.ok(
    Array.isArray(role.Policies[1]['Fn::If']),
    'the MCP grants wait for the mcp stack',
  );
  const [condition, policy, absent] = role.Policies[1]['Fn::If'];
  assert.equal(condition, 'HasMcp');
  assert.deepEqual(absent, { Ref: 'AWS::NoValue' });
  assert.equal(policy.PolicyName, 'McpDelivery');
  const lambda = `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:web-function/${STACK}`;
  const granted = policy.PolicyDocument.Statement.map((s) => {
    assert.equal(s.Effect, 'Allow');
    return [s.Action, s.Resource['Fn::Sub'] ?? s.Resource, s.Condition];
  });
  assert.deepEqual(granted, [
    [
      ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
      'arn:${AWS::Partition}:s3:::${McpCodeBucket}/mcp/*',
      undefined,
    ],
    [
      [
        'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents',
        'cloudformation:CreateChangeSet',
        'cloudformation:DescribeChangeSet',
        'cloudformation:ExecuteChangeSet',
        'cloudformation:DeleteChangeSet',
      ],
      `arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/${STACK}/*`,
      undefined,
    ],
    [
      ['lambda:CreateWebFunctionRevision', 'lambda:GetWebFunction'],
      lambda,
      undefined,
    ],
    [['lambda:GetWebFunctionRevision'], `${lambda}/revision/*`, undefined],
    [
      ['lambda:GetWebFunctionEndpoint', 'lambda:UpdateWebFunctionEndpoint'],
      `${lambda}/endpoint/*`,
      undefined,
    ],
    [
      ['iam:PassRole'],
      { Ref: 'McpExecutionRoleArn' },
      { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
    ],
    // CloudFormation resolves the revision's ExecutionRoleArn (a GetAtt on the
    // role) with the deploy's own credentials, so the deploy may read that
    // one role. Without it a revision swap fails at "Unable to retrieve Arn
    // attribute for AWS::IAM::Role" (2026-10-24).
    [['iam:GetRole'], { Ref: 'McpExecutionRoleArn' }, undefined],
  ]);
  assert.ok(
    !JSON.stringify(policy).match(/DeleteObject|PutResourcePolicy|:\*"/),
    'the deploy cannot delete code or change who may invoke the endpoint',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // No em dash anywhere in the infrastructure (AWS names and descriptions use
  // hyphens).
  const dash = String.fromCodePoint(0x2014);
  for (const file of await fs.readdir('infra'))
    assert.ok(
      !(await fs.readFile(`infra/${file}`, 'utf8')).includes(dash),
      `infra/${file} has an em dash`,
    );
  validate(await readInfra());
  console.log(
    'One private retained versioned bucket, HTTPS through OAC, a path-only cache key, a log without client addresses, a main-only OIDC role, and an IAM-only MCP endpoint behind the distribution validated.',
  );
}
