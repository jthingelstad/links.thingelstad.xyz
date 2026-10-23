// Create the site's CloudFormation stacks and print the DNS records.
//
//   node tools/bootstrap-infra.mjs plan    create change sets, print them, execute nothing
//   node tools/bootstrap-infra.mjs apply   execute the change sets, in order
//   node tools/bootstrap-infra.mjs attach  once the certificate is ISSUED: give the
//                                          distribution its alias and certificate
//
// Run with the cloud-engineer identity in us-east-1 (AWS_PROFILE=cloud-engineer).
// Order: storage, site, storage again (the bucket policy needs the distribution
// id), delivery, certificate. The certificate goes last because its stack does
// not finish until the ACM validation record is in DNS: apply prints that
// record as soon as ACM has it, together with the site's record, so Jamie adds
// both at Namecheap in one visit while apply waits. If apply is cut off, run it
// again: finished stacks report no changes and a stack still in progress is
// waited for. Each apply or attach rewrites infra/deployment.json from the live
// stacks. Infrastructure changes after bootstrap go through reviewed change
// sets, never through the GitHub deployment role.
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
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import fs from 'node:fs/promises';

const mode = process.argv[2];
if (!['plan', 'apply', 'attach'].includes(mode))
  throw new Error('Usage: node tools/bootstrap-infra.mjs plan|apply|attach');
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
  }),
);
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
