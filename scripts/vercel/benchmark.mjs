#!/usr/bin/env node

import { randomBytes, createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import { join, posix, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import {
  TERMINAL_SESSION_STATES,
  boundedCall,
  verifySandboxDeleted,
} from './sandbox-cleanup.mjs';
import { deleteListedSnapshot } from './snapshot-cleanup.mjs';

export const DEFAULT_RUN_COUNT = 5;
export const DEFAULT_THRESHOLD_MS = 10_000;
export const STAGE_NAMES = Object.freeze([
  'command start',
  'Vercel create/resume',
  'source ready',
  'runtime secret sync',
  'display/auth ready',
  'port ready',
  'terminal ready',
  'background setup completion',
  'stop',
  'cleanup',
]);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STAGE_TIMEOUT_MS = 5 * 60 * 1000;
const NOVNC_PORT = 6080;
const NOVNC_INTERNAL_PORT = 6081;
const VCR_REFERENCE = /^vcr\.vercel\.com\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?@(sha256:[a-f0-9]{64})$/;
const COMMIT = /^[a-f0-9]{40}$/;
const execFile = promisify(execFileCallback);

/**
 * The live SDK calls are kept behind this object so the report and gate stay
 * runnable in tests without Vercel credentials or a network.
 */
export function createLiveAdapter() {
  return {
    createOrResume: (params) => Sandbox.getOrCreate(params),
    get: (params) => Sandbox.get(params),
    list: (params) => Sandbox.list(params).then((page) => page.toArray()),
    listSnapshots: (params) => Snapshot.list(params).then((page) => page.toArray()),
    getSnapshot: (params) => Snapshot.get(params),
    listSessions: (sandbox, params = {}) => sandbox.listSessions({ limit: 50, ...params }).then((page) => page.toArray()),
    runCommand: (sandbox, params) => sandbox.runCommand(params),
    writeFiles: (sandbox, files, params) => sandbox.writeFiles(files, params),
    stop: (sandbox, params) => sandbox.stop(params),
    delete: (sandbox, params) => sandbox.delete(params),
    domain: (sandbox, port) => sandbox.domain(port),
  };
}

/** Parse and validate a machine-readable benchmark artifact. */
export function parseReport(input) {
  const report = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isRecord(report) || !Array.isArray(report.runs)) {
    throw new TypeError('benchmark report must contain a runs array');
  }
  if (report.runs.length !== DEFAULT_RUN_COUNT) {
    throw new Error(`benchmark report must contain exactly ${DEFAULT_RUN_COUNT} run records`);
  }
  for (const [index, run] of report.runs.entries()) {
    if (!isRecord(run)) throw new TypeError(`benchmark run ${index + 1} is not an object`);
    if (run.failed !== true && (!Number.isFinite(run.commandToReadyMs) || run.commandToReadyMs < 0)) {
      throw new Error(`benchmark run ${index + 1} has no command-to-ready timing`);
    }
    if (!isRecord(run.timings) || STAGE_NAMES.some((name) => !isRecord(run.timings[name]))) {
      throw new Error(`benchmark run ${index + 1} is missing required stage timings`);
    }
    if (!isRecord(run.residualResources) || !['sandboxes', 'snapshots', 'sessions'].every((key) => Array.isArray(run.residualResources[key]))) {
      throw new Error(`benchmark run ${index + 1} has malformed residual-resource reporting`);
    }
  }
  return report;
}

/** Evaluate the release gate without making any live API calls. */
export function evaluateReport(report, thresholdMs = DEFAULT_THRESHOLD_MS) {
  const parsed = parseReport(report);
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new TypeError('threshold must be positive');

  const values = parsed.runs.map((run) => run.commandToReadyMs);
  const finiteValues = values.filter((value) => Number.isFinite(value));
  const medianCommandToReadyMs = finiteValues.length === 0 ? null : median(finiteValues);
  const residualResources = {
    sandboxes: parsed.runs.flatMap((run) => run.residualResources.sandboxes),
    snapshots: parsed.runs.flatMap((run) => run.residualResources.snapshots),
    sessions: parsed.runs.flatMap((run) => run.residualResources.sessions),
  };
  const outliers = parsed.runs
    .map((run, index) => ({
      index: index + 1,
      name: typeof run.name === 'string' ? run.name : undefined,
      commandToReadyMs: run.commandToReadyMs,
    }))
    .filter(({ commandToReadyMs }) => Number.isFinite(commandToReadyMs)
      && medianCommandToReadyMs !== null
      && (commandToReadyMs > medianCommandToReadyMs * 1.5
        || commandToReadyMs < medianCommandToReadyMs / 1.5));
  const reasons = [];
  if (parsed.runs.some((run) => run.failed === true || run.cleanRun !== true)) reasons.push('one or more runs failed');
  if (finiteValues.length !== parsed.runs.length) reasons.push('one or more runs have no command-to-ready timing');
  if (Object.values(residualResources).some((items) => items.length > 0)) reasons.push('residual resources remain');
  if (medianCommandToReadyMs !== null && medianCommandToReadyMs > thresholdMs) reasons.push(`median command-to-ready exceeds ${thresholdMs}ms`);

  return {
    passed: reasons.length === 0,
    reasons,
    thresholdMs,
    values,
    medianCommandToReadyMs,
    outliers,
    residualResources,
  };
}

/** Render a report without including command output or credential material. */
export function renderMarkdown(report, evaluation = evaluateReport(report)) {
  const lines = [
    '# Vercel benchmark',
    '',
    `- Gate: **${evaluation.passed ? 'PASS' : 'FAIL'}**`,
    `- Runs: ${report.runs.length}/${DEFAULT_RUN_COUNT}`,
    `- Median command-to-ready: ${evaluation.medianCommandToReadyMs}ms (threshold ${evaluation.thresholdMs}ms)`,
    `- Outliers: ${evaluation.outliers.length === 0 ? 'none' : evaluation.outliers.map((item) => `run ${item.index} (${item.commandToReadyMs}ms)`).join(', ')}`,
    `- Residual resources: ${countResiduals(evaluation.residualResources)}`,
    '',
    '## Environment and project plan',
    '',
    `- Provider: ${report.environmentPlan?.provider ?? 'Vercel'}`,
    `- Region: ${report.environmentPlan?.region ?? 'reported per run'}`,
    `- vCPU plan: ${report.environmentPlan?.vcpus ?? 'reported per run'}`,
    `- Image: ${report.environmentPlan?.imageReference ?? 'reported per run'}`,
    `- Image digest: ${report.environmentPlan?.imageDigest ?? 'reported per run'}`,
    `- Source commit: ${report.environmentPlan?.sourceCommit ?? 'reported per run'}`,
    `- Source branch: ${report.environmentPlan?.sourceBranch ?? 'reported per run'}`,
    `- Project scope: ${report.projectPlan?.scope ?? 'environment variables'}`,
    '',
    '## Run records',
    '',
    '| Run | Name | Ready (ms) | Clean | Residuals |',
    '| ---: | --- | ---: | :---: | ---: |',
  ];
  for (const [index, run] of report.runs.entries()) {
    lines.push(`| ${index + 1} | ${markdown(run.name ?? 'unknown')} | ${run.commandToReadyMs} | ${run.cleanRun === true ? 'yes' : 'no'} | ${countResiduals(run.residualResources)} |`);
  }
  lines.push('', '## Stage timings', '', '| Stage | ' + report.runs.map((_, index) => `Run ${index + 1}`).join(' | ') + ' |', '| --- | ' + report.runs.map(() => '---:').join(' | ') + ' |');
  for (const stage of STAGE_NAMES) {
    lines.push(`| ${stage} | ${report.runs.map((run) => formatDuration(run.timings[stage])).join(' | ')} |`);
  }
  if (evaluation.reasons.length > 0) lines.push('', '## Gate reasons', '', ...evaluation.reasons.map((reason) => `- ${reason}`));
  return `${lines.join('\n')}\n`;
}

export function createRunName(index, suffix = randomBytes(8).toString('hex')) {
  return `devbox-benchmark-${index}-${String(suffix).replace(/[^a-z0-9-]/gi, '').slice(0, 16)}`;
}

export function parseArgs(argv) {
  let outputDir;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (['--token', '--vercel-token', '--github-token'].includes(argument)) {
      throw new Error('credentials are environment-only; do not pass tokens on the command line');
    }
    if (argument === '--output-dir' || argument === '--report') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      outputDir = resolve(value);
      continue;
    }
    throw new Error(`unknown benchmark argument: ${argument}`);
  }
  return { outputDir: outputDir ?? resolve(process.env.VERCEL_BENCHMARK_OUTPUT_DIR ?? 'benchmark-results/vercel') };
}

