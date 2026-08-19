import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

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

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('package build artifacts', () => {
  // A file the runtime opens relative to its own compiled location must be in
  // the published package, or the feature works from a checkout and fails only
  // once someone installs it -- which is how the display proxy overlay shipped
  // broken: images/ was never in `files`.
  it('publishes every file the runtime reads at run time', () => {
    const packaged = new Set(packageFiles());
    const roots = (JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] }).files;
    // Some runtime files are generated at publish time (the image pin), so the
    // requirement is that the path is covered by `files`, not that it exists
    // in a checkout.
    const isPublished = (target: string): boolean =>
      packaged.has(target) || roots.some((root) => target === root || target.startsWith(`${root}/`));
    const missing: string[] = [];

    for (const source of sourceFiles('src')) {
      const text = readFileSync(source, 'utf8');
      for (const match of text.matchAll(/new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/g)) {
        const reference = match[1];
        if (reference.startsWith('http')) continue;
        // The compiled file sits at the same subpath under dist/.
        const compiledDir = join('dist', relative('src', dirname(source)));
        const target = relative(process.cwd(), resolve(compiledDir, reference));
        if (!isPublished(target)) missing.push(`${source} -> ${target}`);
      }
    }

    expect(missing, `runtime reads paths that are not published: ${missing.join(', ')}`)
      .toEqual([]);
  });


  it('cleans obsolete dist paths before packaging', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.build).toMatch(/clean/);
    expect(packageJson.scripts?.prepack).toContain('build');

    const stalePath = join(process.cwd(), 'dist', 'commands', 'attach.js');
    mkdirSync(dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, '// stale build output\n');

    try {
      const files = packageFiles();
      expect(existsSync(stalePath)).toBe(false);
      for (const obsoletePath of obsoletePaths) {
        expect(files.some((file) => file.startsWith(obsoletePath))).toBe(false);
      }
    } finally {
      rmSync(stalePath, { force: true });
    }
  });
});
