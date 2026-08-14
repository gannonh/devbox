#!/usr/bin/env node
/**
 * devbox CLI entry point.
 *
 * This module owns argument parsing and the single CLI-to-provider dispatch
 * point. Provider implementations receive provider-neutral requests and keep
 * their own lifecycle behavior and formatting behind that boundary.
 */
import type { Writable } from 'node:stream';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { init } from './commands/init.js';
import { findRepoRoot, repoName } from './lib/repo.js';
import {
  defaultProviderRegistry,
  resolveProvider,
  type ProviderRegistry,
} from './providers/registry.js';
import type {
  DevboxProvider,
  DisplayCredentialsResult,
  ProviderActionResult,
  ProviderBranchRequest,
  ProviderListRequest,
  ProviderName,
  ProviderUrlRequest,
} from './providers/types.js';

const USAGE = `devbox — one-command isolated worktree dev containers

USAGE
  devbox [--provider local|vercel] <branch>                    create/boot a box
  devbox [--provider local|vercel] <branch> --attach|-a        re-enter a running box
  devbox [--provider local|vercel] <branch> --url [--open|-o]  print or open the noVNC URL
  devbox [--provider local|vercel] <branch> --stop             stop (keeps worktree + container)
  devbox [--provider local|vercel] <branch> --rm               remove container, worktree, and branch
  devbox [--provider local|vercel] <branch> --password         retrieve display credentials
  devbox [--provider local|vercel] --list|-l                  list provider devboxes
  devbox --help|-h                                             show this help

OPTIONS
  --provider local|vercel   select a provider (local is the default)

EXAMPLES
  devbox init                        # set up .devbox/ in the current repo
  devbox my-feature                  # boot a local box for my-feature
  devbox --provider local my-feature --attach
  devbox my-feature --url --open    # open the local noVNC view
  devbox --provider local --list    # list local boxes

NOTE
  The Vercel provider name is reserved for a future release; this package
  does not claim Vercel lifecycle support yet.`;

const INIT_HELP = `devbox init — scaffold .devbox/ + .devcontainer/ in this repo

USAGE
  devbox init [--force]

FLAGS
  --force    overwrite existing .devbox/ files without prompting

DESCRIPTION
  Copies template files (Dockerfile, provision.sh, start-display.sh,
  post-create.sh stub, README.md, devcontainer.json) into the current repo.
  Provider selection applies to branch lifecycle and list operations, not init.`;

const UP_HELP = (branch: string) => `devbox ${branch} — create/boot a box for a branch

USAGE
  devbox [--provider local|vercel] <branch> [ACTION]

ACTIONS
  --attach|-a    re-enter a running box
  --stop         stop the box (keeps local resources)
  --rm           remove the box and local resources
  --url [--open|-o]  print or open the noVNC URL
  --password     retrieve labeled display credentials

FLAGS
  --provider local|vercel   select a provider (local is the default)

EXAMPLES
  devbox ${branch}                       # boot or re-enter a local box
  devbox ${branch} --attach              # re-enter the running box
  devbox ${branch} --stop                # stop it
  devbox ${branch} --password            # retrieve credentials if supported
  devbox --provider vercel ${branch}     # reserved; unavailable in this release`;

const LIST_HELP = `devbox --list — list provider devboxes + noVNC URLs

USAGE
  devbox [--provider local|vercel] --list|-l

FLAGS
  --provider local|vercel   filter the list by provider (local is the default)

EXAMPLES
  devbox --list                       # list local boxes
  devbox --provider local --list      # explicit local provider

DESCRIPTION
  Lists boxes for the selected provider. The Vercel provider is reserved for
  a future release and is not available in this package.`;

const ATTACH_HELP = (branch: string) => `devbox ${branch} --attach — re-enter a running box

USAGE
  devbox [--provider local|vercel] <branch> --attach|-a

DESCRIPTION
  Re-enters a running box for the branch. If the box is stopped, starts it
  and re-brings the display stack up, then drops into a shell in /workspace.

EXAMPLES
  devbox ${branch} --attach
  devbox --provider local ${branch} --attach`;

const STOP_HELP = (branch: string) => `devbox ${branch} --stop — stop the box (keeps worktree + container)

USAGE
  devbox [--provider local|vercel] <branch> --stop

DESCRIPTION
  Stops the selected provider's box while preserving its local worktree when
  supported. Re-enter with: devbox ${branch} --attach

EXAMPLES
  devbox ${branch} --stop
  devbox --provider local ${branch} --stop`;