export async function runBenchmark({ env = process.env, repoRoot = process.cwd(), outputDir, adapter = createLiveAdapter() } = {}) {
  const config = await loadConfig(env, repoRoot);
  const runs = [];
  for (let index = 1; index <= DEFAULT_RUN_COUNT; index += 1) {
    runs.push(await runOne(index, config, adapter));
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environmentPlan: {
      provider: 'vercel',
      region: 'reported per run',
      vcpus: config.vcpus,
      imageReference: config.image.reference,
      imageDigest: config.image.digest,
      sourceCommit: config.source.commit,
      sourceBranch: config.source.branch,
      repository: config.source.url,
      ports: config.ports,
      cleanRuns: DEFAULT_RUN_COUNT,
      readiness: 'terminal ready',
    },
    projectPlan: {
      scope: 'configured with VERCEL_TEAM_ID and VERCEL_PROJECT_ID',
      teamIdFingerprint: fingerprint(config.credentials.teamId),
      projectIdFingerprint: fingerprint(config.credentials.projectId),
      credentialSource: config.credentialSource,
    },
    runs,
  };
  const evaluation = evaluateReport(report);
  report.summary = evaluation;
  const paths = await writeArtifacts(report, evaluation, outputDir ?? env.VERCEL_BENCHMARK_OUTPUT_DIR ?? resolve('benchmark-results/vercel'));
  return { report, evaluation, ...paths };
}

