import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const DEFAULT_RUN_BRANCH_TAG_PREFIX = 'uat-devbox-session-';

export async function loadCleanupDependencies(importer = (specifier) => import(specifier)) {
  const [clientModule, cleanupModule, identityModule] = await Promise.all([
    importer('../../dist/providers/vercel/client.js'),
    importer('../../dist/providers/vercel/cleanup.js'),
    importer('../../dist/providers/vercel/identity.js'),
  ]);
  const client = clientModule.createVercelSandboxClient();
  return {
    client,
    cleanup: cleanupModule.cleanupVercelSandbox,
    adapter: cleanupModule.createVercelCleanupAdapter(client),
    identity: identityModule.createVercelIdentity,
  };
}

export function parseWorkflowRunTag(branchTag, prefix = DEFAULT_RUN_BRANCH_TAG_PREFIX) {
  const normalizedTag = branchTag.replace(/-[a-f0-9]{16}$/, '');
  const match = new RegExp(`^${prefix}(\\d+)-(\\d+)$`).exec(normalizedTag);
  if (!match) return undefined;
  return { runId: match[1], runAttempt: Number(match[2]) };
}

export function workflowRunCacheKey(runId, runAttempt) {
  return `${runId}:${runAttempt}`;
}

export function createWorkflowRunEligibility({
  repository,
  token,
  fetcher = globalThis.fetch,
  prefix = DEFAULT_RUN_BRANCH_TAG_PREFIX,
}) {
  const states = new Map();
  return async function completedWorkflowRun(branchTag) {
    const parsed = parseWorkflowRunTag(branchTag, prefix);
    if (!parsed || !repository) return false;
    const cacheKey = workflowRunCacheKey(parsed.runId, parsed.runAttempt);
    const cached = states.get(cacheKey);
    if (cached !== undefined) return cached;
    let completed = false;
    try {
      const response = await fetcher(`https://api.github.com/repos/${repository}/actions/runs/${parsed.runId}/attempts/${parsed.runAttempt}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const run = await response.json();
        completed = run?.status === 'completed' && Number(run?.run_attempt) === parsed.runAttempt;
      }
    } catch {
      completed = false;
    }
    states.set(cacheKey, completed);
    return completed;
  };
}

export async function selectRunTaggedSandboxes(records, identity, completedWorkflowRun, prefix = DEFAULT_RUN_BRANCH_TAG_PREFIX) {
  const candidates = records.filter((record) => record.tags?.provider === 'vercel'
    && record.tags.repository === identity.tags.repository
    && typeof record.tags.branch === 'string'
    && record.tags.branch.startsWith(prefix));
  const eligible = [];
  for (const record of candidates) {
    if (record.tags.branch === identity.tags.branch || await completedWorkflowRun(record.tags.branch)) {
      eligible.push(record);
    }
  }
  return eligible;
}

export async function waitForEmptyResourceInventory(readInventory, {
  timeoutMs,
  pollMs,
  sleep,
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  let lastInventory = { sandboxCount: -1, snapshotCount: -1 };
  let lastError;
  while (now() < deadline) {
    try {
      lastInventory = await readInventory();
      if (lastInventory.sandboxCount === 0 && lastInventory.snapshotCount === 0) return lastInventory;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
  if (lastError) throw new Error('Vercel cleanup inventory probe did not converge');
  throw new Error(`Vercel cleanup inventory did not converge: sandboxes=${lastInventory.sandboxCount}; snapshots=${lastInventory.snapshotCount}`);
}

export function createSessionUatCleanup({
  branch,
  repoRoot,
  credentials,
  configuredRepository,
  workflowRepository,
  workflowToken,
  fetcher = globalThis.fetch,
  cliTimeoutMs,
  stopTimeoutMs,
  pollMs,
  runBranchTagPrefix = DEFAULT_RUN_BRANCH_TAG_PREFIX,
  redact,
  sleep = defaultSleep,
  importer,
}) {
  let dependenciesPromise;
  const completedWorkflowRun = createWorkflowRunEligibility({
    repository: workflowRepository,
    token: workflowToken,
    fetcher,
    prefix: runBranchTagPrefix,
  });

  async function dependencies() {
    if (!dependenciesPromise) dependenciesPromise = loadCleanupDependencies(importer);
    return dependenciesPromise;
  }

  async function cleanupIdentity() {
    let remote = configuredRepository?.trim();
    if (!remote) {
      const result = await execFile('git', ['remote', 'get-url', 'origin'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: cliTimeoutMs,
      });
      remote = result.stdout.trim();
    } else if (!remote.includes('://') && !remote.startsWith('git@') && !remote.startsWith('ssh://')) {
      remote = `github.com/${remote.replace(/^\/+|\/+$/g, '')}`;
    }
    const { identity } = await dependencies();
    return identity({
      remote,
      branch,
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
  }

  async function readResourceInventory() {
    const { client } = await dependencies();
    const identity = await cleanupIdentity();
    const sandboxes = await client.listSandboxes({
      credentials,
      namePrefix: identity.name,
      tags: identity.tags,
    });
    let snapshotCount = 0;
    for (const name of new Set(sandboxes.map((sandbox) => sandbox.name).concat(identity.name))) {
      try {
        snapshotCount += (await client.listSnapshots({ credentials, name }))
          .filter((snapshot) => snapshot.status !== 'deleted').length;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return { sandboxCount: sandboxes.length, snapshotCount };
  }

  async function readRunTaggedResourceInventory(identity, knownNames) {
    const { client } = await dependencies();
    const records = await listRunTaggedSandboxes(identity);
    const names = new Set([...knownNames, ...records.map((record) => record.name)]);
    let snapshotCount = 0;
    for (const name of names) {
      let snapshots;
      try {
        snapshots = await client.listSnapshots({ credentials, name });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      snapshotCount += snapshots.filter((snapshot) => snapshot.status !== 'deleted').length;
    }
    return { sandboxCount: records.length, snapshotCount };
  }

  async function waitForRunTaggedEmpty(identity, knownNames, timeoutMs) {
    return waitForEmptyResourceInventory(
      () => readRunTaggedResourceInventory(identity, knownNames),
      { timeoutMs, pollMs, sleep },
    );
  }

  async function waitForEmpty(timeoutMs) {
    return waitForEmptyResourceInventory(readResourceInventory, { timeoutMs, pollMs, sleep });
  }

  async function listRunTaggedSandboxes(identity) {
    const { client } = await dependencies();
    const records = await client.listSandboxes({
      credentials,
      tags: { provider: 'vercel', repository: identity.tags.repository },
    });
    return selectRunTaggedSandboxes(records, identity, completedWorkflowRun, runBranchTagPrefix);
  }

  async function removeRunTaggedLeftovers() {
    const { cleanup, adapter } = await dependencies();
    const identity = await cleanupIdentity();
    const records = await listRunTaggedSandboxes(identity);
    const targets = new Map(records.map((record) => [record.name, record]));
    if (identity.name !== undefined && !targets.has(identity.name)) {
      targets.set(identity.name, { name: identity.name, tags: identity.tags });
    }
    const knownNames = new Set(targets.keys());
    let removedCount = 0;
    let residualCount = 0;
    for (const record of targets.values()) {
      const expectedTags = cleanupTags(record.tags);
      if (!expectedTags) {
        residualCount += 1;
        continue;
      }
      try {
        const result = await cleanup({
          name: record.name,
          credentials,
          expectedTags,
          ...(record.currentSnapshotId === undefined ? {} : { knownSnapshotIds: [record.currentSnapshotId] }),
          adapter,
          timeoutMs: stopTimeoutMs,
          maxAttempts: 8,
        });
        if (result.verified && result.errors.length === 0) removedCount += 1;
        else residualCount += 1;
      } catch {
        residualCount += 1;
      }
    }
    const inventory = await waitForRunTaggedEmpty(identity, knownNames, stopTimeoutMs);
    return {
      accepted: residualCount === 0 && inventory.sandboxCount === 0 && inventory.snapshotCount === 0,
      removedCount,
      residualCount,
      inventory,
    };
  }

  async function runCleanup(runCliCleanup) {
    let command;
    try {
      command = await runCliCleanup();
    } catch {
      command = { exitCode: null, output: '' };
    }
    const output = command.output ?? '';
    const commandAccepted = command.exitCode !== null
      && (command.exitCode === 0 || /No Vercel sandbox|No matching Vercel sandbox|nothing to remove/i.test(output));
    let runTagged;
    let runTaggedError;
    try {
      runTagged = await removeRunTaggedLeftovers();
    } catch {
      runTaggedError = 'run-tagged provider cleanup did not converge';
    }
    let inventory;
    let inventoryError;
    try {
      inventory = await waitForEmpty(stopTimeoutMs);
    } catch (error) {
      inventoryError = redact(error instanceof Error ? error.message : String(error));
    }
    const accepted = commandAccepted
      && runTagged?.accepted === true
      && inventory?.sandboxCount === 0
      && inventory.snapshotCount === 0;
    return {
      attempted: true,
      exitCode: command.exitCode,
      accepted,
      commandAccepted,
      ...(commandAccepted ? {} : { commandError: 'CLI cleanup did not complete successfully' }),
      ...(runTagged === undefined ? {} : { runTagged }),
      ...(runTaggedError === undefined ? {} : { runTaggedError }),
      ...(inventory === undefined ? {} : { inventory }),
      ...(inventoryError === undefined ? {} : { inventoryError }),
    };
  }

  return {
    runCleanup,
  };
}

export function cleanupTags(tags) {
  const keys = ['provider', 'repository', 'branch', 'version', 'identity'];
  if (!tags || keys.some((key) => typeof tags[key] !== 'string' || tags[key].length === 0)) return undefined;
  return Object.fromEntries(keys.map((key) => [key, tags[key]]));
}

function isNotFound(error) {
  return error?.status === 404 || error?.response?.status === 404 || error?.notFound === true;
}

function defaultSleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
