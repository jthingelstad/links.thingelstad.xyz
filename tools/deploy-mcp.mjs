// Put the packaged MCP server (.build/mcp/, npm run mcp:package) live.
//
//   node tools/deploy-mcp.mjs            the approved AWS publisher only
//   node tools/deploy-mcp.mjs --dry-run  read the stack and print the plan;
//                                        writes nothing (any identity in the account)
//
// docs/deployment.md has the policy.
// 1. Read the links-mcp stack (infra/mcp.json). Until the bootstrap has put a
//    first revision in place (CodeKey set) there is nothing to deploy to.
// 2. The bundle's key is mcp/<sha256>.zip, a hash of the entries' names and
//    contents (tools/package-mcp.mjs), never of the zip's bytes. When the
//    stack's CodeKey is that key the live revision already runs these files,
//    so stop: a site-only change ends here.
// 3. Upload the zip with its SHA-256, which S3 checks; the response names the
//    object version the revision will bind.
// 4. Make a change set on the reviewed template (UsePreviousTemplate) with
//    CodeKey and CodeVersion changed and nothing else, and refuse it unless it
//    replaces the revision and points the endpoint at it, and touches nothing
//    more. The role can only do what the change needs, so a template edit
//    cannot ride along: those go through the bootstrap.
// 5. Execute, wait, then read /mcp/health through CloudFront until it reports
//    this key, and initialize once.
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { publicationContext } from './publication-context.mjs';
import path from 'node:path';
import {
  KEY,
  STABLE,
  deployParameters,
  unexpectedChanges,
} from './mcp-plan.mjs';
import { OUT } from './package-mcp.mjs';

const dryRun = process.argv.includes('--dry-run');
const config = JSON.parse(await fs.readFile('infra/deployment.json', 'utf8'));
const StackName = config.stacks.mcp;
const Bucket = config.mcpCodeBucket;

await main();

