/**
 * Remote-only app-port scan.
 *
 * The remote-first contract means local dirty or unpushed files never decide
 * what gets exposed, so the scan runs inside the Sandbox against the checked
 * out tree. It reads two things and nothing else: the checkout's exact
 * revision, and a size-bounded copy of the repository root `package.json`.
 * Neither the file nor any command output is ever printed -- the text is
 * handed straight to the bounded detector, which returns structured candidates.
 */
import {
  detectAppPorts,
  MAX_PACKAGE_JSON_BYTES,
  type AppPortDetection,
} from './app-ports.js';
import { redactSecrets } from './redaction.js';
import type { VercelSandboxClient, VercelSandboxHandle } from './client.js';

/** Exit code the scan script uses for "the repository has no root package.json". */
const NO_PACKAGE_JSON_EXIT_CODE = 42;

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
    const head = await runScan(options, ['rev-parse', 'HEAD'], 'git');
    const trimmed = head.stdout.trim();
    if (head.exitCode === 0 && REVISION_PATTERN.test(trimmed)) revision = trimmed;
  } catch (error) {
    warnings.push(`remote revision could not be read: ${scanFailure(error, secrets)}`);
  }
  if (revision === undefined && warnings.length === 0) {
    warnings.push('remote checkout revision could not be resolved; no app ports were inferred');
  }
  if (revision === undefined) {
    return { detection: detectAppPorts(null), warnings };
  }

  let packageJson: string | null = null;
  try {
    const read = await runScan(options, [
      '-c',
      `if [ -f ./package.json ]; then head -c ${MAX_PACKAGE_JSON_BYTES} ./package.json; `
      + `else exit ${NO_PACKAGE_JSON_EXIT_CODE}; fi`,
    ], 'sh');
    if (read.exitCode === NO_PACKAGE_JSON_EXIT_CODE) {
      packageJson = null;
    } else if (read.exitCode !== 0) {
      // The command's own output may echo repository content; report the code.
      warnings.push(`remote root package.json could not be read (exit code ${read.exitCode})`);
    } else {
      packageJson = read.stdout;
    }
  } catch (error) {
    warnings.push(`remote root package.json could not be read: ${scanFailure(error, secrets)}`);
  }

  const detection = detectAppPorts(packageJson);
  return { revision, detection, warnings: [...warnings, ...detection.warnings] };
}

async function runScan(
  options: AppPortScanOptions,
  args: string[],
  cmd: string,
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
