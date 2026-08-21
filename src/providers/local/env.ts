/**
 * Parse an explicitly selected dotenv file and resolve the GitHub token.
 *
 * GH_TOKEN: explicit GH_TOKEN, else GITHUB_TOKEN, else `gh auth token`
 */
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import type { ShellRunner } from '../../lib/shell.js';

export class EnvironmentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentFileError';
  }
}

/** Read a dotenv file without exposing its contents in errors or output. */
export async function readEnvironmentFile(path: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EnvironmentFileError(`unable to read env file ${path}: ${detail}`);
  }

  return Object.fromEntries(
    Object.entries(parseEnv(content)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * Resolve the GitHub token for forwarding into the container.
 * Priority: GH_TOKEN > GITHUB_TOKEN > `gh auth token`
 * @returns The token string, or empty string if none available.
 */
export async function resolveGhToken(
  env: Record<string, string | undefined>,
  runner: ShellRunner,
  ghAvailable: () => boolean | Promise<boolean>,
): Promise<string> {
  const explicit = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (explicit) return explicit;

  if (!await ghAvailable()) return '';

  try {
    const token = await runner.exec('gh', ['auth', 'token'], { silentStderr: true });
    return token;
  } catch {
    // gh auth token failed (network, config, etc.). Return empty; caller warns.
    // We don't die here because explicit tokens or GITHUB_TOKEN may still work.
    return '';
  }
}