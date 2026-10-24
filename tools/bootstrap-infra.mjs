// Create the site's CloudFormation stacks and print the DNS records.
//
//   node tools/bootstrap-infra.mjs plan    create change sets, print them, execute nothing
//   node tools/bootstrap-infra.mjs apply   execute the change sets, in order
//     --mcp-only                           stop once the links-mcp stack is in place
//   node tools/bootstrap-infra.mjs attach  once the certificate is ISSUED: give the
//                                          distribution its alias and certificate
//
// Run with the cloud-engineer identity in us-east-1 (AWS_PROFILE=cloud-engineer),
// after npm run build (apply packages the MCP server with the build's Pagefind
// client). Order: mcp (the MCP server, whose endpoint the site's /mcp routes
// to: first its code bucket and roles, then, once apply has uploaded the
// packaged server, its function, revision and endpoint), the distribution's
// grant on that endpoint, storage, site, storage again (the bucket policy
// needs the distribution id), delivery (which gets the MCP deploy's actions
// once the mcp stack exists), certificate. On the live site the MCP goes in
// two reviewed rounds: plan, apply --mcp-only (the links-mcp stack alone),
// then plan again, which now shows the grant and the site and delivery change
// sets naming the new endpoint, and apply. The certificate goes last because
// its stack does not finish until the ACM validation record is in DNS: apply
// prints that record as soon as ACM has it, together with the site's record,
// so Jamie adds both at Namecheap in one visit while apply waits. If apply is
// cut off, run it again: finished stacks report no changes and a stack still
// in progress is waited for. Each apply or attach rewrites
// infra/deployment.json from the live stacks. Infrastructure changes after
// bootstrap go through reviewed change sets, never through the GitHub
// deployment role.
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';
import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import {
  GetResourcePolicyCommand,
  LambdaWebClient,
  PutResourcePolicyCommand,
} from '@aws-sdk/client-lambda-web';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import fs from 'node:fs/promises';
import { packageMcp } from './package-mcp.mjs';

const mode = process.argv[2];
// apply --mcp-only stops once the links-mcp stack is in place, so a second
// plan can show the distribution's grant and the site and delivery change
// sets, which name the new endpoint, before they run (docs/deployment.md).
const mcpOnly = process.argv.includes('--mcp-only');
if (
  !['plan', 'apply', 'attach'].includes(mode) ||
  (mcpOnly && mode !== 'apply')
)
  throw new Error(
    'Usage: node tools/bootstrap-infra.mjs plan|apply [--mcp-only]|attach',
  );
const config = JSON.parse(await fs.readFile('infra/deployment.json', 'utf8'));
const settings = { region: config.region, maxAttempts: 5 };
const identity = await new STSClient(settings).send(
  new GetCallerIdentityCommand({}),
);
if (identity.Account !== config.account)
  throw new Error(`Unexpected AWS account ${identity.Account}`);
console.log(`Identity ${identity.Arn}`);
const cfn = new CloudFormationClient(settings);
const acm = new ACMClient(settings);
const web = new LambdaWebClient(settings);
const s3 = new S3Client(settings);
const Tags = Object.entries(config.stackTags).map(([Key, Value]) => ({
  Key,
  Value,
}));
const template = (name) => fs.readFile(`infra/${name}.json`, 'utf8');
const CERTIFICATE_WAIT = 3600;

async function stack(name) {
  try {
    const { Stacks } = await cfn.send(
      new DescribeStacksCommand({ StackName: name }),
    );
    // A CREATE change set left by `plan` parks a new stack in REVIEW_IN_PROGRESS
    // with no resources; it still takes a CREATE change set, never an UPDATE.
    if (Stacks[0].StackStatus === 'REVIEW_IN_PROGRESS') return undefined;
    return Stacks[0];
  } catch (error) {
    if (/does not exist/.test(error.message)) return undefined;
    throw error;
  }
}
const outputs = (s) =>
  Object.fromEntries(
    (s?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]),
  );
const parameter = (s, key) =>
  s?.Parameters?.find((p) => p.ParameterKey === key)?.ParameterValue || '';
const host = (name) => name.replace(/\.?thingelstad\.xyz\.?$/, '') || '@';

