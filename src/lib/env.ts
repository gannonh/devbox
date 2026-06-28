/**
 * Environment resolution for DEVBOX_ENV and GH_TOKEN.
 *
 * DEVBOX_ENV: explicit env var, else $HOME/dotfiles/repos/<repoName>/.env
 * GH_TOKEN: explicit GH_TOKEN, else GITHUB_TOKEN, else `gh auth token`
 */
import { basename } from 'node:path';
import type { ShellRunner } from './shell.js';

/**
 * Resolve the .env file path for the repo.
 * Priority: DEVBOX_ENV env var > $HOME/dotfiles/repos/<repoName>/.env
 */
export function resolveDevboxEnv(
  repoRoot: string,
  env: Record<string, string | undefined>,
  home: string = process.env.HOME ?? '',
): string {
  if (env.DEVBOX_ENV) return env.DEVBOX_ENV;
  const repoName = basename(repoRoot);
  return `${home}/dotfiles/repos/${repoName}/.env`;
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
    return '';
  }
}
