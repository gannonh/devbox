/**
 * devbox up — create/boot a box for a branch.
 *
 * Port of cmd_up from devbox.sh. Flow:
 *   1. If a running box exists for the branch: attach (exec in).
 *   2. If a stopped box exists: start it, re-bring display up, attach.
 *   3. Fresh box: create worktree, run devcontainer up, persist GH_TOKEN,
 *      print ready banner, exec into shell.
 */
import type { LauncherContext } from './context.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { containerFor, containerForAll, containerName } from './docker.js';
import { branchToPath, resolveWorktreesDir, createWorktree, defaultBranch, ensureWorktreeConfig, resolveWorktreeStartPoint } from './worktree.js';
import { readEnvironmentFile, resolveGhToken } from './env.js';
import { hyperlink } from '../../lib/display.js';
import { info, warn } from '../../lib/log.js';
import { localFailure } from './errors.js';
import { commandExistsWithRunner, escapeShellSingleQuote } from '../../lib/shell.js';
import { existsSync } from 'node:fs';

const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';
const LOCAL_RUNTIME_ENV_PATH = '/home/node/.devbox/runtime/environment.sh';

export async function up(ctx: LauncherContext, branch: string): Promise<number> {
  const { repoRoot, repoName, runner, env, tty, stderr } = ctx;
  const runtimeEnvironment = await requestedEnvironment(ctx);

  // Prerequisite checks (bash: require_cmd).
  const dockerOk = await commandExistsWithRunner(runner, 'docker');
  if (!dockerOk) localFailure('required command not found: docker (Docker / OrbStack)');
  const devcontainerOk = await commandExistsWithRunner(runner, 'devcontainer');
  if (!devcontainerOk) localFailure('required command not found: devcontainer (npm i -g @devcontainers/cli)');

  const worktreesDir = resolveWorktreesDir(repoRoot, env);
  const path = branchToPath(worktreesDir, repoName, branch);

  // 1. Re-enter a running box.
  let cid = await containerFor(runner, branch);
  if (cid) {
    info(`attaching to running box for ${branch}`);
    if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, cid, runtimeEnvironment);
    return execIntoShell(runner, cid, tty);
  }

  // 2. Start a stopped box.
  cid = await containerForAll(runner, branch);
  if (cid) {
    info(`starting stopped box for ${branch}`);
    await runner.exec('docker', ['start', cid], {});
    // Re-bring the display stack up. setsid so it survives this exec session.
    const displayResult = await runner.execQuiet(
      'docker',
      ['exec', '-u', 'node', cid, 'bash', '-lc', 'setsid bash -c /usr/local/bin/devbox-start-display </dev/null >/tmp/devbox-display.log 2>&1 || true'],
      {},
    );
    if (displayResult.code !== 0) {
      warn('display stack restart may have failed');
    }
    await sleep(2000);
    if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, cid, runtimeEnvironment);
    return execIntoShell(runner, cid, tty);
  }

  // 3. Fresh box: create the worktree.
  if (!existsSync(path)) {
    // Fetch latest default branch (best-effort, don't fail if offline).
    const base = await defaultBranch(runner, repoRoot);
    const fetchResult = await runner.execQuiet('git', ['fetch', 'origin', base], { cwd: repoRoot, silentStderr: true });
    const start = await resolveWorktreeStartPoint(runner, repoRoot, env, {
      fetched: fetchResult.code === 0,
    });
    if (start.warning) warn(start.warning);
    info(`creating worktree ${branch} from ${start.ref} -> ${path}`);
    await createWorktree(runner, { repoRoot, path, branch, startPoint: start.ref });
  } else {
    info(`worktree exists at ${path}, reusing`);
  }

  // git worktree add only checks out committed files. After `init`, .devbox/
  // and .devcontainer/ are still untracked, so copy them in if missing.
  const configStatus = await ensureWorktreeConfig(repoRoot, path);
  if (configStatus.status === 'missing') localFailure(configStatus.message);
  if (configStatus.status === 'copied') {
    warn(
      'copied uncommitted .devbox/ and .devcontainer/ into the worktree; commit them so new worktrees pick them up automatically',
    );
  }

  // GitHub token forwarding.
  const ghToken = await resolveGhToken(env, runner, () => commandExistsWithRunner(runner, 'gh'));
  const ghEnvArgs: string[] = [];
  if (ghToken && runtimeEnvironment.GH_TOKEN === undefined && runtimeEnvironment.GITHUB_TOKEN === undefined) {
    // Escape for shell safety: devcontainer CLI passes through to container env.
    // Use the same escaping as profile.d injection.
    ghEnvArgs.push('--remote-env', `GH_TOKEN=${escapeShellSingleQuote(ghToken)}`);
    info('forwarding GitHub token from host gh');
  } else if (!ghToken) {
    warn('no GitHub token (host gh not authed); gh/git push will need "gh auth login" in the box');
  }

  // devcontainer up.
  info('building + starting dev container (first run pulls base + provisions; takes a few min)');
  const devcontainerArgs = [
    'up',
    '--workspace-folder', path,
    '--id-label', `devbox.branch=${branch}`,
    '--id-label', `devbox.repo=${repoName}`,
    '--mount', `type=bind,source=${repoRoot}/.git,target=/${repoName}/.git`,
    ...ghEnvArgs,
  ];
  const devcontainerEnv = { ...env } as Record<string, string>;
  let secretsDirectory: string | undefined;
  try {
    if (Object.keys(runtimeEnvironment).length > 0) {
      secretsDirectory = await mkdtemp(join(tmpdir(), 'devbox-env-'));
      const secretsPath = join(secretsDirectory, 'values.json');
      await writeFile(secretsPath, JSON.stringify(runtimeEnvironment), { mode: 0o600 });
      devcontainerArgs.push('--secrets-file', secretsPath);
    }
    const result = await runner.execQuiet('devcontainer', devcontainerArgs, {
      env: devcontainerEnv,
      stderr,
      streamStdoutTo: { stream: stderr, prefix: '[devcontainer] ' },
    });
    // devcontainer up streams output; we don't parse it for the cid.
    if (result.code !== 0) {
      localFailure('devcontainer up failed; check output above');
    }
  } finally {
    if (secretsDirectory) await rm(secretsDirectory, { recursive: true, force: true });
  }

  // Look up the container by label (not CLI text parsing).
  cid = await containerFor(runner, branch);
  if (!cid) localFailure("container did not come up; check 'devcontainer up' output above");

  if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, cid, runtimeEnvironment);

  // Persist GH_TOKEN so every shell is authed.
  if (ghToken) {
    const tokenScript = `if [[ -z "\${GH_TOKEN+x}" && -z "\${GITHUB_TOKEN+x}" ]]; then export GH_TOKEN=${escapeShellSingleQuote(ghToken)}; fi\n`;
    await runner.execQuiet(
      'docker',
      ['exec', '-i', '-u', 'root', cid, 'bash', '-c', 'cat > /etc/profile.d/gh-token.sh && chown node:node /etc/profile.d/gh-token.sh && chmod 600 /etc/profile.d/gh-token.sh'],
      { stdin: tokenScript },
    );
  }

  // Ready banner.
  const cname = await containerName(runner, cid);
  const host = `${cname}.orb.local`;
  const novnc = `http://${host}:6080/vnc.html`;
  const vite = `http://${host}:5173`;

  stderr.write(`\n${CYAN}━━━ devbox ready ━━━${NC}\n`);
  stderr.write(`  branch:     ${branch}\n`);
  stderr.write(`  worktree:   ${path}\n`);
  stderr.write(`  Pi:         pi            (config + extensions copied from your ~/.pi)\n`);
  stderr.write(`  Electron:   bun run electron:dev\n`);
  stderr.write(`  noVNC:      ${hyperlink(novnc, novnc)}\n`);
  stderr.write(`  Vite:       ${hyperlink(vite, vite)}    (when running)\n`);
  stderr.write(`  Re-enter:   npx @gannonh/devbox ${branch} --attach\n`);
  stderr.write(`  URL/open:   npx @gannonh/devbox ${branch} --url   (add --open to launch a browser)\n`);
  stderr.write(`  Stop:       npx @gannonh/devbox ${branch} --stop\n`);
  stderr.write(`  Remove:     npx @gannonh/devbox ${branch} --rm\n\n`);

  return execIntoShell(runner, cid, tty);
}

