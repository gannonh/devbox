#!/usr/bin/env node
/**
 * devbox CLI entry point.
 *
 * Arg parsing and command dispatch. No business logic in this file.
 * Command bodies land in Phases 2-3.
 */
import type { Writable } from 'node:stream';

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

const GLOBAL_FLAGS = new Set(['--help', '-h', '--list', '-l']);
const BRANCH_FLAGS = new Set(['--attach', '-a', '--stop', '--rm', '--url', '--open', '-o']);
export interface DispatchIO {
  stdout: Writable;
  stderr: Writable;
}

export function dispatch(args: string[], io: DispatchIO): number {
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
    io.stderr.write('not yet implemented: init (Phase 2)\n');
    return 1;
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

  // Branch-level help.
  if (rest[0] === '--help' || rest[0] === '-h') {
    io.stdout.write(UP_HELP(branch) + '\n');
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
function main() {
  const args = process.argv.slice(2);
  const code = dispatch(args, { stdout: process.stdout, stderr: process.stderr });
  process.exit(code);
}

// Only run main when executed directly, not when imported.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main();
}
