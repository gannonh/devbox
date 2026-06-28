#!/usr/bin/env node
/**
 * devbox CLI entry point.
 *
 * Arg parsing and command dispatch. No business logic in this file.
 * Command bodies land in Phases 2-3.
 */
import type { Writable } from 'node:stream';
import { init } from './commands/init.js';

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
export interface DispatchIO {
  stdout: Writable;
  stderr: Writable;
}

export function dispatch(args: string[], io: DispatchIO): number | Promise<number> {
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
    io.stderr.write('not yet implemented: --list (Phase 3)\n');
    return 1;
  }

  // Init command.
  if (first === 'init') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      io.stdout.write(INIT_HELP + '\n');
      return 0;
    }
    const force = rest.includes('--force');
    return init({ force, stdout: io.stdout, stderr: io.stderr });
  }

  // Unknown flag (starts with - but not a recognized global/branch flag).
  if (first.startsWith('-') && !GLOBAL_FLAGS.has(first) && !BRANCH_FLAGS.has(first)) {
    io.stderr.write(`unknown option: ${first}\n\n`);
    io.stderr.write(USAGE + '\n');
    return 2;
  }

  // Branch command: <branch> [flag ...]
  // first is the branch name (doesn't start with -) or a recognized branch flag
  // used without a branch (error).
  if (BRANCH_FLAGS.has(first)) {
    io.stderr.write(`usage: devbox <branch> ${first}\n\n`);
    io.stderr.write(USAGE + '\n');
    return 1;
  }

  // first = branch name, rest may contain flags.
  const branch = first;

  // Help short-circuit: --help/-h anywhere in rest renders per-command help.
  // Must run BEFORE flag routing so <branch> <flag> --help renders help (exit 0)
  // instead of falling through to the not-yet-implemented stub (exit 1).
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

  // Route by the first flag in rest.
  const flag = rest.find((a) => BRANCH_FLAGS.has(a));

  if (flag === '--attach' || flag === '-a') {
    io.stderr.write(`not yet implemented: ${branch} --attach (Phase 3)\n`);
    return 1;
  }
  if (flag === '--stop') {
    io.stderr.write(`not yet implemented: ${branch} --stop (Phase 3)\n`);
    return 1;
  }
  if (flag === '--rm') {
    io.stderr.write(`not yet implemented: ${branch} --rm (Phase 3)\n`);
    return 1;
  }
  if (flag === '--url' || flag === '--open' || flag === '-o') {
    io.stderr.write(`not yet implemented: ${branch} ${flag} (Phase 3)\n`);
    return 1;
  }

  // No flag: boot (up command).
  io.stderr.write(`not yet implemented: ${branch} (Phase 3)\n`);
  return 1;
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