const RM_HELP = (branch: string) => `devbox ${branch} --rm — remove container, worktree, and branch

USAGE
  devbox [--provider local|vercel] <branch> --rm

DESCRIPTION
  Removes the selected provider's box and associated local resources when
  supported. Uncommitted local work may be lost.

EXAMPLES
  devbox ${branch} --rm
  devbox --provider local ${branch} --rm`;

const URL_HELP = (branch: string) => `devbox ${branch} --url — print or open the noVNC URL

USAGE
  devbox [--provider local|vercel] <branch> --url [--open|-o]

FLAGS
  --open|-o    open the noVNC URL in a browser instead of printing it

EXAMPLES
  devbox ${branch} --url
  devbox --provider local ${branch} --url --open`;

const PASSWORD_HELP = (branch: string) => `devbox ${branch} --password — retrieve display credentials

USAGE
  devbox [--provider local|vercel] <branch> --password

DESCRIPTION
  Retrieves explicitly supported display credentials and prints labeled
  username/password fields. Providers may report this action as unsupported.

EXAMPLES
  devbox ${branch} --password
  devbox --provider local ${branch} --password`;

const BRANCH_FLAGS = new Set([
  '--attach',
  '-a',
  '--stop',
  '--rm',
  '--url',
  '--open',
  '-o',
  '--password',
]);

export type BranchAction =
  | { action: 'up' }
  | { action: 'attach' }
  | { action: 'stop' }
  | { action: 'rm' }
  | { action: 'url'; open: boolean }
  | { action: 'password' };

export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export type ParsedCommand =
  | { kind: 'init'; force: boolean }
  | { kind: 'list'; provider?: ProviderName }
  | { kind: 'branch'; branch: string; provider?: ProviderName; action: BranchAction }
  | { kind: 'help'; scope: 'global' | 'init' | 'list' | 'branch'; branch?: string; action?: BranchAction }
  | { kind: 'error'; message: string; exitCode: number };

function usageError(message: string): ParsedCommand {
  return {
    kind: 'error',
    exitCode: 2,
    message: `${message}\n\nusage:\n${USAGE}`,
  };
}

function providerName(value: string | undefined): ProviderName {
  if (value === 'local' || value === 'vercel') return value;
  if (!value) throw new CliUsageError('missing provider value after --provider');
  throw new CliUsageError(`unsupported provider: ${value}`);
}

function readProvider(args: string[], index: number): { provider: ProviderName; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError('missing provider value after --provider');
  }
  return { provider: providerName(value), next: index + 2 };
}

function formatBranchUsage(branch: string, action: BranchAction): string {
  switch (action.action) {
    case 'attach':
      return ATTACH_HELP(branch);
    case 'stop':
      return STOP_HELP(branch);
    case 'rm':
      return RM_HELP(branch);
    case 'url':
      return URL_HELP(branch);
    case 'password':
      return PASSWORD_HELP(branch);
    case 'up':
      return UP_HELP(branch);
  }
}

/**
 * Resolve a branch action from validated action flags.
 * --open/-o implies --url and may be paired with --url itself.
 */
export function resolveBranchAction(rest: string[]): BranchAction {
  const actionFlags = rest.filter((flag) => BRANCH_FLAGS.has(flag));
  const canonical = actionFlags.map((flag) => {
    if (flag === '--attach' || flag === '-a') return 'attach';
    if (flag === '--url' || flag === '--open' || flag === '-o') return 'url';
    if (flag === '--stop') return 'stop';
    if (flag === '--rm') return 'rm';
    return 'password';
  });
  const unique = new Set(canonical);
  if (unique.size > 1) {
    throw new CliUsageError(`conflicting action flags: ${actionFlags.join(', ')}`);
  }

  const action = canonical[0];
  if (!action) return { action: 'up' };
  if (action === 'url') {
    return { action: 'url', open: rest.includes('--open') || rest.includes('-o') };
  }
  if (action === 'attach') return { action: 'attach' };
  if (action === 'stop') return { action: 'stop' };
  if (action === 'rm') return { action: 'rm' };
  return { action: 'password' };
}