async function runOne(index, config, adapter) {
  const name = createRunName(index);
  const run = {
    index,
    name,
    nameFingerprint: fingerprint(name),
    failed: false,
    cleanRun: false,
    commandToReadyMs: null,
    timings: createTimingMap(),
    environment: {
      vcpus: null,
      imageDigest: config.image.digest,
      sourceCommit: config.source.commit,
      region: null,
    },
    readiness: {},
    ports: [],
    residualResources: { sandboxes: [], snapshots: [], sessions: [] },
    cleanup: {
      stopped: false,
      deleted: false,
      terminalSessions: false,
      snapshotsCleaned: false,
      errors: [],
    },
  };
  let sandbox;
  const secrets = config.secrets;
  markPassed(run, 'command start', Date.now(), Date.now(), 0);
  try {
    sandbox = await timedStage(run, 'Vercel create/resume', (signal) => adapter.createOrResume({
      ...config.credentials,
      name,
      resources: { vcpus: config.vcpus },
      image: config.image.reference,
      source: {
        type: 'git',
        url: config.source.url,
        revision: config.source.commit,
        username: 'x-access-token',
        password: config.githubToken,
      },
      ports: config.ports,
      timeout: config.timeoutMs,
      persistent: false,
      tags: { 'devbox-benchmark': name },
      signal,
    }), config.stageTimeoutMs);
    run.environment.vcpus = numberOrNull(sandbox.vcpus);
    run.environment.region = stringOrNull(sandbox.region);
    run.environment.imageDigest = imageDigest(sandbox.image) ?? config.image.digest;

    const workspace = resolveWorkspace(sandbox.cwd, config.source.repository);
    await timedStage(run, 'source ready', async (signal) => {
      await assertCommand(adapter, sandbox, {
        cmd: 'git',
        args: ['switch', '--force-create', config.source.branch, '--'],
        cwd: workspace,
        signal,
      }, 'source branch setup');
      const head = await commandText(adapter, sandbox, { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: workspace, signal });
      const branch = await commandText(adapter, sandbox, { cmd: 'git', args: ['branch', '--show-current'], cwd: workspace, signal });
      if (head.trim() !== config.source.commit || branch.trim() !== config.source.branch) {
        throw new Error('source repository or branch does not match the benchmark plan');
      }
    }, config.stageTimeoutMs);

    const parallelController = new AbortController();
    const parallelStages = [
      timedStage(run, 'runtime secret sync', (signal) => syncRuntimeSecrets(adapter, sandbox, config, workspace, signal), config.stageTimeoutMs, parallelController.signal),
      timedStage(run, 'display/auth ready', (signal) => startDisplayAndProbe(adapter, sandbox, config, signal), config.stageTimeoutMs, parallelController.signal),
    ];
    for (const stage of parallelStages) {
      stage.catch((error) => parallelController.abort(error));
    }
    const settledStages = await Promise.allSettled(parallelStages);
    const failedStage = settledStages.find((result) => result.status === 'rejected');
    if (failedStage?.status === 'rejected') throw failedStage.reason;
    await timedStage(run, 'port ready', async () => {
      // Configured app ports may intentionally have no server yet. Their
      // domains must resolve safely; noVNC readiness is probed separately.
      run.ports = config.ports.map((port) => ({ port, domain: assertSafeDomain(adapter.domain(sandbox, port)) }));
    }, config.stageTimeoutMs);
    await timedStage(run, 'terminal ready', async (signal) => {
      await checkRuntimeReadiness(adapter, sandbox, workspace, signal);
      await runInteractiveTerminal(adapter, sandbox, workspace, `devbox-benchmark-ready-${index}`, signal, config.stageTimeoutMs);
      run.readiness = {
        interactiveShell: true,
        repository: true,
        branch: true,
        agents: ['pi', 'claude', 'codex', 'opencode'],
        runtimeAuth: true,
        authenticatedNoVnc: true,
        configuredPortDomains: true,
      };
    }, config.stageTimeoutMs);
    run.commandToReadyMs = run.timings['terminal ready'].finishedEpochMs - run.timings['command start'].startedEpochMs;
    await timedStage(run, 'background setup completion', (signal) => runBackgroundSetup(adapter, sandbox, workspace, signal, config.setupTimeoutMs), config.setupTimeoutMs);
  } catch (error) {
    run.failed = true;
    run.error = redactError(error, secrets);
  } finally {
    try {
      if (sandbox) {
        await timedStage(run, 'stop', async (signal) => {
      const before = await adapter.listSessions(sandbox, { signal });
      if (before.some((session) => !TERMINAL_SESSION_STATES.has(session.status))) await adapter.stop(sandbox, { signal });
      const after = await adapter.listSessions(sandbox, { signal });
      run.cleanup.sessionStates = after.map((session) => ({ id: session.id, status: session.status }));
      run.residualResources.sessions = after
        .filter((session) => !TERMINAL_SESSION_STATES.has(session.status))
        .map((session) => ({ id: session.id, status: session.status }));
          run.cleanup.terminalSessions = after.length > 0 && after.every((session) => TERMINAL_SESSION_STATES.has(session.status));
          if (!run.cleanup.terminalSessions) throw new Error('Sandbox sessions did not reach a terminal state');
          run.cleanup.stopped = true;
        }, config.cleanupTimeoutMs);
      } else {
        markSkipped(run, 'stop', 'sandbox was not created');
      }
    } catch (error) {
      run.failed = true;
      run.cleanup.errors.push(redactError(error, secrets));
    }
    try {
      await timedStage(run, 'cleanup', (signal) => cleanupResources(adapter, sandbox, name, config, run, signal), config.cleanupTimeoutMs);
    } catch (error) {
      run.failed = true;
      run.cleanup.errors.push(redactError(error, secrets));
    }
  }
  run.cleanRun = !run.failed
    && Number.isFinite(run.commandToReadyMs)
    && run.cleanup.stopped
    && run.cleanup.deleted
    && run.cleanup.terminalSessions
    && run.cleanup.snapshotsCleaned
    && run.cleanup.errors.length === 0
    && countResiduals(run.residualResources) === 0;
  return run;
}

