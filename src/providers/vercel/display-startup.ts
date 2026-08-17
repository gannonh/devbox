import {
  DISPLAY_USERNAME,
  clearDisplayCredentialRotation,
  getDisplayCredentials,
} from './display-credentials.js';
import {
  DEVBOX_NOVNC_INTERNAL_PORT,
  DEVBOX_NOVNC_PROXY_PORT,
} from './ports.js';
import { redactSecrets } from './redaction.js';
import type {
  VercelCommandResult,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
} from './client.js';
import type { VercelBranchMetadataStore } from './metadata.js';

export const DISPLAY_STARTUP_TIMEOUT_MS = 30_000;

const DISPLAY_START_COMMAND = '/usr/local/bin/devbox-start';
const DISPLAY_STATUS_COMMAND = '/usr/local/bin/devbox-status';
const DISPLAY_SERVICE_NAMES = 'auth-proxy websockify x11vnc fluxbox xvfb';
const DISPLAY_SERVICE_RESET_SCRIPT = [
  'pid_dir="${DEVBOX_PID_DIR:-${TMPDIR:-/tmp}/devbox}"',
  `services="${DISPLAY_SERVICE_NAMES}"`,
  'for service in ${services}; do',
  '  pid_file="${pid_dir}/${service}.pid"',
  '  if [ -r "${pid_file}" ]; then',
  '    pid="$(cat "${pid_file}" 2>/dev/null || true)"',
  '    case "${pid}" in',
  '      ""|*[!0-9]*) ;;',
  '      *) kill -TERM "${pid}" 2>/dev/null || true; kill -KILL "${pid}" 2>/dev/null || true ;;',
  '    esac',
  '  fi',
  'done',
  'for attempt in $(seq 1 50); do',
  '  remaining=0',
  '  for service in ${services}; do',
  '    pid_file="${pid_dir}/${service}.pid"',
  '    if [ -r "${pid_file}" ]; then',
  '      pid="$(cat "${pid_file}" 2>/dev/null || true)"',
  '      case "${pid}" in',
  '        ""|*[!0-9]*) ;;',
  '        *) if kill -0 "${pid}" 2>/dev/null; then remaining=1; fi ;;',
  '      esac',
  '    fi',
  '  done',
  '  if [ "${remaining}" -eq 0 ]; then break; fi',
  '  sleep 0.1',
  'done',
  'display="${DISPLAY:-:99}"',
  'display_number="${display##*:}"',
  'display_number="${display_number%%.*}"',
  'tmp_dir="${TMPDIR:-/tmp}"',
  'rm -f "${tmp_dir}/.X11-unix/X${display_number}" "${tmp_dir}/.X${display_number}-lock"',
  'for service in ${services}; do',
  '  rm -f "${pid_dir}/${service}.pid"',
  'done',
].join('\n');
const REQUIRED_SERVICES = ['Xvfb', 'fluxbox', 'x11vnc', 'websockify', 'auth-proxy'] as const;

export interface DisplayStartupOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  store: VercelBranchMetadataStore;
  secrets: string[];
  signal?: AbortSignal;
}

export class VercelDisplayStartupError extends Error {
  readonly code = 'display_startup_failed';

  constructor(message: string) {
    super(message);
    this.name = 'VercelDisplayStartupError';
  }
}

export async function startDisplayStack(options: DisplayStartupOptions): Promise<void> {
  const resolution = await getDisplayCredentials(options.store);
  addSecret(options.secrets, resolution.credentials.password);

  if (resolution.generated) {
    const reset = await runCommand(options, {
      cmd: 'sh',
      args: ['-c', DISPLAY_SERVICE_RESET_SCRIPT],
    }, 'display service reset');
    if (reset.exitCode !== 0) {
      throw startupError(
        `display service reset failed${reset.output ? `: ${reset.output}` : ` with exit code ${reset.exitCode}`}`,
        options.secrets,
      );
    }
  }

  const start = await runCommand(options, {
    cmd: DISPLAY_START_COMMAND,
    env: {
      DEVBOX_NOVNC_USER: DISPLAY_USERNAME,
      DEVBOX_NOVNC_PASSWORD: resolution.credentials.password,
      // The image defaults put unauthenticated websockify on 6080 and the
      // authenticated proxy on 6081; swap them so only the proxy is public.
      DEVBOX_NOVNC_PORT: String(DEVBOX_NOVNC_PROXY_PORT),
      DEVBOX_NOVNC_INTERNAL_PORT: String(DEVBOX_NOVNC_INTERNAL_PORT),
    },
  }, 'display startup');
  if (start.exitCode !== 0) {
    throw startupError(
      `display startup failed${start.output ? `: ${start.output}` : ` with exit code ${start.exitCode}`}`,
      options.secrets,
    );
  }

  const status = await runCommand(options, { cmd: DISPLAY_STATUS_COMMAND }, 'display status');
  const missing = REQUIRED_SERVICES.filter((service) => !hasRunningService(status.output, service));
  if (status.exitCode !== 0 || missing.length > 0) {
    const detail = missing.length > 0
      ? `services not running: ${missing.join(', ')}`
      : `status exited with code ${status.exitCode}`;
    throw startupError(
      `display readiness failed; ${detail}${status.output ? `; status: ${status.output}` : ''}`,
      options.secrets,
    );
  }

  if (resolution.generated) {
    try {
      await clearDisplayCredentialRotation(options.store, resolution.credentials);
    } catch (error) {
      throw startupError(
        `display credential rotation finalization failed: ${redactSecrets(error, options.secrets)}`,
        options.secrets,
      );
    }
  }
}

async function runCommand(
  options: DisplayStartupOptions,
  request: VercelRunCommandRequest,
  operation: string,
): Promise<{ exitCode: number; output: string }> {
  let result: VercelCommandResult;
  try {
    result = await options.client.runCommand(options.sandbox, {
      ...request,
      timeoutMs: DISPLAY_STARTUP_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw startupError(`${operation} command failed: ${redactSecrets(error, options.secrets)}`, options.secrets);
  }
  let output: string;
  try {
    output = await commandOutput(result, options.signal, options.secrets);
  } catch (error) {
    throw startupError(`${operation} output failed: ${redactSecrets(error, options.secrets)}`, options.secrets);
  }
  return { exitCode: result.exitCode, output };
}

async function commandOutput(
  result: VercelCommandResult,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<string> {
  const output: string[] = [];
  if (result.stdout) output.push(await result.stdout(signal === undefined ? undefined : { signal }));
  if (result.stderr) output.push(await result.stderr(signal === undefined ? undefined : { signal }));
  return redactSecrets(output.join('\n').trim(), secrets);
}

function hasRunningService(output: string, service: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === `[devbox-status] ${service}=running`);
}

function startupError(message: string, secrets: readonly string[]): VercelDisplayStartupError {
  return new VercelDisplayStartupError(redactSecrets(message, secrets));
}

function addSecret(secrets: string[], value: string): void {
  if (!secrets.includes(value)) secrets.push(value);
}
