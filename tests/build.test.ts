import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const obsoletePaths = [
  'dist/commands/attach.',
  'dist/commands/list.',
  'dist/commands/rm.',
  'dist/commands/stop.',
  'dist/commands/up.',
  'dist/commands/url.',
  'dist/lib/context.',
  'dist/lib/docker.',
  'dist/lib/env.',
  'dist/lib/worktree.',
];

function packageFiles(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const metadata = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  return metadata[0]?.files.map((file) => file.path) ?? [];
}

describe('package build artifacts', () => {
  it('cleans obsolete dist paths before packaging', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.build).toMatch(/clean/);
    expect(packageJson.scripts?.prepack).toContain('build');

    const files = packageFiles();
    for (const obsoletePath of obsoletePaths) {
      expect(files.some((file) => file.startsWith(obsoletePath))).toBe(false);
    }
  });
});
