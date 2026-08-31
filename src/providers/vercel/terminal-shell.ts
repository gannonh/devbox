import {
  currentVercelSessionId,
  type VercelSessionId,
} from './session-lease.js';
import type {
  VercelSandboxClient,
  VercelSandboxHandle,
  VercelCommandResult,
} from './client.js';
import type { VercelTerminalProgram } from './terminal.js';

export const DEVBOX_TMUX_SOCKET_ROOT = '/tmp/devbox-tmux';
export const DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX = 'session-';
export const DEVBOX_TMUX_SESSION_NAME = 'devbox';
export const VERCEL_TERMINAL_SHELL_SETUP_TIMEOUT_MS = 30_000;
const MAX_TMUX_RECONCILIATION_ATTEMPTS = 3;

export interface VercelTerminalShell {
  socketDirectory: string;
  socketPath: string;
  sessionId: VercelSessionId;
  program: VercelTerminalProgram;
}

export interface PrepareVercelTerminalShellOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  cwd: string;
  signal?: AbortSignal;
}

export class VercelTerminalShellError extends Error {
  readonly code = 'terminal_shell_setup_failed';

  constructor(message: string) {
    super(message);
    this.name = 'VercelTerminalShellError';
  }
}

export async function prepareVercelTerminalShell(
  options: PrepareVercelTerminalShellOptions,
): Promise<VercelTerminalShell> {
  let sessionId = currentVercelSessionId(options.sandbox);
  if (sessionId === null) {
    throw new VercelTerminalShellError('Vercel current session ID is unavailable');
  }
  const signal = options.signal ?? AbortSignal.timeout(VERCEL_TERMINAL_SHELL_SETUP_TIMEOUT_MS);
  for (let attempt = 0; attempt < MAX_TMUX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const socketDirectory = `${DEVBOX_TMUX_SOCKET_ROOT}/${sessionDirectoryName(sessionId)}`;
    const result = await options.client.runCommand(options.sandbox, {
      cmd: 'sh',
      args: ['-c', reconciliationScript(socketDirectory)],
      signal,
    });
    if (result.exitCode !== 0) {
      throw new VercelTerminalShellError(
        `Vercel tmux socket reconciliation failed${await commandDetail(result)}`,
      );
    }
    const confirmedSessionId = currentVercelSessionId(options.sandbox);
    if (confirmedSessionId === null) {
      throw new VercelTerminalShellError('Vercel current session ID is unavailable');
    }
    if (confirmedSessionId !== sessionId) {
      sessionId = confirmedSessionId;
      continue;
    }
    const socketPath = `${socketDirectory}/socket`;
    return {
      socketDirectory,
      socketPath,
      sessionId,
      program: {
        command: 'tmux',
        args: [
          '-S',
          socketPath,
          'new-session',
          '-A',
          '-s',
          DEVBOX_TMUX_SESSION_NAME,
          '-c',
          options.cwd,
        ],
      },
    };
  }
  throw new VercelTerminalShellError('Vercel current session changed during tmux setup');
}

function sessionDirectoryName(sessionId: VercelSessionId): string {
  return `${DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX}${Buffer.from(sessionId, 'utf8').toString('base64url')}`;
}

function reconciliationScript(socketDirectory: string): string {
  const root = shellQuote(DEVBOX_TMUX_SOCKET_ROOT);
  const current = shellQuote(socketDirectory);
  return [
    'set -eu',
    `root=${root}`,
    `current=${current}`,
    'mkdir -p "$root"',
    `for directory in "$root"/${DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX}*; do`,
    '  [ -d "$directory" ] || continue',
    '  [ "$directory" = "$current" ] && continue',
    '  tmux -S "$directory/socket" kill-server >/dev/null 2>&1 || true',
    '  rm -rf -- "$directory"',
    'done',
    'mkdir -p "$current"',
    'chmod 700 "$root" "$current"',
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function commandDetail(result: VercelCommandResult): Promise<string> {
  if (!result.stdout) return '';
  try {
    const output = (await result.stdout()).replace(/\s+/g, ' ').trim().slice(0, 160);
    return output ? `: ${output}` : '';
  } catch {
    return '';
  }
}