function printValidation(record) {
  console.log(
    `DNS  CNAME  host ${host(record.Name)}  ->  ${record.Value.replace(/\.$/, '')}   (ACM validation; keep for renewal)`,
  );
}

// While the certificate stack waits for DNS validation, print the record
// Jamie has to add, as soon as ACM has it.
async function announceValidation(name, finished) {
  while (!finished()) {
    try {
      const { StackResourceDetail } = await cfn.send(
        new DescribeStackResourceCommand({
          StackName: name,
          LogicalResourceId: 'Certificate',
        }),
      );
      const arn = StackResourceDetail?.PhysicalResourceId;
      if (arn?.startsWith('arn:')) {
        const { Certificate } = await acm.send(
          new DescribeCertificateCommand({ CertificateArn: arn }),
        );
        const record =
          Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
        if (record) {
          printValidation(record);
          console.log(
            `Waiting up to ${CERTIFICATE_WAIT / 60} minutes for ACM to see it.`,
          );
          return;
        }
      }
    } catch (error) {
      if (!/does not exist|not found/i.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

async function waitFor(name, file, create) {
  let finished = false;
  const wait = create
    ? waitUntilStackCreateComplete
    : waitUntilStackUpdateComplete;
  const maxWaitTime = file === 'certificate' ? CERTIFICATE_WAIT : 1800;
  try {
    await Promise.all([
      wait({ client: cfn, maxWaitTime }, { StackName: name }).finally(() => {
        finished = true;
      }),
      file === 'certificate' && create
        ? announceValidation(name, () => finished)
        : null,
    ]);
  } catch (error) {
    const status = (await stack(name))?.StackStatus;
    throw new Error(
      `${name} is ${status}. ` +
        (status?.endsWith('_IN_PROGRESS')
          ? 'Run this command again to keep waiting.'
          : 'Read its events before going further.'),
      { cause: error },
    );
  }
}

// Create or update one stack through a change set, so the plan is visible
// before anything runs.
async function converge(name, file, parameters = {}, capabilities = []) {
  let existing = await stack(name);
  const status = existing?.StackStatus || '';
  if (status === 'ROLLBACK_COMPLETE')
    throw new Error(
      `${name} failed to create and has to be deleted before it can be created again (Jamie's go)`,
    );
  if (status.endsWith('_IN_PROGRESS')) {
    if (mode === 'plan') {
      console.log(`${name}: ${status}, nothing to plan until it finishes`);
      return existing;
    }
    console.log(`${name}: ${status}, waiting`);
    await waitFor(name, file, status.startsWith('CREATE'));
    existing = await stack(name);
  }
  const type = existing ? 'UPDATE' : 'CREATE';
  const ChangeSetName = `bootstrap-${Date.now()}`;
  await cfn.send(
    new CreateChangeSetCommand({
      StackName: name,
      ChangeSetName,
      ChangeSetType: type,
      TemplateBody: await template(file),
      Parameters: Object.entries(parameters).map(
        ([ParameterKey, ParameterValue]) => ({
          ParameterKey,
          ParameterValue,
        }),
      ),
      Capabilities: capabilities,
      Tags,
    }),
  );
  try {
    await waitUntilChangeSetCreateComplete(
      { client: cfn, maxWaitTime: 300 },
      { StackName: name, ChangeSetName },
    );
  } catch (error) {
    const { StatusReason } = await cfn.send(
      new DescribeChangeSetCommand({ StackName: name, ChangeSetName }),
    );
    if (
      /didn't contain changes|No updates are to be performed/.test(
        StatusReason || '',
      )
    ) {
      console.log(`${name}: no changes`);
      return existing;
    }
    throw new Error(`${name}: ${StatusReason || error.message}`, {
      cause: error,
    });
  }
  const { Changes } = await cfn.send(
    new DescribeChangeSetCommand({ StackName: name, ChangeSetName }),
  );
  console.log(`${name} (${type}, change set ${ChangeSetName}):`);
  for (const { ResourceChange: c } of Changes)
    console.log(
      `  ${c.Action} ${c.LogicalResourceId} ${c.ResourceType}${c.Replacement ? ` (replacement: ${c.Replacement})` : ''}`,
    );
  if (mode === 'plan') return existing;
  await cfn.send(
    new ExecuteChangeSetCommand({ StackName: name, ChangeSetName }),
  );
  await waitFor(name, file, type === 'CREATE');
  return stack(name);
}

async function record(values) {
  if (mode === 'plan') return;
  Object.assign(config, values);
  await fs.writeFile(
    'infra/deployment.json',
    JSON.stringify(config, null, 2) + '\n',
  );
  console.log('Wrote infra/deployment.json');
}

const { stacks } = config;
const siteExisting = await stack(stacks.site);
const certificateExisting = outputs(await stack(stacks.certificate));
let certificateArn = parameter(siteExisting, 'CertificateArn');
if (mode === 'attach') {
  if (!certificateExisting.CertificateArn)
    throw new Error(`${stacks.certificate} has no certificate yet; run apply`);
  const { Certificate } = await acm.send(
    new DescribeCertificateCommand({
      CertificateArn: certificateExisting.CertificateArn,
    }),
  );
  if (Certificate.Status !== 'ISSUED')
    throw new Error(`The certificate is ${Certificate.Status}, not ISSUED`);
  certificateArn = certificateExisting.CertificateArn;
}

// The MCP server's stack first: its endpoint is the site's /mcp origin. Phase
// one (no code yet) makes the code bucket, the execution role and the logs;
// apply then packages the server, uploads it and runs phase two, which adds
// the function, its first revision and the live endpoint. Later revisions are
// the CI deploy's (tools/deploy-mcp.mjs), so the live CodeKey and CodeVersion
// pass through unchanged here.
const mcpExisting = await stack(stacks.mcp);
let mcp = outputs(
  await converge(
    stacks.mcp,
    'mcp',
    {
      CodeKey: parameter(mcpExisting, 'CodeKey'),
      CodeVersion: parameter(mcpExisting, 'CodeVersion'),
    },
    ['CAPABILITY_IAM'],
  ),
);
if (!mcp.EndpointDomain && mode === 'plan')
  console.log(
    `${stacks.mcp}: apply then packages the server, uploads it and adds the function, its revision and the live endpoint`,
  );
else if (!mcp.EndpointDomain && mcp.CodeBucket) {
  const bundle = await packageMcp();
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: mcp.CodeBucket,
      Key: bundle.key,
      Body: await fs.readFile(bundle.path),
      ContentType: 'application/zip',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: bundle.checksumSha256,
    }),
  );
  if (!put.VersionId) throw new Error(`${mcp.CodeBucket} is not versioned`);
  console.log(`Uploaded ${bundle.key} (version ${put.VersionId})`);
  mcp = outputs(
    await converge(
      stacks.mcp,
      'mcp',
      { CodeKey: bundle.key, CodeVersion: put.VersionId },
      ['CAPABILITY_IAM'],
    ),
  );
}
if (mcpOnly) {
  console.log(
    `${stacks.mcp} is in place${mcp.EndpointDomain ? ` (endpoint ${mcp.EndpointDomain})` : ''}. Next: npm run infra:plan shows the distribution's grant and the site and delivery change sets; npm run infra:apply runs them on Jamie's go.`,
  );
  process.exit(0);
}

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

