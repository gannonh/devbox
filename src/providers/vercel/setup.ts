import type {
  VercelSandboxClient,
  VercelSandboxHandle,
} from './client.js';

export const SETUP_DIRECTORY = '/vercel/.devbox/runtime';
export const SETUP_SCRIPT_PATH = `${SETUP_DIRECTORY}/setup.sh`;
export const SETUP_STATUS_PATH = `${SETUP_DIRECTORY}/setup.status`;
export const SETUP_LOG_PATH = `${SETUP_DIRECTORY}/setup.log`;
export const SETUP_PID_PATH = `${SETUP_DIRECTORY}/setup.pid`;

export type VercelSetupState = 'running' | 'succeeded' | 'failed';

export interface VercelSetupStatus {
  status: VercelSetupState;
  startedAt: number;
  finishedAt: number | null;
  failedStep?: string;
}

export interface LaunchBackgroundSetupOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  workspace: string;
  signal?: AbortSignal;
}

export type SetupLaunchDecision = 'start' | 'skip-running' | 'skip-succeeded';

export function decideSetupLaunch(
  status: VercelSetupStatus | null,
  processLive: boolean,
): SetupLaunchDecision {
  if (status?.status === 'succeeded') return 'skip-succeeded';
  if (status?.status === 'running' && processLive) return 'skip-running';
  return 'start';
}

export function parseSetupStatus(content: string): VercelSetupStatus | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value)) return null;
    const status = value.status;
    const startedAt = value.startedAt;
    const finishedAt = value.finishedAt;
    if (
      (status !== 'running' && status !== 'succeeded' && status !== 'failed')
      || !isEpoch(startedAt)
      || (status === 'running' ? finishedAt !== null : !isEpoch(finishedAt))
      || (typeof finishedAt === 'number' && finishedAt < startedAt)
    ) return null;
    const failedStep = value.failedStep;
    if (status === 'failed' && (typeof failedStep !== 'string' || failedStep.length === 0)) return null;
    const normalizedFinishedAt = status === 'running' ? null : finishedAt as number;
    return {
      status,
      startedAt,
      finishedAt: normalizedFinishedAt,
      ...(status === 'failed' ? { failedStep: failedStep as string } : {}),
    };
  } catch {
    return null;
  }
}

