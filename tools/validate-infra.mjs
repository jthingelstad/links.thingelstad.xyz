// Pin the parts of infra/*.json that the site's privacy, security and
// delivery depend on, so a template edit that weakens one fails CI before any
// change set is made. cfn-lint checks the schema; this checks the intent.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = async (name) =>
  JSON.parse(await fs.readFile(`infra/${name}.json`, 'utf8'));
const storage = await read('storage');
const site = await read('site');
const delivery = await read('delivery');
const certificate = await read('certificate');
const deployment = await read('deployment');
const DOMAIN = 'links.thingelstad.xyz';
// GitHub's immutable subject (owner and repository ids), so a renamed or
// recreated repository with the same name cannot assume the role.
const SUBJECT = 'repo:jthingelstad@5351/links.thingelstad.xyz@1431527619';

// No em dash anywhere in the infrastructure (AWS names and descriptions use
// hyphens).
const dash = String.fromCodePoint(0x2014);
for (const file of await fs.readdir('infra'))
  assert.ok(
    !(await fs.readFile(`infra/${file}`, 'utf8')).includes(dash),
    `infra/${file} has an em dash`,
  );

// One private, retained, versioned, encrypted web bucket.
assert.deepEqual(
  Object.entries(storage.Resources)
    .filter(([, r]) => r.Type === 'AWS::S3::Bucket')
    .map(([name]) => name),
  ['SiteBucket'],
  'storage has the web bucket only',
);
const bucket = storage.Resources.SiteBucket;
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
  [['viewer-request', 'IndexFunction']],
);
assert.equal(
  site.Resources.IndexFunction.Properties.FunctionConfig.Runtime,
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
assert.equal(security.StrictTransportSecurity.AccessControlMaxAgeSec, 31536000);

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
const allowed = new Set([
  's3:ListBucket',
  's3:GetBucketLocation',
  's3:GetObject',
  's3:PutObject',
  's3:DeleteObject',
  'cloudfront:CreateInvalidation',
  'cloudfront:GetInvalidation',
]);
assert.equal(role.Policies.length, 1);
assert.ok(!role.ManagedPolicyArns, 'no managed policies');
for (const s of role.Policies[0].PolicyDocument.Statement) {
  assert.equal(s.Effect, 'Allow');
  for (const action of s.Action)
    assert.ok(allowed.has(action), `${action} is not a delivery action`);
  assert.notEqual(s.Resource, '*');
  assert.ok(!JSON.stringify(s.Resource).includes('"*"'));
}
assert.ok(
  !JSON.stringify(delivery).includes('DeleteObjectVersion'),
  'the deploy cannot remove the 30-day versions',
);

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
console.log(
  'One private retained versioned bucket, HTTPS through OAC, a path-only cache key, a log without client addresses, and a main-only OIDC role validated.',
);