// CloudFront reaches the endpoint only through this grant: the function's
// resource policy lets the site's distribution, and nothing else, invoke the
// live endpoint. CloudFormation cannot set a web function's resource policy,
// so the bootstrap does, once; deploys never touch it. A policy other than
// this one is left alone for a person to read.
async function grantDistribution(distributionId) {
  if (!mcp.EndpointArn || !mcp.FunctionArn || !distributionId) return;
  const desired = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'SiteDistributionInvokesLive',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 'lambda:InvokeWebFunctionEndpoint',
        Resource: mcp.EndpointArn,
        Condition: {
          StringEquals: {
            'aws:SourceArn': `arn:aws:cloudfront::${config.account}:distribution/${distributionId}`,
          },
        },
      },
    ],
  };
  const read = async () => {
    try {
      const { policy } = await web.send(
        new GetResourcePolicyCommand({ resourceArn: mcp.FunctionArn }),
      );
      return policy ? JSON.parse(policy) : undefined;
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') return undefined;
      throw error;
    }
  };
  const current = await read();
  if (current && canonical(current) === canonical(desired)) {
    console.log(`${stacks.mcp}: the distribution's grant is in place`);
    return;
  }
  if (current)
    throw new Error(
      `${mcp.FunctionArn} has another resource policy; read it before replacing it: ${JSON.stringify(current)}`,
    );
  console.log(
    `${stacks.mcp}: grant ${distributionId} lambda:InvokeWebFunctionEndpoint on ${mcp.EndpointArn}`,
  );
  if (mode === 'plan') return;
  await web.send(
    new PutResourcePolicyCommand({
      resourceArn: mcp.FunctionArn,
      policy: JSON.stringify(desired),
    }),
  );
  const installed = await read();
  if (!installed || canonical(installed) !== canonical(desired))
    throw new Error('The distribution grant did not read back as written');
}
await grantDistribution(outputs(siteExisting).DistributionId);

