import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  clearDisplayCredentialRotation,
  getDisplayCredentials,
} from './display-credentials.js';
import {
  DEVBOX_NOVNC_INTERNAL_PORT,
  DEVBOX_NOVNC_PROXY_PORT,
} from './ports.js';
import { addSecrets, redactSecrets } from './redaction.js';
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
const DISPLAY_PROXY_OVERLAY_PATH = '/vercel/.devbox/runtime/novnc-proxy.mjs';
const DISPLAY_PROXY_IMAGE_PATH = '/usr/local/lib/devbox/basic-auth-proxy.mjs';
const DISPLAY_PROXY_SOURCE = fileURLToPath(new URL('../../../images/vercel/basic-auth-proxy.mjs', import.meta.url));
const DISPLAY_PROXY_INSTALL_SCRIPT = [
  `cp '${DISPLAY_PROXY_OVERLAY_PATH}' '${DISPLAY_PROXY_IMAGE_PATH}'`,
].join('\n');
const DISPLAY_SERVICE_NAMES = 'auth-proxy websockify x11vnc fluxbox xvfb';
const DISPLAY_SERVICE_RESET_SCRIPT = [
  'pid_dir="${DEVBOX_PID_DIR:-${TMPDIR:-/tmp}/devbox}"',
  `services="${DISPLAY_SERVICE_NAMES}"`,
  'proc_start_time() {',
  '  stat_line="$(cat "/proc/$1/stat" 2>/dev/null || true)"',
  '  stat_line="${stat_line##*) }"',
  '  set -- ${stat_line}',
  '  printf "%s\\n" "${20:-}"',
  '}',
  'expected_command() {',
  '  case "$1" in',
  '    xvfb) printf "%s\\n" Xvfb ;;',
  '    fluxbox) printf "%s\\n" fluxbox ;;',
  '    x11vnc) printf "%s\\n" x11vnc ;;',
  '    websockify) printf "%s\\n" websockify ;;',
  '    auth-proxy) printf "%s\\n" basic-auth-proxy.mjs ;;',
  '    *) return 1 ;;',
  '  esac',
  '}',
  'process_matches() {',
  '  pid="$1"',
  '  started="$2"',
  '  expected="$3"',
  '  [ -n "${pid}" ] && [ -n "${started}" ] && [ -n "${expected}" ] || return 1',
  '  [ "$(proc_start_time "${pid}")" = "${started}" ] || return 1',
  '  command_line="$(tr "\\000" " " <"/proc/${pid}/cmdline" 2>/dev/null || true)"',
  '  case "${command_line}" in *"${expected}"*) ;; *) return 1 ;; esac',
  '  kill -0 "${pid}" 2>/dev/null',
  '}',
  'read_pid_record() {',
  '  pid=""',
  '  started=""',
  '  recorded=""',
  '  IFS=" " read -r pid started recorded <"$1" || true',
  '}',
  'stop_service() {',
  '  service="$1"',
  '  pid_file="${pid_dir}/${service}.pid"',
  '  [ -r "${pid_file}" ] || return 0',
  '  read_pid_record "${pid_file}"',
  '  expected="$(expected_command "${service}" || true)"',
  '  if [ "${recorded}" = "${expected}" ] && process_matches "${pid}" "${started}" "${expected}"; then',
  '    kill -TERM "${pid}" 2>/dev/null || true',
  '    kill -KILL "${pid}" 2>/dev/null || true',
  '  else',
  '    rm -f "${pid_file}"',
  '  fi',
  '}',
  'for service in ${services}; do stop_service "${service}"; done',
  'for attempt in $(seq 1 50); do',
  '  remaining=0',
  '  for service in ${services}; do',
  '    pid_file="${pid_dir}/${service}.pid"',
  '    if [ -r "${pid_file}" ]; then',
  '      read_pid_record "${pid_file}"',
  '      expected="$(expected_command "${service}" || true)"',
  '      if [ "${recorded}" = "${expected}" ] && process_matches "${pid}" "${started}" "${expected}"; then remaining=1; fi',
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
  addSecrets(options.secrets, resolution.credentials.password);

  try {
    await options.client.writeFiles(
      options.sandbox,
      [{ path: DISPLAY_PROXY_OVERLAY_PATH, content: await readFile(DISPLAY_PROXY_SOURCE), mode: 0o755 }],
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    throw startupError(`display proxy overlay failed: ${redactSecrets(error, options.secrets)}`, options.secrets);
  }
  const install = await runCommand(options, {
    cmd: 'sudo',
    args: ['-n', 'sh', '-c', DISPLAY_PROXY_INSTALL_SCRIPT],
  }, 'display proxy install');
  if (install.exitCode !== 0) {
    throw startupError(
      `display proxy install failed${install.output ? `: ${install.output}` : ` with exit code ${install.exitCode}`}`,
      options.secrets,
    );
  }

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
      DEVBOX_NOVNC_PASSWORD: resolution.credentials.password,
      // Keep the authenticated proxy on public 6080 and websockify on private 6081.
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
  return { exitCode: result.exitCode ?? -1, output };
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
