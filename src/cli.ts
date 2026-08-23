#!/usr/bin/env node
/**
 * devbox CLI entry point.
 *
 * This module owns argument parsing and the single CLI-to-provider dispatch
 * point. Provider implementations receive provider-neutral requests and keep
 * their own lifecycle behavior and formatting behind that boundary.
 */
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from './commands/init.js';
import { findRepoRoot, repoName } from './lib/repo.js';
import {
  defaultProviderRegistry,
  resolveProvider,
  type ProviderRegistry,
} from './providers/registry.js';
import { describeProviderChoice, resolveProviderChoice } from './providers/preference.js';
import { parseExposePortsList, VercelPortsError } from './providers/ports.js';
import { readEnvironmentFile } from './providers/local/env.js';
import type {
  DevboxProvider,
  DisplayCredentialsResult,
  ProviderActionResult,
  ProviderBranchRequest,
  ProviderListRequest,
  ProviderInput,
  ProviderName,
  ProviderOutput,
  ProviderUrlRequest,
} from './providers/types.js';

const PACKAGE_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const USAGE = `devbox — one-command isolated worktree dev containers

USAGE
  devbox [--provider local|vercel] <branch>                    create/boot a box
  devbox [--provider local|vercel] <branch> --attach|-a        re-enter a running box
  devbox [--provider local|vercel] <branch> --url [--open|-o]  print or open provider routes
  devbox [--provider local|vercel] <branch> --stop             stop (keeps worktree + container)
  devbox [--provider local|vercel] <branch> --rm               remove container, worktree, and branch
  devbox [--provider local|vercel] <branch> --password         print the display access code (when supported)
  devbox [--provider local|vercel] --list|-l                  list provider devboxes
  devbox --provider local|vercel                               set the provider for this repo
  devbox --version                                             show the installed version
  devbox --help|-h                                             show this help

OPTIONS
  --provider local|vercel   select a provider; the choice sticks to this
                            repository until you pass --provider again
  --env <path>              with a boot or --attach: inject values from this
                            dotenv file into the box
  --expose-ports <list>     Vercel only, with a boot or --attach: expose these
                            comma-separated app ports as public routes without
                            the interactive prompt
  --timeout <minutes>       Vercel only, with a boot or --attach: Sandbox
                            timeout in minutes; default 60, max 1440 (24h)
  --vcpus <n>               Vercel only, with a boot or --attach: Sandbox
                            vCPUs; memory is 2048 MB per vCPU and Vercel
                            defaults to 2

EXAMPLES
  devbox init                        # set up .devbox/ in the current repo
  devbox my-feature                  # boot a local box for my-feature
  devbox --provider local my-feature --attach
  devbox my-feature --url --open    # open the local noVNC view
  devbox --provider local --list    # list local boxes

NOTE
  Vercel is a core provider. It uses the authenticated GitHub origin only;
  local dirty files and unpushed commits are not copied to the sandbox.
  First use displays the Vercel team/project and requires TTY confirmation.
  In the remote terminal, Ctrl-C reaches the remote process and Ctrl-]
  detaches without stopping the sandbox. App routes are plain HTTPS; the noVNC
  link carries a one-use access code that pairs the browser on click and is then
  dropped from the URL. --password prints that code for the pairing form.
  Vercel detects Vite/Next app ports in the remote checkout and asks once before
  exposing them as public routes; --expose-ports is the non-interactive opt-in.
  Configured devcontainer forwardPorts are always retained, paired noVNC 6080 is
  always exposed, and VNC 5900 and internal 6081 stay private. Setup
  status/retry lives under /vercel/.devbox/runtime/. Cleanup retains retry
  metadata until Sandbox sessions and snapshots are verified absent. Review
  Vercel pricing and limits before choosing ports or timeouts.`;

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
  --url [--open|-o]  print or open provider routes
  --password     print the display access code when supported

FLAGS
  --provider local|vercel   select a provider; the choice sticks to this
                            repository until you pass --provider again
  --env <path>              inject values from this dotenv file; no file is
                            copied into the box or host worktree
  --expose-ports <list>     Vercel only: expose these comma-separated app ports
                            as public routes instead of prompting
  --timeout <minutes>       Vercel only: Sandbox timeout in minutes; default 60,
                            max 1440 (24h)
  --vcpus <n>               Vercel only: Sandbox vCPUs; memory is 2048 MB per
                            vCPU and Vercel defaults to 2

