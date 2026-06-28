/**
 * Resolve the repo root by walking up from cwd to find a .git directory.
 * Returns the directory containing .git, or null if not in a git repo.
 */
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function repoName(root: string): string {
  return basename(root);
}
