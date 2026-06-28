#!/usr/bin/env node
/**
 * devbox CLI entry point.
 *
 * Arg parsing and command dispatch. No business logic in this file.
 * Command bodies land in Phases 2-3.
 */
import type { Writable } from 'node:stream';
import { init } from './commands/init.js';
import { up } from './commands/up.js';
import { attach } from './commands/attach.js';
import { stop } from './commands/stop.js';
import { rm } from './commands/rm.js';
import { list } from './commands/list.js';
import { url } from './commands/url.js';
import type { LauncherContext } from './lib/context.js';
import { RealShellRunner } from './lib/shell.js';
import { findRepoRoot, repoName } from './lib/repo.js';

const USAGE = `devbox — one-command isolated worktree dev containers

USAGE
  devbox init [--force]              scaffold .devbox/ + .devcontainer/ in this repo
  devbox <branch>                    create/boot a box for a branch
  devbox <branch> --attach|-a        re-enter a running box
  devbox <branch> --url [--open|-o]  print or open the noVNC URL
  devbox <branch> --stop             stop (keeps worktree + container)
  devbox <branch> --rm               remove container, worktree, and branch
  devbox --list|-l                   list devbox containers + noVNC URLs
  devbox --help|-h                   show this help

EXAMPLES
  devbox init                        # set up .devbox/ in the current repo
  devbox my-feature                  # boot a box for the my-feature branch
  devbox my-feature --attach         # re-enter the running box
  devbox my-feature --url --open     # open the noVNC view in a browser
  devbox --list                      # see all running devboxes`;

const INIT_HELP = `devbox init — scaffold .devbox/ + .devcontainer/ in this repo

USAGE
  devbox init [--force]

FLAGS
  --force    overwrite existing .devbox/ files without prompting

DESCRIPTION
  Copies template files (Dockerfile, provision.sh, start-display.sh,
  post-create.sh stub, README.md, devcontainer.json) into the current repo.
  Without --force, errors if .devbox/ already exists with differing files.`;

const UP_HELP = (branch: string) => `devbox ${branch} — create/boot a box for a branch

USAGE
  devbox <branch> [--attach|-a] [--stop] [--rm] [--url [--open|-o]]

SUBCOMMANDS (via flags on the same branch)
  --attach|-a    re-enter a running box
  --stop         stop the box (keeps worktree + container)
  --rm           remove container, worktree, and branch
  --url          print the noVNC URL
  --open|-o      open the noVNC URL in a browser

EXAMPLES
  devbox ${branch}                  # boot or re-enter
  devbox ${branch} --attach         # re-enter the running box
  devbox ${branch} --stop           # stop it`;

const LIST_HELP = `devbox --list — list devbox containers + noVNC URLs

USAGE
  devbox --list|-l

DESCRIPTION
  Lists all devbox containers for the current repo with their state
  (running/stopped) and noVNC URLs for running boxes.`;

const ATTACH_HELP = (branch: string) => `devbox ${branch} --attach — re-enter a running box

USAGE
  devbox <branch> --attach|-a

DESCRIPTION
  Re-enters a running box for the branch. If the box is stopped, starts it
  and re-brings the display stack up, then drops into a shell in /workspace.

EXAMPLES
  devbox ${branch} --attach    # re-enter the running box for ${branch}`;

const STOP_HELP = (branch: string) => `devbox ${branch} --stop — stop the box (keeps worktree + container)

USAGE
  devbox <branch> --stop

DESCRIPTION
  Stops the container but keeps the worktree and container on disk.
  Re-enter with: devbox <branch> --attach

EXAMPLES
  devbox ${branch} --stop      # stop the box for ${branch}`;

const RM_HELP = (branch: string) => `devbox ${branch} --rm — remove container, worktree, and branch

USAGE
  devbox <branch> --rm

DESCRIPTION
  Removes the container, the worktree directory, and the local branch.
  Uncommitted work in the worktree is lost.

EXAMPLES
  devbox ${branch} --rm        # tear down the box for ${branch}`;

const URL_HELP = (branch: string) => `devbox ${branch} --url — print or open the noVNC URL

USAGE
  devbox <branch> --url [--open|-o]

FLAGS
  --open|-o    open the noVNC URL in a browser instead of printing it

DESCRIPTION
  Prints the noVNC URL for a running box. Add --open to launch it in a
  browser.

EXAMPLES
  devbox ${branch} --url       # print the noVNC URL
  devbox ${branch} --url --open  # open it in a browser`;

const GLOBAL_FLAGS = new Set(['--help', '-h', '--list', '-l']);
const BRANCH_FLAGS = new Set(['--attach', '-a', '--stop', '--rm', '--url', '--open', '-o']);