// Keep the distribution's grant on the site bucket once it exists; an empty
// DistributionId here would cut CloudFront off until the second storage pass.
const storage = outputs(
  await converge(stacks.storage, 'storage', {
    DistributionId: outputs(siteExisting).DistributionId || '',
  }),
);
const siteBucket = storage.SiteBucket || config.siteBucket;
const site = outputs(
  await converge(stacks.site, 'site', {
    SiteBucket: siteBucket,
    CertificateArn: certificateArn,
    McpOriginDomain: mcp.EndpointDomain || '',
  }),
);
// A new distribution gets its grant now (the call is a no-op when it has it).
await grantDistribution(site.DistributionId);
if (site.DistributionId)
  await converge(stacks.storage, 'storage', {
    DistributionId: site.DistributionId,
  });
const delivery = outputs(
  await converge(
    stacks.delivery,
    'delivery',
    {
      SiteBucket: siteBucket,
      DistributionId: site.DistributionId || 'PENDING',
      McpCodeBucket: mcp.CodeBucket || '',
      McpExecutionRoleArn: mcp.ExecutionRoleArn || '',
    },
    ['CAPABILITY_IAM'],
  ),
);
await record({
  siteBucket,
  distributionId: site.DistributionId || null,
  cloudfrontDomain: site.DistributionDomain || null,
  deliveryUrl: site.DistributionDomain
    ? `https://${site.DistributionDomain}/`
    : null,
  deploymentRoleArn: delivery.DeploymentRoleArn || null,
  mcpCodeBucket: mcp.CodeBucket || config.mcpCodeBucket,
  mcpExecutionRoleArn: mcp.ExecutionRoleArn || null,
  mcpEndpointDomain: mcp.EndpointDomain || null,
});
if (site.DistributionDomain)
  console.log(
    `DNS  CNAME  host links  ->  ${site.DistributionDomain}   (the site)`,
  );

const cert = outputs(await converge(stacks.certificate, 'certificate'));
await record({ certificateArn: cert.CertificateArn || null });

// The records for Namecheap again, now that everything has run (host values
// are relative to thingelstad.xyz).
let certificateStatus = null;
if (cert.CertificateArn) {
  const { Certificate } = await acm.send(
    new DescribeCertificateCommand({ CertificateArn: cert.CertificateArn }),
  );
  certificateStatus = Certificate.Status;
  console.log(`\nCertificate ${certificateStatus}`);
  const validation = Certificate.DomainValidationOptions?.[0]?.ResourceRecord;
  if (validation) printValidation(validation);
}
if (site.DistributionDomain)
  console.log(
    `DNS  CNAME  host links  ->  ${site.DistributionDomain}   (the site)`,
  );
if (mode === 'apply' && cert.CertificateArn && !certificateArn)
  console.log(
    certificateStatus === 'ISSUED'
      ? '\nNext: npm run infra:attach'
      : '\nWhen ACM shows ISSUED: npm run infra:attach',
  );
if (delivery.DeploymentRoleArn)
  console.log(
    `\nGitHub repository variable AWS_DEPLOY_ROLE_ARN = ${delivery.DeploymentRoleArn}`,
  );