function parseList(rest: string[], initialProvider?: ProviderName): ParsedCommand {
  let provider = initialProvider;
  let help = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag === '--provider') {
      try {
        const parsed = readProvider(rest, index);
        if (provider) return usageError('conflicting --provider flags');
        provider = parsed.provider;
        index = parsed.next - 1;
      } catch (error) {
        if (error instanceof CliUsageError) return usageError(error.message);
        throw error;
      }
      continue;
    }
    if (flag === '--list' || flag === '-l') return usageError('duplicate --list flag');
    return usageError(`misplaced or unknown flag for --list: ${flag}`);
  }
  if (help) return { kind: 'help', scope: 'list' };
  return { kind: 'list', provider };
}

function parseBranch(branch: string, rest: string[], initialProvider?: ProviderName): ParsedCommand {
  let provider = initialProvider;
  const actionFlags: string[] = [];
  let help = false;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag === '--provider') {
      try {
        const parsed = readProvider(rest, index);
        if (provider) return usageError('conflicting --provider flags');
        provider = parsed.provider;
        index = parsed.next - 1;
      } catch (error) {
        if (error instanceof CliUsageError) return usageError(error.message);
        throw error;
      }
      continue;
    }
    if (BRANCH_FLAGS.has(flag)) {
      actionFlags.push(flag);
      continue;
    }
    if (flag === '--list' || flag === '-l') {
      return usageError('--list must be the list command, not a branch flag');
    }
    if (flag === '--force') return usageError('--force is only valid for devbox init');
    return usageError(`unknown or misplaced option: ${flag}`);
  }

  try {
    const action = resolveBranchAction(actionFlags);
    if (help) return { kind: 'help', scope: 'branch', branch, action };
    return { kind: 'branch', branch, provider, action };
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(error.message);
    throw error;
  }
}

/** Parse the CLI grammar without touching the repository or a provider. */
export function parseCliArgs(args: string[]): ParsedCommand {
  if (args.length === 0) {
    return {
      kind: 'error',
      exitCode: 1,
      message: `${USAGE}\n\nRun "devbox --help" for full usage.`,
    };
  }

  const [first, ...rest] = args;
  if (first === '--help' || first === '-h') return { kind: 'help', scope: 'global' };

  if (first === 'init') {
    if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help', scope: 'init' };
    let force = false;
    for (const flag of rest) {
      if (flag === '--force') {
        if (force) return usageError('duplicate --force flag');
        force = true;
      } else {
        return usageError(`unknown or misplaced option for init: ${flag}`);
      }
    }
    return { kind: 'init', force };
  }

  if (first === '--list' || first === '-l') return parseList(rest);

  if (first === '--provider') {
    try {
      const parsed = readProvider(args, 0);
      const next = args[parsed.next];
      if (next === '--list' || next === '-l') return parseList(args.slice(parsed.next + 1), parsed.provider);
      if (next === '--help' || next === '-h') return { kind: 'help', scope: 'global' };
      if (next === '--provider') return usageError('conflicting --provider flags');
      if (next === 'init') return usageError('--provider cannot be used with init');
      if (!next) return usageError('missing branch after --provider');
      if (next.startsWith('-')) return usageError(`branch is required before ${next}`);
      return parseBranch(next, args.slice(parsed.next + 1), parsed.provider);
    } catch (error) {
      if (error instanceof CliUsageError) return usageError(error.message);
      throw error;
    }
  }

  if (first.startsWith('-')) {
    return usageError(`unknown option or missing branch: ${first}`);
  }

  return parseBranch(first, rest);
}

/** Alias retained as the parser's public, descriptive entry point. */
export const parseArgs = parseCliArgs;

export interface DispatchIO {
  stdout: Writable;
  stderr: Writable;
}

export interface DispatchOptions {
  providerRegistry?: ProviderRegistry;
  /** Alias useful for callers embedding the parser/dispatcher. */
  registry?: ProviderRegistry;
  repoRoot?: string | null;
  env?: Record<string, string | undefined>;
  tty?: boolean;
}

function operationCode(result: ProviderActionResult): number {
  return result.exitCode;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorWasReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'reported' in error
    && (error as { reported?: unknown }).reported === true;
}

async function runProviderOperation(
  operation: () => Promise<ProviderActionResult>,
  io: DispatchIO,
): Promise<number> {
  try {
    return operationCode(await operation());
  } catch (error) {
    const exitCode = typeof error === 'object' && error !== null && 'exitCode' in error
      ? Number((error as { exitCode?: unknown }).exitCode) || 1
      : 1;
    if (!errorWasReported(error)) io.stderr.write(`[devbox] ${errorMessage(error)}\n`);
    return exitCode;
  }
}