export async function readSetupStatus(
  options: Pick<LaunchBackgroundSetupOptions, 'sandbox' | 'client' | 'signal'>,
): Promise<VercelSetupStatus | null> {
  const result = await options.client.runCommand(options.sandbox, {
    cmd: 'cat',
    args: [SETUP_STATUS_PATH],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.exitCode !== 0 || !result.stdout) return null;
  return parseSetupStatus(await result.stdout(options.signal === undefined ? undefined : { signal: options.signal }));
}

export async function isSetupProcessLive(
  options: Pick<LaunchBackgroundSetupOptions, 'sandbox' | 'client' | 'signal'>,
): Promise<boolean> {
  const result = await options.client.runCommand(options.sandbox, {
    cmd: 'sh',
    args: [
      '-c',
      `pid=$(cat ${SETUP_PID_PATH} 2>/dev/null || true); `
        + 'case "$pid" in ""|0|*[!0-9]*) exit 1 ;; esac; kill -0 "$pid" 2>/dev/null',
    ],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return result.exitCode === 0;
}

export async function launchBackgroundSetup(
  options: LaunchBackgroundSetupOptions,
): Promise<VercelSetupStatus | null> {
  const status = await readSetupStatus(options);
  const processLive = status?.status === 'running' ? await isSetupProcessLive(options) : false;
  const decision = decideSetupLaunch(status, processLive);
  if (decision !== 'start') return status;

  await options.client.writeFiles(
    options.sandbox,
    [{
      path: SETUP_SCRIPT_PATH,
      content: Buffer.from(renderSetupScript(options.workspace)),
      mode: 0o755,
    }],
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  const launch = await options.client.runCommand(options.sandbox, {
    cmd: 'bash',
    args: [SETUP_SCRIPT_PATH],
    cwd: options.workspace,
    detached: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (typeof launch.exitCode === 'number' && launch.exitCode !== 0) {
    throw new Error(`background setup launch failed with exit code ${launch.exitCode}`);
  }
  return {
    status: 'running',
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
  };
}

export function renderSetupNotice(status: VercelSetupStatus | null): string {
  if (status?.status === 'running') return `setup running; log: ${SETUP_LOG_PATH}`;
  if (status?.status === 'failed') {
    return `setup failed; log: ${SETUP_LOG_PATH}\nsetup retry: bash ${SETUP_SCRIPT_PATH}`;
  }
  return '';
}

export function renderSetupScript(workspace: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -u',
    'umask 077',
    `DIRECTORY=${quoteShell(SETUP_DIRECTORY)}`,
    `STATUS=${quoteShell(SETUP_STATUS_PATH)}`,
    `LOG=${quoteShell(SETUP_LOG_PATH)}`,
    `PID=${quoteShell(SETUP_PID_PATH)}`,
    `cd ${quoteShell(workspace)} || exit 1`,
    'mkdir -p "${DIRECTORY}" || exit 1',
    'chmod 700 "${DIRECTORY}" || exit 1',
    'touch "${LOG}" || exit 1',
    'chmod 600 "${LOG}" || exit 1',
    '',
    'now() { date +%s; }',
    '',
    'write_status() {',
    '  local state="$1"',
    '  local started="$2"',
    '  local finished="$3"',
    '  local step="${4:-}"',
    '  if [[ "${finished}" != "null" ]] && (( finished < started )); then finished="${started}"; fi',
    '  local tmp="${STATUS}.$$"',
    '  if [[ -n "${step}" ]]; then',
    '    printf \'{"status":"%s","startedAt":%s,"finishedAt":%s,"failedStep":"%s"}\\n\' "${state}" "${started}" "${finished}" "${step}" > "${tmp}" || return 1',
    '  else',
    '    printf \'{"status":"%s","startedAt":%s,"finishedAt":%s}\\n\' "${state}" "${started}" "${finished}" > "${tmp}" || return 1',
    '  fi',
    '  chmod 600 "${tmp}" || return 1',
    '  mv -f "${tmp}" "${STATUS}" || return 1',
    '}',
    '',
    'write_private_value() {',
    '  local path="$1"',
    '  local value="$2"',
    '  local tmp="${path}.$$"',
    '  printf \'%s\\n\' "${value}" > "${tmp}" || return 1',
    '  chmod 600 "${tmp}" || return 1',
    '  mv -f "${tmp}" "${path}" || return 1',
    '}',
    '',
    'fail_setup() {',
    '  rm -f "${PID}" || true',
    '  exit 1',
    '}',
    '',
    'fail_step() {',
    '  local step="$1"',
    '  if ! write_status failed "${started}" "$(now)" "${step}"; then fail_setup; fi',
    '  rm -f "${PID}" || true',
    '  exit 1',
    '}',
    '',
    'pid_is_live() {',
    '  local pid="${1:-}"',
    '  case "${pid}" in',
    '    ""|0|*[!0-9]*) return 1 ;;',
    '  esac',
    '  kill -0 "${pid}" 2>/dev/null',
    '}',
    '',
    'is_epoch() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }',
    '',
    'read_status() {',
    '  status=""',
    '  [[ -r "${STATUS}" ]] || return 0',
    '  local status_started="$(jq -r \'.startedAt // empty\' "${STATUS}" 2>/dev/null || true)"',
    '  local status_finished="$(jq -r \'if has("finishedAt") then (.finishedAt | if . == null then "null" else tostring end) else "missing" end\' "${STATUS}" 2>/dev/null || true)"',
    '  status="$(jq -r \'.status // empty\' "${STATUS}" 2>/dev/null || true)"',
    '  if ! is_epoch "${status_started}"; then status=""; return 0; fi',
    '  case "${status}" in',
    '    running) [[ "${status_finished}" == "null" ]] || status="" ;;',
    '    succeeded|failed)',
    '      if ! is_epoch "${status_finished}" || (( status_finished < status_started )); then status=""; return 0; fi',
    '      if [[ "${status}" == "failed" ]] && { [[ "$(jq -r \'.failedStep | type\' "${STATUS}" 2>/dev/null || true)" != "string" ]] || [[ -z "$(jq -r \'.failedStep // empty\' "${STATUS}" 2>/dev/null || true)" ]]; }; then status=""; fi',
    '      ;;',
    '    *) status="" ;;',
    '  esac',
    '}',
    '',
    'read_status',
    'if [[ "${status}" == "succeeded" ]]; then exit 0; fi',
    'if [[ "${status}" == "running" ]] && pid_is_live "$(cat "${PID}" 2>/dev/null || true)"; then exit 0; fi',
    '',
    'exec 200>"${DIRECTORY}/setup.lock" || exit 1',
    'if ! flock -n 200; then exit 0; fi',
    '',
    'read_status',
    'if [[ "${status}" == "succeeded" ]]; then exit 0; fi',
    'if [[ "${status}" == "running" ]] && pid_is_live "$(cat "${PID}" 2>/dev/null || true)"; then exit 0; fi',
    '',
    'started="$(now)"',
    'if ! write_status running "${started}" null; then fail_setup; fi',
    'if ! write_private_value "${PID}" "$$"; then fail_setup; fi',
    'exec >>"${LOG}" 2>&1 || fail_setup',
    '',
    'log() { printf \'[setup] %s\\n\' "$*"; }',
    'failed_step=""',
    'record_warning() {',
    '  local step="$1"',
    '  shift',
    '  log "warn: $*"',
    '  if [[ -z "${failed_step}" ]]; then failed_step="${step}"; fi',
    '}',
    '',
    'if [[ -f bun.lock && ! -d node_modules/bun ]]; then',
    '  log "bun install"',
    '  if ! bun install; then fail_step dependencies; fi',
    'elif [[ -f bun.lock ]]; then',
    '  log "node_modules present, skipping bun install"',
    'elif [[ -f pnpm-lock.yaml && ! -d node_modules/.pnpm ]]; then',
    '  log "pnpm install"',
    '  if ! pnpm install --frozen-lockfile; then fail_step dependencies; fi',
    'elif [[ -f package-lock.json && ! -f node_modules/.package-lock.json ]]; then',
    '  log "npm ci"',
    '  if ! npm ci; then fail_step dependencies; fi',
    'fi',
    '',
    'if [[ -f package.json ]] && grep -q \'"ensure:electron"\' package.json; then',
    '  log "ensuring Electron runtime"',
    '  if ! bun run ensure:electron; then',
    '    record_warning ensure:electron "ensure:electron failed (Electron GUI may not launch)"',
    '  fi',
    'fi',
    '',
    'SETTINGS="${HOME}/.pi/agent/settings.json"',
    'if [[ -f "${SETTINGS}" ]] && command -v pi >/dev/null 2>&1; then',
    '  specs=()',
    '  while IFS= read -r spec; do',
    '    [[ -n "${spec}" ]] && specs+=("${spec}")',
    '  done < <(jq -r \'.packages[]?\' "${SETTINGS}" 2>/dev/null || true)',
    '  if [[ "${#specs[@]}" -gt 0 ]]; then',
    '    log "reinstalling ${#specs[@]} Pi extensions"',
    '    for spec in "${specs[@]}"; do',
    '      [[ -z "${spec}" ]] && continue',
    '      log "  pi install ${spec}"',
    '      if ! pi install "${spec}" --approve; then',
    '        record_warning pi-extension "failed to install ${spec} (see setup log)"',
    '      fi',
    '    done',
    '  fi',
    'fi',
    '',
    'if [[ -x .devbox/post-create.sh ]]; then',
    '  log "running .devbox/post-create.sh"',
    '  if ! bash .devbox/post-create.sh; then',
    '    record_warning post-create "post-create.sh exited non-zero"',
    '  fi',
    'fi',
    '',
    'if [[ -n "${failed_step}" ]]; then fail_step "${failed_step}"; fi',
    'if ! write_status succeeded "${started}" "$(now)"; then fail_setup; fi',
    'rm -f "${PID}" || true',
    '',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