EXAMPLES
  devbox ${branch}                       # boot or re-enter a local box
  devbox ${branch} --attach              # re-enter the running box
  devbox ${branch} --stop                # stop it
  devbox ${branch} --password            # print the display access code
  devbox --provider vercel ${branch}     # remote Vercel sandbox; confirm scope on first use

VERCEL CORE
  Uses the authenticated GitHub origin; local dirty files and unpushed commits
  are not copied. First use confirms the displayed team/project in a TTY.
  Without a complete credential triad, OIDC token, or cached Vercel auth, device
  auth prints the verification URL and user code. Ctrl-C is sent to the remote process.
  Ctrl-] detaches without stopping it.
  App ports detected in the remote checkout (Vite/Next) are offered once as
  public routes; --expose-ports <list> selects them without a prompt and is
  required for any new exposure outside a TTY.
  --env <path> injects dotenv values; omit it to start without project secrets.
  --url prints labeled routes; the noVNC link pairs the browser on click and
  --open opens it. --password prints the Vercel display access code for the
  pairing form; the local provider reports this action as unsupported. Setup status/retry is under
  /vercel/.devbox/runtime/; cleanup keeps mode-0600 retry metadata until
  sessions and snapshots converge. See Vercel pricing and limits before use.`;

const LIST_HELP = `devbox --list — list provider devboxes and routes

USAGE
  devbox [--provider local|vercel] --list|-l

FLAGS
  --provider local|vercel   filter the list by provider; the choice sticks to
                            this repository until you pass --provider again

EXAMPLES
  devbox --list                       # list local boxes
  devbox --provider local --list      # explicit local provider

DESCRIPTION
  Lists boxes for the selected provider. Vercel listing is scoped to the
  current GitHub repository and includes status and identity tags.`;

const ATTACH_HELP = (branch: string) => `devbox ${branch} --attach — re-enter a running box

USAGE
  devbox [--provider local|vercel] <branch> --attach|-a

DESCRIPTION
  Re-enters a running box for the branch. If the box is stopped, starts it
  and re-brings the display stack up, then drops into a shell in /workspace.
  For Vercel, Ctrl-C reaches the remote process and Ctrl-] detaches without
  stopping the sandbox, and confirmed app routes are re-applied without a new
  prompt; --expose-ports <list> changes the exposed app ports.

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

const URL_HELP = (branch: string) => `devbox ${branch} --url — print or open provider routes

USAGE
  devbox [--provider local|vercel] <branch> --url [--open|-o]

FLAGS
  --open|-o    open the noVNC HTTPS route in a browser after printing routes

EXAMPLES
  devbox ${branch} --url
  devbox --provider local ${branch} --url --open`;