async function loadConfig(env, repoRoot) {
  const missing = [];
  const token = firstValue(env.VERCEL_TOKEN, env.VERCEL_OIDC_TOKEN);
  const teamId = nonEmpty(env.VERCEL_TEAM_ID);
  const projectId = nonEmpty(env.VERCEL_PROJECT_ID);
  const githubToken = firstValue(env.GH_TOKEN, env.GITHUB_TOKEN);
  if (!token) missing.push('VERCEL_TOKEN or VERCEL_OIDC_TOKEN');
  if (!teamId) missing.push('VERCEL_TEAM_ID');
  if (!projectId) missing.push('VERCEL_PROJECT_ID');
  if (!githubToken) missing.push('GH_TOKEN or GITHUB_TOKEN');
  if (missing.length > 0) throw new Error(`benchmark credentials are incomplete; set: ${missing.join(', ')}`);

  const sourceUrl = normalizeGithubUrl(env.BENCHMARK_SOURCE_URL ?? await git(repoRoot, ['remote', 'get-url', 'origin']));
  const sourceCommit = (env.SOURCE_SHA ?? await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  if (!COMMIT.test(sourceCommit)) throw new Error('SOURCE_SHA must be a full lowercase 40-character commit SHA');
  const branch = (env.SOURCE_BRANCH ?? await git(repoRoot, ['branch', '--show-current'])).trim();
  if (!branch) throw new Error('SOURCE_BRANCH or a checked-out branch is required');
  const image = resolveImage(env);
  const envPath = env.DEVBOX_ENV ?? join(repoRoot, '.env');
  let envFile = '';
  try {
    envFile = await readFile(envPath, 'utf8');
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const ports = await resolvePorts(repoRoot);
  const secrets = collectSecrets([token, githubToken, envFile]);
  return {
    credentials: { token, teamId, projectId },
    credentialSource: env.VERCEL_TOKEN ? 'VERCEL_TOKEN' : 'VERCEL_OIDC_TOKEN',
    githubToken,
    secrets,
    image,
    source: { url: sourceUrl, repository: repositoryName(sourceUrl), commit: sourceCommit, branch },
    ports,
    envFile,
    timeoutMs: positiveNumber(env.VERCEL_BENCHMARK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    cleanupTimeoutMs: positiveNumber(env.VERCEL_BENCHMARK_CLEANUP_TIMEOUT_MS, DEFAULT_CLEANUP_TIMEOUT_MS),
    setupTimeoutMs: positiveNumber(env.VERCEL_BENCHMARK_SETUP_TIMEOUT_MS, DEFAULT_SETUP_TIMEOUT_MS),
    stageTimeoutMs: positiveNumber(env.VERCEL_BENCHMARK_STAGE_TIMEOUT_MS, DEFAULT_STAGE_TIMEOUT_MS),
    vcpus: positiveNumber(env.VERCEL_BENCHMARK_VCPUS, 2),
  };
}

function resolveImage(env) {
  // The pin is a build output rather than source, so the caller names the image.
  const reference = env.IMAGE_REF ?? env.VERCEL_IMAGE_REF ?? env.DEVBOX_VERCEL_IMAGE;
  if (!reference) {
    throw new Error('IMAGE_REF (or DEVBOX_VERCEL_IMAGE) must name the fully-qualified digest reference to benchmark');
  }
  return parseImage(reference);
}

function parseImage(reference) {
  const match = VCR_REFERENCE.exec(String(reference).trim());
  if (!match) throw new Error('IMAGE_REF must be a fully-qualified digest-pinned VCR reference');
  return { reference: String(reference).trim(), digest: match[1] };
}

async function syncRuntimeSecrets(adapter, sandbox, config, workspace, signal) {
  await assertCommand(adapter, sandbox, {
    cmd: 'mkdir',
    args: ['-p', '/vercel/.devbox/runtime'],
    signal,
  }, 'runtime directory creation');
  await adapter.writeFiles(sandbox, [
    { path: '/vercel/.env', content: Buffer.from(config.envFile), mode: 0o600 },
    { path: '/vercel/.devbox/runtime/github-token', content: Buffer.from(config.githubToken), mode: 0o600 },
  ], { signal });
  await assertCommand(adapter, sandbox, {
    cmd: 'sh',
    args: ['-c', 'gh auth login --hostname github.com --with-token < /vercel/.devbox/runtime/github-token && rm -f /vercel/.devbox/runtime/github-token && if [ ! -e .env ]; then ln -s /vercel/.env .env; fi'],
    cwd: workspace,
    signal,
  }, 'runtime GitHub authentication');
}

async function startDisplayAndProbe(adapter, sandbox, config, signal) {
  const password = randomBytes(24).toString('base64url');
  const started = await adapter.runCommand(sandbox, {
    cmd: '/usr/local/bin/devbox-start',
    env: {
      DEVBOX_NOVNC_PASSWORD: password,
      DEVBOX_NOVNC_PORT: String(NOVNC_PORT),
      DEVBOX_NOVNC_INTERNAL_PORT: String(NOVNC_INTERNAL_PORT),
    },
    detached: true,
    signal,
    timeoutMs: config.stageTimeoutMs,
  });
  await waitForCommand(started, signal);
  const status = await command(adapter, sandbox, {
    cmd: 'sh',
    args: ['-c', 'pgrep -x Xvfb >/dev/null && pgrep -x fluxbox >/dev/null && pgrep -x x11vnc >/dev/null && pgrep -f "[w]ebsockify" >/dev/null && pgrep -f "[n]ovnc-proxy.mjs" >/dev/null'],
    signal,
  });
  if (status.exitCode !== 0) {
    throw new Error('display services are not ready');
  }
  await probeAuthenticatedNoVnc(adapter.domain(sandbox, NOVNC_PORT), password, signal);
}

async function checkRuntimeReadiness(adapter, sandbox, workspace, signal) {
  await assertCommand(adapter, sandbox, {
    cmd: 'bash',
    args: ['-c', [
      'set -e',
      'pids=""',
      'for agent in pi claude codex opencode; do',
      '  "${agent}" --version >/dev/null 2>&1 & pids="${pids} $!"',
      'done',
      'for pid in ${pids}; do wait "${pid}"; done',
      'gh auth status --hostname github.com >/dev/null 2>&1',
      'test -e /vercel/.env',
      'test -n "$(git branch --show-current)"',
    ].join('\n')],
    cwd: workspace,
    signal,
  }, 'runtime readiness checks');
}

async function runInteractiveTerminal(adapter, sandbox, cwd, marker, signal, timeoutMs) {
  let terminalModule;
  try {
    terminalModule = await import('../../dist/providers/vercel/terminal.js');
  } catch {
    throw new Error('compiled dist/providers/vercel/terminal.js is required for the interactive terminal check');
  }
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  const terminal = terminalModule.createVercelTerminalAdapter();
  const attached = terminal.attach(sandbox, {
    streams: { stdin, stdout, stderr },
    cwd,
    tty: false,
    signal,
    signalSource: new EventEmitter(),
    timeoutExtension: false,
    getSize: () => ({ cols: 100, rows: 30 }),
    onError: () => true,
  });
  const ready = waitForOutput(stdout, marker, timeoutMs, signal, () => output.join(''));
  stdin.write(`printf '%s\\n' '${marker}'\n`);
  await ready;
  stdin.write(Buffer.from([0x1d]));
  const result = await boundedCall(() => attached, 'interactive terminal', { signal, timeoutMs });
  if (result.status !== 'detached' || result.reason !== 'escape') {
    throw new Error('interactive terminal did not detach cleanly');
  }
}

async function runBackgroundSetup(adapter, sandbox, workspace, signal, timeoutMs) {
  const statusPath = '/vercel/.devbox/benchmark-setup.status';
  const scriptPath = '/vercel/.devbox/benchmark-setup.sh';
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    `status=${shellQuote(statusPath)}`,
    'mkdir -p "$(dirname "${status}")"',
    'printf "running\\n" > "${status}"',
    'failed=0',
    'if [ -f package-lock.json ] && [ ! -f node_modules/.package-lock.json ]; then npm ci || failed=1; fi',
    'if [ -x .devbox/post-create.sh ]; then bash .devbox/post-create.sh || failed=1; fi',
    'if [ "${failed}" -eq 0 ]; then printf "succeeded\\n" > "${status}"; else printf "failed\\n" > "${status}"; fi',
  ].join('\n');
  await adapter.writeFiles(sandbox, [{ path: scriptPath, content: Buffer.from(script), mode: 0o700 }], { signal });
  const started = await adapter.runCommand(sandbox, {
    cmd: 'bash',
    args: [scriptPath],
    cwd: workspace,
    detached: true,
    signal,
  });
  await waitForCommand(started, signal);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await command(adapter, sandbox, { cmd: 'cat', args: [statusPath], signal });
    const status = result.stdout.trim();
    if (status === 'succeeded') return;
    if (status === 'failed') throw new Error('background setup failed');
    await sleep(250, undefined);
  }
  throw new Error('background setup timed out');
}

async function cleanupResources(adapter, sandbox, name, config, run, signal) {
  try {
    const snapshots = await adapter.listSnapshots({ ...config.credentials, name, signal });
    for (const snapshot of snapshots.filter((item) => item.status !== 'deleted')) {
      try {
        await deleteListedSnapshot({
          snapshot,
          signal,
          timeoutMs: config.stageTimeoutMs,
          getSnapshot: async (snapshotId, requestSignal) => adapter.getSnapshot({ ...config.credentials, snapshotId, signal: requestSignal }),
        });
      } catch (error) {
        run.cleanup.errors.push(redactError(error, config.secrets));
      }
    }
  } catch (error) {
    run.cleanup.errors.push(redactError(error, config.secrets));
  }
  let afterSnapshots;
  try {
    afterSnapshots = await adapter.listSnapshots({ ...config.credentials, name, signal });
  } catch (error) {
    run.cleanup.errors.push(redactError(error, config.secrets));
    afterSnapshots = [{ id: 'listing-unavailable', status: 'unknown' }];
  }
  run.residualResources.snapshots = afterSnapshots
    .filter((snapshot) => snapshot.status !== 'deleted')
    .map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
  run.cleanup.snapshotsCleaned = run.residualResources.snapshots.length === 0;

  if (sandbox) {
    try {
      await adapter.delete(sandbox, { signal });
      run.cleanup.deleted = true;
    } catch (error) {
      run.cleanup.errors.push(redactError(error, config.secrets));
    }
    const verification = await verifySandboxDeleted({
      getSandbox: (options) => adapter.get({ ...config.credentials, name, ...options }),
      listSessions: (target, options) => adapter.listSessions(target, options),
      stopSandbox: (target, options) => adapter.stop(target, options),
      deleteSandbox: (target, options) => adapter.delete(target, options),
      isNotFound,
      timeoutMs: config.cleanupTimeoutMs,
      operationTimeoutMs: config.stageTimeoutMs,
      maxAttempts: 3,
      backoffMs: 250,
      signal,
      sleep: (duration, requestSignal) => sleep(duration, undefined).then(() => {
        if (requestSignal?.aborted) throw requestSignal.reason;
      }),
    });
    run.cleanup.deleted ||= verification.verified;
    if (!verification.verified || !verification.noRunningSession) {
      run.cleanup.errors.push('Sandbox deletion or no-running-session verification failed');
    }
  }
  let residualSandboxes;
  try {
    residualSandboxes = await adapter.list({
      ...config.credentials,
      namePrefix: name,
      sortBy: 'name',
      limit: 50,
      signal,
    });
  } catch (error) {
    run.cleanup.errors.push(redactError(error, config.secrets));
    residualSandboxes = [{ name, status: 'listing-unavailable' }];
  }
  run.residualResources.sandboxes = residualSandboxes
    .filter((item) => item.name === name)
    .map((item) => ({ name: item.name, status: item.status }));
  if (run.residualResources.sandboxes.length > 0) run.cleanup.deleted = false;
  if (run.residualResources.snapshots.length > 0) run.cleanup.snapshotsCleaned = false;
  if (run.cleanup.errors.length > 0) throw new Error('cleanup did not converge');
}

async function timedStage(run, stage, operation, timeoutMs, externalSignal) {
  const startedEpochMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${stage} timed out`)), timeoutMs);
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal.reason ?? new Error(`${stage} cancelled`));
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timing = run.timings[stage];
  timing.startedEpochMs = startedEpochMs;
  timing.startedAt = new Date(startedEpochMs).toISOString();
  try {
    const value = await operation(controller.signal);
    markPassed(run, stage, startedEpochMs, Date.now(), Date.now() - startedEpochMs);
    return value;
  } catch (error) {
    const finishedEpochMs = Date.now();
    timing.finishedEpochMs = finishedEpochMs;
    timing.finishedAt = new Date(finishedEpochMs).toISOString();
    timing.durationMs = finishedEpochMs - startedEpochMs;
    timing.outcome = 'failed';
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function command(adapter, sandbox, params) {
  const result = await adapter.runCommand(sandbox, params);
  const finished = await waitForCommand(result, params.signal);
  return {
    exitCode: finished.exitCode ?? -1,
    stdout: await commandOutput(finished, params.signal),
  };
}

async function commandText(adapter, sandbox, params) {
  const result = await command(adapter, sandbox, params);
  if (result.exitCode !== 0) throw new Error('sandbox command failed');
  return result.stdout;
}

async function assertCommand(adapter, sandbox, params, label) {
  const result = await command(adapter, sandbox, params);
  if (result.exitCode !== 0) throw new Error(`${label} failed`);
  return result;
}

async function waitForCommand(result, signal) {
  if (typeof result?.wait === 'function') return result.wait(signal ? { signal } : undefined);
  return result;
}

async function commandOutput(result, signal) {
  const stdout = typeof result?.stdout === 'function' ? await result.stdout(signal ? { signal } : undefined) : '';
  const stderr = typeof result?.stderr === 'function' ? await result.stderr(signal ? { signal } : undefined) : '';
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

function waitForOutput(stream, marker, timeoutMs, signal, currentOutput) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    let output = '';
    const cleanup = () => {
      stream.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolvePromise(output);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) finish();
    };
    const onAbort = () => finish(signal.reason ?? new Error('terminal output wait aborted'));
    stream.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error(`terminal output did not contain ${marker}`)), timeoutMs);
    output = currentOutput();
    if (output.includes(marker)) finish();
  });
}

async function probeAuthenticatedNoVnc(domain, password, signal) {
  const cookie = `devbox_novnc=${encodeURIComponent(password)}`;
  const paired = await fetch(new URL('/vnc.html?autoconnect=1', domain), {
    headers: { cookie },
    signal,
  });
  if (paired.status !== 200) throw new Error('noVNC paired HTTP probe failed');
  const status = await probeWebSocket(domain, cookie, signal);
  if (!status.includes('101')) throw new Error('noVNC paired WebSocket probe failed');
}

function probeWebSocket(domain, cookie, signal, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL('/websockify', domain);
    const secure = target.protocol === 'https:';
    const socket = secure
      ? tls.connect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname })
      : net.connect(Number(target.port || 80), target.hostname);
    const key = randomBytes(16).toString('base64');
    let response = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error); else resolvePromise(value);
    };
    const onAbort = () => finish(signal?.reason ?? new Error('WebSocket probe aborted'));
    socket.setTimeout(timeoutMs, () => finish(new Error('WebSocket probe timed out')));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', (error) => finish(error));
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write([
      'GET /websockify HTTP/1.1',
      `Host: ${target.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '\r\n',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.includes('\r\n\r\n')) finish(undefined, response.split('\r\n', 1)[0]);
    });
  });
}