async function displayCredentials(
  provider: DevboxProvider,
  request: ProviderBranchRequest,
  io: DispatchIO,
): Promise<number> {
  try {
    const result: DisplayCredentialsResult = await provider.getDisplayCredentials(request);
    if (!result.supported) {
      io.stderr.write(`[devbox] ${result.message}\n`);
      return 2;
    }
    io.stdout.write(`username: ${result.username}\npassword: ${result.password}\n`);
    return 0;
  } catch (error) {
    const exitCode = typeof error === 'object' && error !== null && 'exitCode' in error
      ? Number((error as { exitCode?: unknown }).exitCode) || 1
      : 1;
    if (!errorWasReported(error)) io.stderr.write(`[devbox] ${errorMessage(error)}\n`);
    return exitCode;
  }
}

function helpText(command: Extract<ParsedCommand, { kind: 'help' }>): string {
  if (command.scope === 'global') return USAGE;
  if (command.scope === 'init') return INIT_HELP;
  if (command.scope === 'list') return LIST_HELP;
  return formatBranchUsage(command.branch ?? '<branch>', command.action ?? { action: 'up' });
}

export async function dispatch(
  args: string[],
  io: DispatchIO,
  options: DispatchOptions = {},
): Promise<number> {
  const parsed = parseCliArgs(args);
  if (parsed.kind === 'error') {
    io.stderr.write(`${parsed.message}\n`);
    return parsed.exitCode;
  }
  if (parsed.kind === 'help') {
    io.stdout.write(`${helpText(parsed)}\n`);
    return 0;
  }
  if (parsed.kind === 'init') {
    return init({ force: parsed.force, stderr: io.stderr });
  }

  const root = options.repoRoot === undefined ? findRepoRoot() : options.repoRoot;
  if (!root) {
    io.stderr.write('[devbox] not in a git repository\n');
    return 1;
  }

  const registry = options.providerRegistry ?? options.registry ?? defaultProviderRegistry;
  let provider: DevboxProvider;
  try {
    provider = resolveProvider(parsed.provider, registry);
  } catch (error) {
    const exitCode = typeof error === 'object' && error !== null && 'exitCode' in error
      ? Number((error as { exitCode?: unknown }).exitCode) || 1
      : 2;
    io.stderr.write(`[devbox] ${errorMessage(error)}\n`);
    return exitCode;
  }

  const context = {
    repoRoot: root,
    repoName: repoName(root),
    env: options.env ?? { ...process.env },
    tty: options.tty ?? Boolean(process.stdin.isTTY),
    stdout: io.stdout,
    stderr: io.stderr,
  };

  if (parsed.kind === 'list') {
    const request: ProviderListRequest = context;
    return runProviderOperation(() => provider.list(request), io);
  }

  const request: ProviderBranchRequest = { ...context, branch: parsed.branch };
  switch (parsed.action.action) {
    case 'up':
      return runProviderOperation(() => provider.up(request), io);
    case 'attach':
      return runProviderOperation(() => provider.attach(request), io);
    case 'stop':
      return runProviderOperation(() => provider.stop(request), io);
    case 'rm':
      return runProviderOperation(() => provider.remove(request), io);
    case 'url': {
      const urlRequest: ProviderUrlRequest = { ...request, open: parsed.action.open };
      return runProviderOperation(() => provider.url(urlRequest), io);
    }
    case 'password':
      return displayCredentials(provider, request, io);
  }
}

// Entry point when run as a bin.
async function main() {
  const args = process.argv.slice(2);
  const code = await dispatch(args, { stdout: process.stdout, stderr: process.stderr });
  process.exit(code);
}

/**
 * Determine whether this module is the process entry point.
 *
 * When installed globally via npm, the `devbox` bin is a symlink to
 * `dist/cli.js`. `process.argv[1]` is the symlink path, while `import.meta.url`
 * is the real file URL — they don't match string-for-string. Resolve both to
 * their real paths and compare those.
 */
export function isMainEntry(argv1: string, moduleUrl: string): boolean {
  if (!argv1 || !moduleUrl) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainEntry(process.argv[1] ?? '', import.meta.url)) {
  main();
}