/**
 * Exec into the container's shell. Uses spawn with inherited stdio so the
 * user gets an interactive shell. Signal forwarding is handled by spawnInherit.
 */
export function execIntoShell(runner: import('../../lib/shell.js').ShellRunner, cid: string, tty: boolean): Promise<number> {
  const ttyFlag = tty ? '-it' : '-i';
  // Split ttyFlag for docker exec: -it -> ['-it'], but docker accepts it as one arg.
  return runner.spawnInherit(
    'docker',
    [
      'exec', ttyFlag, '-w', '/workspace', '-u', 'node', cid, 'bash', '-lc',
      `if [ -r ${LOCAL_RUNTIME_ENV_PATH} ]; then . ${LOCAL_RUNTIME_ENV_PATH}; fi; exec bash -l`,
    ],
    {},
  );
}

export async function requestedEnvironment(ctx: LauncherContext): Promise<Record<string, string>> {
  if (ctx.runtimeEnvironment !== undefined) return ctx.runtimeEnvironment;
  if (ctx.envPath !== undefined) return readEnvironmentFile(ctx.envPath);
  return {};
}

export async function syncLocalEnvironment(
  runner: import('../../lib/shell.js').ShellRunner,
  cid: string,
  values: Record<string, string>,
): Promise<void> {
  const exports = Object.entries(values)
    .map(([key, value]) => `export ${key}=${escapeShellSingleQuote(value)}`)
    .join('\n');
  const script = `${exports}\n`;
  const result = await runner.execQuiet(
    'docker',
    [
      'exec', '-i', '-u', 'node', cid, 'sh', '-c',
      `umask 077; mkdir -p "$(dirname ${LOCAL_RUNTIME_ENV_PATH})"; cat > ${LOCAL_RUNTIME_ENV_PATH}; chmod 600 ${LOCAL_RUNTIME_ENV_PATH}`,
    ],
    { stdin: script },
  );
  if (result.code !== 0) localFailure('failed to update the box environment');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
