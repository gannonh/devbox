/**
 * Detect the package manager from the lockfile present in a directory.
 *
 * Priority: bun > pnpm > npm > none.
 * This mirrors the provision.sh lockfile detection logic.
 */

export type PackageManager = 'bun' | 'pnpm' | 'npm' | 'none';

/**
 * Detect the package manager from a list of filenames.
 * @param files Filenames in the directory (basename only, not full paths).
 * @returns The detected package manager, or 'none'.
 */
export function detectPackageManager(files: string[]): PackageManager {
  if (files.includes('bun.lock')) return 'bun';
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('package-lock.json')) return 'npm';
  return 'none';
}