async function main() {
  if (!StackName || !Bucket || !config.deliveryUrl)
    throw new Error('infra/deployment.json names no MCP stack or code bucket');

  const manifest = JSON.parse(
    await fs.readFile(path.join(OUT, 'manifest.json'), 'utf8'),
  );
  const Body = await fs.readFile(path.join(OUT, 'links-mcp.zip'));
  const zipSha256 = createHash('sha256').update(Body).digest('hex');
  if (!KEY.test(manifest.key) || manifest.zipSha256 !== zipSha256)
    throw new Error(
      `${OUT}/links-mcp.zip does not match its manifest; run npm run mcp:package`,
    );
  const Key = manifest.key;
  // The bootstrap records the execution role once the links-mcp stack exists
  // and this role has its MCP actions; until then there is nothing to deploy
  // to, and the role could not read the stack anyway.
  if (!config.mcpExecutionRoleArn) {
    const message =
      'The links-mcp stack is not bootstrapped yet (infra/deployment.json has no mcpExecutionRoleArn); see docs/deployment.md';
    console.log(dryRun ? message : `::notice::${message}`);
    return;
  }

  const settings = { region: config.region, maxAttempts: 5 };
  const identity = await new STSClient(settings).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account !== config.account)
    throw new Error(`Unexpected AWS account ${identity.Account}`);
  const publication = dryRun
    ? null
    : await publicationContext(config, identity);
  const assertCurrentHead = async () => publication?.assertCurrent();

  const cfn = new CloudFormationClient(settings);
  let stack;
  try {
    ({
      Stacks: [stack],
    } = await cfn.send(new DescribeStacksCommand({ StackName })));
  } catch (error) {
    if (!/does not exist/.test(error.message)) throw error;
  }
  const parameter = (name) =>
    stack?.Parameters?.find((p) => p.ParameterKey === name)?.ParameterValue ||
    '';
  const live = parameter('CodeKey');
  const summary = {
    stack: StackName,
    status: stack?.StackStatus ?? 'absent',
    live: live || null,
    bundle: Key,
  };
  if (!stack || !live) {
    const message = `${StackName} has no revision yet; the bootstrap puts the first one in place (docs/deployment.md)`;
    console.log(JSON.stringify({ ...summary, action: 'none' }));
    if (!dryRun) console.log(`::notice::${message}`);
    else console.log(message);
    return;
  }
  if (live === Key) {
    console.log(JSON.stringify({ ...summary, action: 'unchanged' }));
    return;
  }
  if (!STABLE.includes(stack.StackStatus))
    throw new Error(
      `${StackName} is ${stack.StackStatus}; run the deploy again once it settles`,
    );
  if (dryRun) {
    console.log(JSON.stringify({ ...summary, action: 'deploy' }));
    return;
  }

  await assertCurrentHead();
  const put = await new S3Client(settings).send(
    new PutObjectCommand({
      Bucket,
      Key,
      Body,
      ContentType: 'application/zip',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: manifest.checksumSha256,
    }),
  );
  if (!put.VersionId)
    throw new Error(`${Bucket} gave no object version; is versioning on?`);
  if (put.ChecksumSHA256 && put.ChecksumSHA256 !== manifest.checksumSha256)
    throw new Error(`S3 reports another SHA-256 for ${Key}`);

  const ChangeSetName = `deploy-${publication.run}`;
  await cfn.send(
    new CreateChangeSetCommand({
      StackName,
      ChangeSetName,
      ChangeSetType: 'UPDATE',
      UsePreviousTemplate: true,
      Parameters: deployParameters(stack.Parameters, Key, put.VersionId),
      Capabilities: ['CAPABILITY_IAM'],
    }),
  );
  const discard = () =>
    cfn.send(new DeleteChangeSetCommand({ StackName, ChangeSetName }));
  try {
    await waitUntilChangeSetCreateComplete(
      { client: cfn, maxWaitTime: 300 },
      { StackName, ChangeSetName },
    );
  } catch (error) {
    const { StatusReason } = await cfn.send(
      new DescribeChangeSetCommand({ StackName, ChangeSetName }),
    );
    await discard();
    throw new Error(`${StackName}: ${StatusReason || error.message}`, {
      cause: error,
    });
  }
  const { Changes } = await cfn.send(
    new DescribeChangeSetCommand({ StackName, ChangeSetName }),
  );
  const problems = unexpectedChanges(Changes);
  if (problems.length) {
    await discard();
    throw new Error(
      `Refusing a change set that does more than swap the revision: ${problems.join('; ')}`,
    );
  }

  await assertCurrentHead();
  await cfn.send(new ExecuteChangeSetCommand({ StackName, ChangeSetName }));
  try {
    await waitUntilStackUpdateComplete(
      { client: cfn, maxWaitTime: 900, minDelay: 10 },
      { StackName },
    );
  } catch (error) {
    const { StackEvents } = await cfn.send(
      new DescribeStackEventsCommand({ StackName }),
    );
    const failed = StackEvents?.find((e) =>
      /FAILED$/.test(e.ResourceStatus || ''),
    );
    throw new Error(
      `${StackName} did not update` +
        (failed
          ? `: ${failed.LogicalResourceId} ${failed.ResourceStatus} ${failed.ResourceStatusReason}`
          : ''),
      { cause: error },
    );
  }

  // CloudFront serves the new revision once the endpoint has moved.
  const health = new URL('mcp/health', config.deliveryUrl);
  let reported = null;
  for (let attempt = 0; attempt < 36 && reported !== Key; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const response = await fetch(health, {
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) reported = (await response.json()).code ?? null;
    } catch {
      // Not answering yet; try again.
    }
  }
  if (reported !== Key)
    throw new Error(`${health} reports ${reported}, not ${Key}`);
  const response = await fetch(new URL('mcp', config.deliveryUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'links-deploy', version: '1' },
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const answer = response.ok ? await response.json() : null;
  if (answer?.result?.serverInfo?.name !== 'Linking Things')
    throw new Error(`initialize answered ${response.status}`);
  console.log(
    JSON.stringify({
      ...summary,
      action: 'deployed',
      version: put.VersionId,
      changeSet: ChangeSetName,
      serverVersion: answer.result.serverInfo.version,
    }),
  );
}
