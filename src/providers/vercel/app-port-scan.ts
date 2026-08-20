/**
 * Remote-only app-port scan.
 *
 * The remote-first contract means local dirty or unpushed files never decide
 * what gets exposed, so the scan runs inside the Sandbox against the checked
 * out tree. It reads the checkout's exact revision, the repository root
 * `package.json`, the workspace declaration if there is one, and the
 * `package.json` of each declared workspace member. Nothing is executed and
 * nothing is printed -- the text goes straight to the bounded detector, which
 * returns structured candidates.
 *
 * Monorepos are the reason members are read at all: a Turborepo or pnpm
 * workspace keeps its root manifest as a task-runner shell (`dev: turbo dev`)
 * and the actual app one level down, so a root-only scan sees nothing.
 */
import {
  detectAppPorts,
  parseWorkspacePatterns,
  MAX_PACKAGE_JSON_BYTES,
  MAX_WORKSPACE_MANIFESTS,
  ROOT_MANIFEST_PATH,
  type AppPortDetection,
  type PackageManifest,
} from './app-ports.js';
import { redactSecrets } from './redaction.js';
import type { VercelSandboxClient, VercelSandboxHandle } from './client.js';

/**
 * Record and unit separators frame the emitted files. Valid JSON cannot contain
 * either byte unescaped, so no manifest can forge a record boundary.
 */
const RECORD_SEPARATOR = '\x1e';
const UNIT_SEPARATOR = '\x1f';

export interface AppPortScanOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  /** Repository working directory inside the Sandbox. */
  workspace: string;
  secrets?: readonly string[];
  signal?: AbortSignal;
}

export interface AppPortScanResult {
  /** Exact `git rev-parse HEAD` of the remote checkout, when it could be read. */
  revision?: string;
  detection: AppPortDetection;
  /** Workspace member paths whose manifests were read. */
  workspaces: string[];
  /** Bounded, content-free notices safe to print. */
  warnings: string[];
}

const REVISION_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Scan the remote checkout for app-port candidates.
 *
 * A scan failure is never fatal: the Sandbox is already up and usable with
 * noVNC and explicit configured ports, so a failure downgrades to a warning
 * and an empty candidate set.
 */
export async function scanRemoteAppPorts(
  options: AppPortScanOptions,
): Promise<AppPortScanResult> {
  const secrets = options.secrets ?? [];
  const warnings: string[] = [];
  let revision: string | undefined;
  try {
    const head = await runScan(options, 'git', ['rev-parse', 'HEAD']);
    const trimmed = head.stdout.trim();
    if (head.exitCode === 0 && REVISION_PATTERN.test(trimmed)) revision = trimmed;
  } catch (error) {
    warnings.push(`remote revision could not be read: ${scanFailure(error, secrets)}`);
  }
  if (revision === undefined && warnings.length === 0) {
    warnings.push('remote checkout revision could not be resolved; no app ports were inferred');
  }
  if (revision === undefined) {
    return { detection: detectAppPorts([]), workspaces: [], warnings };
  }

  let root: string | null = null;
  let pnpmWorkspace: string | null = null;
  try {
    const read = await runScan(options, 'sh', [
      '-c',
      `${emitFile('./package.json')}; ${emitFile('./pnpm-workspace.yaml')}`,
    ]);
    const files = parseEmittedFiles(read.stdout);
    root = files.get('./package.json') ?? null;
    pnpmWorkspace = files.get('./pnpm-workspace.yaml') ?? null;
  } catch (error) {
    warnings.push(`remote root package.json could not be read: ${scanFailure(error, secrets)}`);
  }

  const manifests: PackageManifest[] = [{ path: ROOT_MANIFEST_PATH, content: root }];
  const patterns = parseWorkspacePatterns(root, pnpmWorkspace);
  const members: string[] = [];
  if (patterns.length > 0) {
    try {
      const read = await runScan(options, 'sh', ['-c', emitWorkspaceManifests(patterns)]);
      let truncated = false;
      for (const [path, content] of parseEmittedFiles(read.stdout)) {
        if (members.length >= MAX_WORKSPACE_MANIFESTS) {
          truncated = true;
          break;
        }
        const member = path.replace(/^\.\//, '').replace(/\/package\.json$/, '');
        members.push(member);
        manifests.push({ path: member, content });
      }
      if (truncated) {
        warnings.push(`more than ${MAX_WORKSPACE_MANIFESTS} workspace manifests were found; the rest were skipped`);
      }
    } catch (error) {
      warnings.push(`remote workspace manifests could not be read: ${scanFailure(error, secrets)}`);
    }
  }

  const detection = detectAppPorts(manifests);
  return {
    revision,
    detection,
    workspaces: members,
    warnings: [...warnings, ...detection.warnings],
  };
}

/** Emit one `path<US>contents<RS>` record for a file, or nothing when absent. */
function emitFile(path: string): string {
  return `if [ -f ${path} ]; then printf '%s\\037' '${path}'; `
    + `head -c ${MAX_PACKAGE_JSON_BYTES} ${path}; printf '\\036'; fi`;
}

/**
 * Expand the validated workspace patterns and emit each member manifest.
 *
 * The patterns reach here through `parseWorkspacePatterns`, which admits only
 * literal path segments and a single trailing `/*`, so they carry no shell
 * metacharacter other than that wildcard.
 */
function emitWorkspaceManifests(patterns: readonly string[]): string {
  const globs = patterns.map((pattern) => `./${pattern}/package.json`).join(' ');
  return `for f in ${globs}; do [ -f "$f" ] || continue; `
    + `printf '%s\\037' "$f"; head -c ${MAX_PACKAGE_JSON_BYTES} "$f"; printf '\\036'; done`;
}

function parseEmittedFiles(stdout: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const separator = record.indexOf(UNIT_SEPARATOR);
    if (separator < 0) continue;
    files.set(record.slice(0, separator), record.slice(separator + 1));
  }
  return files;
}

async function runScan(
  options: AppPortScanOptions,
  cmd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const result = await options.client.runCommand(options.sandbox, {
    cmd,
    args,
    cwd: options.workspace,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const stdout = result.stdout
    ? await result.stdout(options.signal === undefined ? undefined : { signal: options.signal })
    : '';
  return { exitCode: result.exitCode ?? 0, stdout };
}

/** Keep failures short, secret-free, and free of repository content. */
function scanFailure(error: unknown, secrets: readonly string[]): string {
  return redactSecrets(error, secrets).replace(/\s+/g, ' ').trim().slice(0, 200);
}