async function writeArtifacts(report, evaluation, outputDir) {
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const jsonPath = join(directory, 'vercel-benchmark.json');
  const markdownPath = join(directory, 'vercel-benchmark.md');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(markdownPath, renderMarkdown(report, evaluation), { mode: 0o600 });
  return { jsonPath, markdownPath };
}

function createTimingMap() {
  return Object.fromEntries(STAGE_NAMES.map((name) => [name, { outcome: 'not_run', durationMs: null }]));
}

function markPassed(run, stage, startedEpochMs, finishedEpochMs, durationMs) {
  run.timings[stage] = {
    startedEpochMs,
    finishedEpochMs,
    startedAt: new Date(startedEpochMs).toISOString(),
    finishedAt: new Date(finishedEpochMs).toISOString(),
    durationMs,
    outcome: 'passed',
  };
}

function markSkipped(run, stage, reason) {
  run.timings[stage] = { outcome: 'not_required', durationMs: 0, reason };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function countResiduals(resources) {
  return Object.values(resources ?? {}).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
}

function formatDuration(timing) {
  return timing?.durationMs === null || timing?.durationMs === undefined ? 'not run' : `${timing.durationMs}ms`;
}

function markdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function git(cwd, args) {
  const result = await execFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function resolvePorts(repoRoot) {
  let source;
  try {
    source = await readFile(join(repoRoot, '.devcontainer', 'devcontainer.json'), 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [NOVNC_PORT];
    throw error;
  }
  const json = JSON.parse(stripJsonc(source));
  const values = Array.isArray(json.forwardPorts) ? json.forwardPorts : [];
  const ports = [...new Set(values.map((value) => normalizePort(value)))];
  if (!ports.includes(NOVNC_PORT)) ports.push(NOVNC_PORT);
  return ports.sort((left, right) => left - right);
}

function normalizePort(value) {
  const text = String(value);
  const port = text.includes(':') ? text.split(':').at(-1) : text;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) throw new Error(`invalid configured port ${text}`);
  if (Number(port) === 5900 || Number(port) === NOVNC_INTERNAL_PORT) throw new Error(`private display port ${port} cannot be configured`);
  return Number(port);
}

function stripJsonc(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

function normalizeGithubUrl(value) {
  const text = String(value).trim();
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(text);
  const parsed = scp ? null : new URL(text);
  if (parsed && (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash)) {
    throw new Error('BENCHMARK_SOURCE_URL must be a credential-free GitHub HTTPS URL');
  }
  const owner = scp?.[1] ?? parsed?.pathname.split('/').filter(Boolean)[0];
  const repository = scp?.[2] ?? parsed?.pathname.split('/').filter(Boolean)[1]?.replace(/\.git$/, '');
  if (!owner || !repository || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('benchmark source must identify a GitHub owner and repository');
  return `https://github.com/${owner}/${repository}.git`;
}

function repositoryName(url) {
  return new URL(url).pathname.split('/').filter(Boolean).at(-1).replace(/\.git$/, '');
}

function resolveWorkspace(cwd, repository) {
  const base = cwd?.trim() || '/vercel/sandbox';
  return posix.join(base, repository);
}

function imageDigest(image) {
  return typeof image === 'string' ? image.match(/@(sha256:[a-f0-9]{64})$/)?.[1] : undefined;
}

function assertSafeDomain(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('Vercel did not return a valid port domain');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Vercel returned an unsafe port domain');
  }
  return parsed.toString();
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function collectSecrets(values) {
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    return [value, ...value.split(/\r?\n/).flatMap((line) => line.includes('=') ? [line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')] : [])];
  }).filter((value) => value.length >= 4))];
}

function redactError(error, secrets) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  return message
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret)[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function isNotFound(error) {
  const status = error?.response?.status ?? error?.status;
  return status === 404 || status === 410 || error?.notFound === true;
}

function positiveNumber(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('benchmark timeout values must be positive');
  return Math.ceil(number);
}

function firstValue(...values) {
  return values.map(nonEmpty).find(Boolean);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isNodeError(error, code) {
  return isRecord(error) && error.code === code;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function help() {
  return `Usage: node scripts/vercel/benchmark.mjs [--help] [--output-dir PATH|--report PATH]\n\nRuns exactly five clean Vercel Sandbox launches, records stage timings, writes JSON and Markdown artifacts, and exits nonzero when a run, cleanup, residual-resource, or 10-second median gate fails.\n\nCredentials are environment-only: VERCEL_TOKEN (or VERCEL_OIDC_TOKEN), VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and GH_TOKEN (or GITHUB_TOKEN).\nOptional environment: IMAGE_REF, SOURCE_SHA, SOURCE_BRANCH, DEVBOX_ENV, VERCEL_BENCHMARK_OUTPUT_DIR.\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  const result = await runBenchmark({ outputDir: options.outputDir });
  process.stdout.write(`Vercel benchmark ${result.evaluation.passed ? 'passed' : 'failed'}; median command-to-ready ${result.evaluation.medianCommandToReadyMs}ms\nJSON: ${result.jsonPath}\nMarkdown: ${result.markdownPath}\n`);
  if (!result.evaluation.passed) {
    process.stderr.write(`${result.evaluation.reasons.join('; ')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactError(error, collectSecrets([process.env.VERCEL_TOKEN, process.env.VERCEL_OIDC_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]))}\n`);
    process.exitCode = 1;
  });
}
