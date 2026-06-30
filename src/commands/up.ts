/**
 * devbox up — create/boot a box for a branch.
 *
 * Port of cmd_up from devbox.sh. Flow:
 *   1. If a running box exists for the branch: attach (exec in).
 *   2. If a stopped box exists: start it, re-bring display up, attach.
 *   3. Fresh box: create worktree, run devcontainer up, persist GH_TOKEN,
 *      print ready banner, exec into shell.
 */
import type { LauncherContext } from '../lib/context.js';
import { dirname } from 'node:path';
import { containerFor, containerForAll, containerName } from '../lib/docker.js';
import { branchToPath, resolveWorktreesDir, createWorktree, defaultBranch } from '../lib/worktree.js';
import { resolveDevboxEnv, resolveGhToken } from '../lib/env.js';
import { hyperlink } from '../lib/display.js';
import { info, warn, die } from '../lib/log.js';
import { commandExists, escapeShellSingleQuote } from '../lib/shell.js';
import { existsSync } from 'node:fs';

const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';

export async function up(ctx: LauncherContext, branch: string): Promise<number> {
  const { repoRoot, repoName, runner, env, tty } = ctx;

  // Prerequisite checks (bash: require_cmd).
  const dockerOk = await commandExists('docker');
  if (!dockerOk) die('required command not found: docker (Docker / OrbStack)');
  const devcontainerOk = await commandExists('devcontainer');
  if (!devcontainerOk) die('required command not found: devcontainer (npm i -g @devcontainers/cli)');

  const worktreesDir = resolveWorktreesDir(repoRoot, env);
  const path = branchToPath(worktreesDir, repoName, branch);

  // 1. Re-enter a running box.
  let cid = await containerFor(runner, branch);
  if (cid) {
    info(`attaching to running box for ${branch}`);
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
    return execIntoShell(runner, cid, tty);
  }

  // 3. Fresh box: create the worktree.
  if (!existsSync(path)) {
    info(`creating worktree ${branch} -> ${path}`);
    // Fetch latest default branch (best-effort, don't fail if offline).
    const base = await defaultBranch(runner, repoRoot);
    const fetchResult = await runner.execQuiet('git', ['fetch', 'origin', base], { cwd: repoRoot, silentStderr: true });
    if (fetchResult.code !== 0) {
      warn(`git fetch origin ${base} failed (offline?); using local default branch: ${base}`);
    }
    await createWorktree(runner, { repoRoot, path, branch });
  } else {
    info(`worktree exists at ${path}, reusing`);
  }

  // .env check.
  const devboxEnv = resolveDevboxEnv(repoRoot, env);
  if (!existsSync(devboxEnv)) {
    warn(`no .env at ${devboxEnv} (set DEVBOX_ENV)`);
    // Create an empty placeholder so the devcontainer.json bind mount doesn't
    // fail with "bind source path does not exist". provision.sh links this to
    // /workspace/.env; an empty file is harmless.
    await runner.execQuiet('mkdir', ['-p', dirname(devboxEnv)], {});
    await runner.execQuiet('touch', [devboxEnv], {});
  }

  // GitHub token forwarding.
  const ghToken = await resolveGhToken(env, runner, () => commandExists('gh'));
  const ghEnvArgs: string[] = [];
  if (ghToken) {
    // Escape for shell safety: devcontainer CLI passes through to container env.
    // Use the same escaping as profile.d injection.
    ghEnvArgs.push('--remote-env', `GH_TOKEN=${escapeShellSingleQuote(ghToken)}`);
    info('forwarding GitHub token from host gh');
  } else {
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
  const devcontainerEnv = { ...env, DEVBOX_ENV: devboxEnv } as Record<string, string>;
  const result = await runner.execQuiet('devcontainer', devcontainerArgs, {
    env: devcontainerEnv,
    streamStdoutTo: { stream: process.stderr, prefix: '[devcontainer] ' },
  });
  // devcontainer up streams output; we don't parse it for the cid.
  if (result.code !== 0) {
    die('devcontainer up failed; check output above');
  }

  // Look up the container by label (not CLI text parsing).
  cid = await containerFor(runner, branch);
  if (!cid) die("container did not come up; check 'devcontainer up' output above");

  // Persist GH_TOKEN so every shell is authed.
  if (ghToken) {
    const tokenScript = `export GH_TOKEN=${escapeShellSingleQuote(ghToken)}\n`;
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

  process.stderr.write(`\n${CYAN}━━━ devbox ready ━━━${NC}\n`);
  process.stderr.write(`  branch:     ${branch}\n`);
  process.stderr.write(`  worktree:   ${path}\n`);
  process.stderr.write(`  Pi:         pi            (config + extensions copied from your ~/.pi)\n`);
  process.stderr.write(`  Electron:   bun run electron:dev\n`);
  process.stderr.write(`  noVNC:      ${hyperlink(novnc, novnc)}\n`);
  process.stderr.write(`  Vite:       ${hyperlink(vite, vite)}    (when running)\n`);
  process.stderr.write(`  Re-enter:   npx @gannonh/devbox ${branch} --attach\n`);
  process.stderr.write(`  URL/open:   npx @gannonh/devbox ${branch} --url   (add --open to launch a browser)\n`);
  process.stderr.write(`  Stop:       npx @gannonh/devbox ${branch} --stop\n`);
  process.stderr.write(`  Remove:     npx @gannonh/devbox ${branch} --rm\n\n`);

  return execIntoShell(runner, cid, tty);
}

/**
 * Exec into the container's shell. Uses spawn with inherited stdio so the
 * user gets an interactive shell. Signal forwarding is handled by spawnInherit.
 */
function execIntoShell(runner: import('../lib/shell.js').ShellRunner, cid: string, tty: boolean): Promise<number> {
  const ttyFlag = tty ? '-it' : '-i';
  // Split ttyFlag for docker exec: -it -> ['-it'], but docker accepts it as one arg.
  return runner.spawnInherit('docker', ['exec', ttyFlag, '-w', '/workspace', '-u', 'node', cid, 'bash', '-l'], {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