export type BranchAction =
  | { action: 'up' }
  | { action: 'attach' }
  | { action: 'stop' }
  | { action: 'rm' }
  | { action: 'url'; open: boolean };

/**
 * Resolve the action for a branch command from the remaining flags.
 * --open/-o anywhere in the flags implies --url with open=true, matching the
 * bash behavior where --open is an alias for --url --open.
 */
export function resolveBranchAction(rest: string[]): BranchAction {
  const hasOpen = rest.includes('--open') || rest.includes('-o');
  if (rest.includes('--url') || hasOpen) {
    return { action: 'url', open: hasOpen };
  }
  if (rest.includes('--attach') || rest.includes('-a')) return { action: 'attach' };
  if (rest.includes('--stop')) return { action: 'stop' };
  if (rest.includes('--rm')) return { action: 'rm' };
  return { action: 'up' };
}
export interface DispatchIO {
  stdout: Writable;
  stderr: Writable;
}

export async function dispatch(args: string[], io: DispatchIO): Promise<number> {
  // No args: print usage, exit non-zero.
  if (args.length === 0) {
    io.stderr.write(USAGE + '\n');
    io.stderr.write('\nRun "devbox --help" for full usage.\n');
    return 1;
  }

  const [first, ...rest] = args;

  // Global help.
  if (first === '--help' || first === '-h') {
    io.stdout.write(USAGE + '\n');
    return 0;
  }

  // List command.
  if (first === '--list' || first === '-l') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      io.stdout.write(LIST_HELP + '\n');
      return 0;
    }
    const root = findRepoRoot();
    if (!root) {
      io.stderr.write('[devbox] not in a git repository\n');
      return 1;
    }
    const ctx: LauncherContext = {
      repoRoot: root,
      repoName: repoName(root),
      runner: new RealShellRunner(),
      env: { ...process.env },
      tty: process.stdin.isTTY,
    };
    return list(ctx, io.stderr);
  }

  // Init command.
  if (first === 'init') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      io.stdout.write(INIT_HELP + '\n');
      return 0;
    }
    const force = rest.includes('--force');
    return init({ force, stderr: io.stderr });
  }

  // Unknown flag (starts with - but not a recognized global/branch flag).
  if (first.startsWith('-') && !GLOBAL_FLAGS.has(first) && !BRANCH_FLAGS.has(first)) {
    io.stderr.write(`unknown option: ${first}\n\n`);
    io.stderr.write(USAGE + '\n');
    return 2;
  }

  // Branch flag used without a branch (error).
  if (BRANCH_FLAGS.has(first)) {
    io.stderr.write(`usage: devbox <branch> ${first}\n\n`);
    io.stderr.write(USAGE + '\n');
    return 1;
  }

  // first = branch name, rest may contain flags.
  const branch = first;

  // Help short-circuit: --help/-h anywhere in rest renders per-command help.
  // Must run BEFORE the repo-root check so help works outside a git repo.
  const helpFlag = rest.find((a) => a === '--help' || a === '-h');
  if (helpFlag) {
    const actionFlag = rest.find((a) => BRANCH_FLAGS.has(a));
    let help: string;
    if (actionFlag === '--attach' || actionFlag === '-a') {
      help = ATTACH_HELP(branch);
    } else if (actionFlag === '--stop') {
      help = STOP_HELP(branch);
    } else if (actionFlag === '--rm') {
      help = RM_HELP(branch);
    } else if (actionFlag === '--url' || actionFlag === '--open' || actionFlag === '-o') {
      help = URL_HELP(branch);
    } else {
      help = UP_HELP(branch);
    }
    io.stdout.write(help + '\n');
    return 0;
  }

  // Build the launcher context for branch commands (after help check).
  const root = findRepoRoot();
  if (!root) {
    io.stderr.write('[devbox] not in a git repository\n');
    return 1;
  }
  const ctx: LauncherContext = {
    repoRoot: root,
    repoName: repoName(root),
    runner: new RealShellRunner(),
    env: { ...process.env },
    tty: process.stdin.isTTY,
  };

  // Route by the resolved action from all flags in rest.
  const action = resolveBranchAction(rest);

  switch (action.action) {
    case 'attach':
      return attach(ctx, branch);
    case 'stop':
      return stop(ctx, branch);
    case 'rm':
      return rm(ctx, branch);
    case 'url':
      return url(ctx, branch, action.open);
    case 'up':
      return up(ctx, branch);
  }
}

// Entry point when run as a bin.
async function main() {
  const args = process.argv.slice(2);
  const code = await dispatch(args, { stdout: process.stdout, stderr: process.stderr });
  process.exit(code);
}

// Only run main when executed directly, not when imported.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main();
}