const PASSWORD_HELP = (branch: string) => `devbox ${branch} --password — print the display access code

USAGE
  devbox [--provider local|vercel] <branch> --password

DESCRIPTION
  Prints the access code for the Vercel display as labeled username/password
  fields. Opening the printed noVNC link pairs the browser without this code;
  use it when you land on the pairing form instead. The local provider reports
  this action as unsupported.

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
  | { kind: 'set-provider'; provider: ProviderName }
  | {
    kind: 'branch';
    branch: string;
    provider?: ProviderName;
    action: BranchAction;
    envPath?: string;
    exposePorts?: number[];
    timeoutMs?: number;
    vcpus?: number;
  }
  | { kind: 'help'; scope: 'global' | 'init' | 'list' | 'branch'; branch?: string; action?: BranchAction }
  | { kind: 'version' }
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

/**
 * Read the `--expose-ports` value.
 *
 * The flag is the deliberate, non-interactive way to make an app port public,
 * so its value is validated here rather than being handed to a provider as an
 * unchecked string.
 */
function readExposePorts(args: string[], index: number): { ports: number[]; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError('missing comma-separated port list after --expose-ports');
  }
  try {
    return { ports: parseExposePortsList(value), next: index + 2 };
  } catch (error) {
    if (error instanceof VercelPortsError) throw new CliUsageError(error.message);
    throw error;
  }
}

function readEnvPath(args: string[], index: number): { path: string; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError('missing env file path after --env');
  }
  return { path: value, next: index + 2 };
}

function readTimeoutMinutes(args: string[], index: number): { timeoutMs: number; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError('missing timeout in minutes after --timeout');
  }
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new CliUsageError('timeout must be an integer between 1 and 1440 minutes');
  }
  return { timeoutMs: minutes * 60 * 1000, next: index + 2 };
}

function readVcpus(args: string[], index: number): { vcpus: number; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError('missing vCPU count after --vcpus');
  }
  const vcpus = Number(value);
  if (!Number.isInteger(vcpus) || vcpus < 1 || vcpus > 32 || (vcpus !== 1 && vcpus % 2 !== 0)) {
    throw new CliUsageError('vcpus must be a positive integer that is 1 or even, up to 32');
  }
  return { vcpus, next: index + 2 };
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
    if (
      flag === '--expose-ports' || flag === '--env'
      || flag === '--timeout' || flag === '--vcpus'
    ) {
      return usageError(`${flag} is only valid when booting or attaching a branch`);
    }
    return usageError(`misplaced or unknown flag for --list: ${flag}`);
  }
  if (help) return { kind: 'help', scope: 'list' };
  return { kind: 'list', provider };
}

function parseBranch(branch: string, rest: string[], initialProvider?: ProviderName): ParsedCommand {
  let provider = initialProvider;
  const actionFlags: string[] = [];
  let envPath: string | undefined;
  let exposePorts: number[] | undefined;
  let timeoutMs: number | undefined;
  let vcpus: number | undefined;
  let help = false;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag === '--env') {
      try {
        const parsed = readEnvPath(rest, index);
        if (envPath !== undefined) return usageError('duplicate --env flag');
        envPath = parsed.path;
        index = parsed.next - 1;
      } catch (error) {
        if (error instanceof CliUsageError) return usageError(error.message);
        throw error;
      }
      continue;
    }
    if (flag === '--expose-ports') {
      try {
        const parsed = readExposePorts(rest, index);
        if (exposePorts) return usageError('duplicate --expose-ports flag');
        exposePorts = parsed.ports;
        index = parsed.next - 1;
      } catch (error) {
        if (error instanceof CliUsageError) return usageError(error.message);
        throw error;
      }
      continue;
    }
    if (flag === '--timeout') {
      try {
        const parsed = readTimeoutMinutes(rest, index);
        if (timeoutMs !== undefined) return usageError('duplicate --timeout flag');
        timeoutMs = parsed.timeoutMs;
        index = parsed.next - 1;
      } catch (error) {
        if (error instanceof CliUsageError) return usageError(error.message);
        throw error;
      }
      continue;
    }
    if (flag === '--vcpus') {
      try {
        const parsed = readVcpus(rest, index);
        if (vcpus !== undefined) return usageError('duplicate --vcpus flag');
        vcpus = parsed.vcpus;
        index = parsed.next - 1;
      } catch (error) {
        if (error instanceof CliUsageError) return usageError(error.message);
        throw error;
      }
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
    // Exposing a public route only makes sense while a box is being brought up
    // or re-entered; every other action is read-only or destructive.
    if (exposePorts && action.action !== 'up' && action.action !== 'attach') {
      return usageError(`--expose-ports is not valid with --${action.action}`);
    }
    if (envPath !== undefined && action.action !== 'up' && action.action !== 'attach') {
      return usageError(`--env is not valid with --${action.action}`);
    }
    if (timeoutMs !== undefined && action.action !== 'up' && action.action !== 'attach') {
      return usageError(`--timeout is not valid with --${action.action}`);
    }
    if (vcpus !== undefined && action.action !== 'up' && action.action !== 'attach') {
      return usageError(`--vcpus is not valid with --${action.action}`);
    }
    return {
      kind: 'branch',
      branch,
      provider,
      action,
      ...(envPath === undefined ? {} : { envPath }),
      ...(exposePorts === undefined ? {} : { exposePorts }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(vcpus === undefined ? {} : { vcpus }),
    };
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(error.message);
    throw error;
  }
}

function parseGlobalHelp(trailing: string[]): ParsedCommand {
  if (trailing.length > 0) return usageError(`unexpected argument after global help: ${trailing[0]}`);
  return { kind: 'help', scope: 'global' };
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
  if (first === '--help' || first === '-h') return parseGlobalHelp(rest);
  if (first === '--version') {
    if (rest.length > 0) return usageError(`unexpected argument after --version: ${rest[0]}`);
    return { kind: 'version' };
  }

  if (first === 'init') {
    let force = false;
    let help = false;
    for (const flag of rest) {
      if (flag === '--force') {
        if (force) return usageError('duplicate --force flag');
        force = true;
      } else if (flag === '--help' || flag === '-h') {
        help = true;
      } else {
        return usageError(`unknown or misplaced option for init: ${flag}`);
      }
    }
    if (help) return { kind: 'help', scope: 'init' };
    return { kind: 'init', force };
  }

  if (first === '--list' || first === '-l') return parseList(rest);

  if (first === '--provider') {
    try {
      const parsed = readProvider(args, 0);
      const next = args[parsed.next];
      if (next === '--list' || next === '-l') return parseList(args.slice(parsed.next + 1), parsed.provider);
      if (next === '--help' || next === '-h') return parseGlobalHelp(args.slice(parsed.next + 1));
      if (next === '--provider') return usageError('conflicting --provider flags');
      if (next === 'init') return usageError('--provider cannot be used with init');
      // `devbox --provider vercel` on its own sets the provider for this
      // repository, which is the natural way to use a choice that sticks.
      if (!next) return { kind: 'set-provider', provider: parsed.provider };
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
  stdin: ProviderInput;
  stdout: ProviderOutput;
  stderr: ProviderOutput;
}

export interface DispatchOptions {
  providerRegistry?: ProviderRegistry;
  /** Overridable for tests; defaults to the XDG state home. */
  stateHome?: string;
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

type ExitCodeCarrier = { exitCode?: unknown };

function errorExitCode(error: unknown, fallback: number): number {
  if (typeof error !== 'object' || error === null || !('exitCode' in error)) return fallback;
  return Number((error as ExitCodeCarrier).exitCode) || fallback;
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
    const exitCode = errorExitCode(error, 1);
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
    const exitCode = errorExitCode(error, 1);
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
  if (parsed.kind === 'version') {
    io.stdout.write(`${PACKAGE_VERSION}\n`);
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
  // The provider sticks to the repository until it is changed, so a cloud repo
  // does not need --provider on every command.
  const choice = resolveProviderChoice(
    parsed.provider,
    root,
    options.stateHome === undefined ? {} : { stateHome: options.stateHome },
  );
  let provider: DevboxProvider;
  try {
    provider = resolveProvider(choice.provider, registry);
  } catch (error) {
    const exitCode = errorExitCode(error, 2);
    io.stderr.write(`[devbox] ${errorMessage(error)}\n`);
    return exitCode;
  }
  const notice = describeProviderChoice(choice);
  if (notice) io.stderr.write(`${notice}\n`);

  if (parsed.kind === 'set-provider') {
    // resolveProviderChoice already persisted the explicit choice.
    io.stdout.write(`provider set to ${choice.provider} for this repository\n`);
    return 0;
  }

  let envPath: string | undefined;
  let runtimeEnvironment: Record<string, string> = {};
  if (parsed.kind === 'branch' && parsed.envPath !== undefined) {
    envPath = resolve(parsed.envPath);
    try {
      runtimeEnvironment = await readEnvironmentFile(envPath);
    } catch (error) {
      io.stderr.write(`[devbox] ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  const context = {
    repoRoot: root,
    repoName: repoName(root),
    env: options.env ?? { ...process.env },
    ...(envPath === undefined ? {} : { envPath }),
    ...(parsed.kind === 'branch' && envPath !== undefined ? { runtimeEnvironment } : {}),
    tty: options.tty ?? Boolean(io.stdin.isTTY),
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
  };

  if (parsed.kind === 'list') {
    const request: ProviderListRequest = context;
    return runProviderOperation(() => provider.list(request), io);
  }

  if (parsed.exposePorts && choice.provider !== 'vercel') {
    io.stderr.write(`[devbox] --expose-ports is not supported by the ${choice.provider} provider\n`);
    return 2;
  }
  if (parsed.timeoutMs !== undefined && choice.provider !== 'vercel') {
    io.stderr.write(`[devbox] --timeout is not supported by the ${choice.provider} provider\n`);
    return 2;
  }
  if (parsed.vcpus !== undefined && choice.provider !== 'vercel') {
    io.stderr.write(`[devbox] --vcpus is not supported by the ${choice.provider} provider\n`);
    return 2;
  }
  const request: ProviderBranchRequest = {
    ...context,
    branch: parsed.branch,
    ...(parsed.exposePorts === undefined ? {} : { exposePorts: parsed.exposePorts }),
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    ...(parsed.vcpus === undefined ? {} : { vcpus: parsed.vcpus }),
  };
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
  const code = await dispatch(args, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
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
