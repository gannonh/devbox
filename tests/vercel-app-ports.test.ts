import { describe, expect, it } from 'vitest';
import {
  APP_PORT_DETECTOR_VERSION,
  detectAppPorts,
  describeAppPortCandidate,
  fingerprintAppPortCandidates,
  parseWorkspacePatterns,
  MAX_WORKSPACE_PATTERNS,
  NEXT_DEFAULT_PORT,
  ROOT_MANIFEST_PATH,
  VITE_DEFAULT_PORT,
  type PackageManifest,
} from '../src/providers/vercel/app-ports.js';

/** The root manifest alone, the shape most of these cases exercise. */
function rootOnly(value: Record<string, unknown>): PackageManifest[] {
  return [{ path: ROOT_MANIFEST_PATH, content: JSON.stringify(value) }];
}

function packageJson(value: Record<string, unknown>): PackageManifest[] {
  return rootOnly(value);
}

describe('bounded app port detector', () => {
  it('detects the conventional Vite port from a dependency alone', () => {
    const detection = detectAppPorts(packageJson({ devDependencies: { vite: '^5.0.0' } }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: '.' },
    ]);
    expect(detection.conflicting).toBe(false);
    expect(detection.warnings).toEqual([]);
  });

  it('detects the conventional Vite port from a bare dev script with no dependency', () => {
    const detection = detectAppPorts(packageJson({ scripts: { dev: 'vite' } }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: '.' },
    ]);
  });

  it('detects the conventional Next port from a dependency alone', () => {
    const detection = detectAppPorts(packageJson({ dependencies: { next: '15.0.0' } }));

    expect(detection.candidates).toEqual([
      { port: NEXT_DEFAULT_PORT, framework: 'next', source: 'framework-default', workspace: '.' },
    ]);
  });

  it.each([
    ['--port with a separate value', 'vite --port 4321'],
    ['--port= with an inline value', 'vite --port=4321'],
    ['-p with a separate value', 'vite -p 4321'],
    ['-pN with an inline value', 'vite -p4321'],
    ['PORT= as an environment assignment', 'PORT=4321 vite'],
    ['a port after other options', 'vite --host 0.0.0.0 --strictPort --port 4321'],
  ])('treats a literal port in the dev script as an override: %s', (_label, dev) => {
    const detection = detectAppPorts(packageJson({ devDependencies: { vite: '^5.0.0' }, scripts: { dev } }));

    expect(detection.candidates).toEqual([{ port: 4321, framework: 'vite', source: 'dev-script', workspace: '.' }]);
  });

  it('normalizes the Next -p forms against the Next default', () => {
    for (const dev of ['next dev -p 4000', 'next dev -p4000', 'PORT=4000 next dev']) {
      expect(detectAppPorts(packageJson({ dependencies: { next: '15.0.0' }, scripts: { dev } })).candidates)
        .toEqual([{ port: 4000, framework: 'next', source: 'dev-script', workspace: '.' }]);
    }
  });

  it('accepts a framework executable after npx', () => {
    const detection = detectAppPorts(packageJson({ scripts: { dev: 'npx vite --port 4444' } }));

    expect(detection.candidates).toEqual([{ port: 4444, framework: 'vite', source: 'dev-script', workspace: '.' }]);
  });

  it('reads a framework from a later command in a chained dev script', () => {
    const detection = detectAppPorts(packageJson({ scripts: { dev: 'npm run codegen && vite --port 4173' } }));

    expect(detection.candidates).toEqual([{ port: 4173, framework: 'vite', source: 'dev-script', workspace: '.' }]);
  });

  it('surfaces conflicting literal ports as labeled candidates instead of choosing one', () => {
    const detection = detectAppPorts(packageJson({
      dependencies: { next: '15.0.0' },
      scripts: { dev: 'PORT=4100 next dev -p 4200' },
    }));

    expect(detection.candidates).toEqual([
      { port: 4100, framework: 'next', source: 'dev-script', workspace: '.' },
      { port: 4200, framework: 'next', source: 'dev-script', workspace: '.' },
    ]);
    expect(detection.conflicting).toBe(true);
  });

  it.each([
    ['shell expansion', 'vite --port $PORT'],
    ['a double-quoted value', 'vite --port "4321"'],
    ['a single-quoted value', "vite --port '4321'"],
    ['a command substitution', 'vite --port `cat .port`'],
    ['a non-decimal value', 'vite --port auto'],
    ['a glued unrelated flag', 'vite --portable 4321'],
  ])('produces no inferred override for %s', (_label, dev) => {
    const detection = detectAppPorts(packageJson({ devDependencies: { vite: '^5.0.0' }, scripts: { dev } }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: '.' },
    ]);
    expect(detection.conflicting).toBe(false);
  });

  it('matches framework names on token boundaries only', () => {
    for (const value of [
      packageJson({ dependencies: { 'vite-plugin-thing': '^1.0.0', 'next-auth': '^5.0.0' } }),
      packageJson({ scripts: { dev: 'vitest --watch' } }),
      packageJson({ scripts: { dev: 'nextjs-cli dev' } }),
    ]) {
      expect(detectAppPorts(value).candidates).toEqual([]);
    }
  });

  it('never recurses into workspaces from the repository root', () => {
    const detection = detectAppPorts(packageJson({
      workspaces: ['apps/*'],
      devDependencies: { turbo: '^2.0.0' },
      scripts: { dev: 'turbo dev' },
    }));

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings).toEqual([]);
  });

  it('reads only dependencies, devDependencies, and scripts.dev', () => {
    const detection = detectAppPorts(packageJson({
      peerDependencies: { vite: '^5.0.0' },
      optionalDependencies: { next: '15.0.0' },
      scripts: { start: 'vite --port 4321', 'dev:web': 'next dev -p 4000' },
    }));

    expect(detection.candidates).toEqual([]);
  });

  it('ignores a non-string dev script', () => {
    expect(detectAppPorts(packageJson({ scripts: { dev: ['vite'] } })).candidates).toEqual([]);
  });

  it('yields no inferred ports when the root package.json is missing', () => {
    const detection = detectAppPorts([{ path: ROOT_MANIFEST_PATH, content: null }]);

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings).toEqual([]);
  });

  it('warns without failing and without echoing content for malformed JSON', () => {
    const detection = detectAppPorts([{ path: ROOT_MANIFEST_PATH, content: '{"scripts": {"dev": "vite --port 4321"' }]);

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain('not valid JSON');
    expect(detection.warnings[0]).not.toContain('vite');
    expect(detection.warnings[0]).not.toContain('4321');
  });

  it('warns without failing when the root package.json is not an object', () => {
    const detection = detectAppPorts([{ path: ROOT_MANIFEST_PATH, content: '["vite"]' }]);

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings[0]).toContain('not a JSON object');
  });

  it('attributes an unattached literal port to the sole detected framework', () => {
    const detection = detectAppPorts(packageJson({
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'node scripts/dev.mjs --port 4500' },
    }));

    expect(detection.candidates).toEqual([{ port: 4500, framework: 'vite', source: 'dev-script', workspace: '.' }]);
  });

  it('drops an unattached literal port when two frameworks are in play', () => {
    const detection = detectAppPorts(packageJson({
      dependencies: { next: '15.0.0' },
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'node scripts/dev.mjs --port 4500' },
    }));

    expect(detection.candidates).toEqual([
      { port: NEXT_DEFAULT_PORT, framework: 'next', source: 'framework-default', workspace: '.' },
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: '.' },
    ]);
  });

  it('rejects out-of-range literal ports rather than proposing them', () => {
    const detection = detectAppPorts(packageJson({
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'vite --port 99999' },
    }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: '.' },
    ]);
  });

  it('fingerprints the sorted candidate set together with the detector version', () => {
    const first = detectAppPorts(packageJson({
      dependencies: { next: '15.0.0' },
      devDependencies: { vite: '^5.0.0' },
    }));
    const reordered = fingerprintAppPortCandidates([...first.candidates].reverse());

    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(first.fingerprint);
    expect(first.fingerprint).not.toBe(fingerprintAppPortCandidates([]));
    expect(APP_PORT_DETECTOR_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('changes the fingerprint when a candidate port changes', () => {
    const original = detectAppPorts(packageJson({ devDependencies: { vite: '^5.0.0' } }));
    const changed = detectAppPorts(packageJson({
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'vite --port 4321' },
    }));

    expect(changed.fingerprint).not.toBe(original.fingerprint);
  });

  it('labels candidates without exposing script text', () => {
    expect(describeAppPortCandidate({ port: 5173, framework: 'vite', source: 'framework-default', workspace: '.' }))
      .toBe('vite default');
    expect(describeAppPortCandidate({ port: 4000, framework: 'next', source: 'dev-script', workspace: '.' }))
      .toBe('next dev script');
  });
});

describe('workspace-aware detection', () => {
  const TURBO_ROOT = JSON.stringify({
    scripts: { dev: 'turbo dev', build: 'turbo build' },
    devDependencies: { prettier: '^3.0.0', turbo: '^2.0.0', typescript: '~6' },
  });

  it('finds the app in a workspace member when the root is a task-runner shell', () => {
    const detection = detectAppPorts([
      { path: ROOT_MANIFEST_PATH, content: TURBO_ROOT },
      { path: 'apps/web', content: JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^8' } }) },
    ]);

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: 'apps/web' },
    ]);
    expect(detection.warnings).toEqual([]);
  });

  it('labels a workspace candidate with the path that disambiguates it', () => {
    expect(describeAppPortCandidate({
      port: 5173,
      framework: 'vite',
      source: 'framework-default',
      workspace: 'apps/web',
    })).toBe('vite default — apps/web');
  });

  it('offers one candidate per app in a multi-app monorepo', () => {
    const detection = detectAppPorts([
      { path: ROOT_MANIFEST_PATH, content: TURBO_ROOT },
      { path: 'apps/web', content: JSON.stringify({ devDependencies: { vite: '^8' } }) },
      { path: 'apps/docs', content: JSON.stringify({ dependencies: { next: '15' }, scripts: { dev: 'next dev -p 3001' } }) },
    ]);

    expect(detection.candidates).toEqual([
      { port: 3001, framework: 'next', source: 'dev-script', workspace: 'apps/docs' },
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: 'apps/web' },
    ]);
  });

  it('keeps a broken member from suppressing its siblings', () => {
    const detection = detectAppPorts([
      { path: ROOT_MANIFEST_PATH, content: TURBO_ROOT },
      { path: 'packages/ui', content: '{ not json' },
      { path: 'apps/web', content: JSON.stringify({ devDependencies: { vite: '^8' } }) },
    ]);

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: 'apps/web' },
    ]);
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain('packages/ui/package.json is not valid JSON');
  });

  it('resolves each member independently rather than pooling their ports', () => {
    const detection = detectAppPorts([
      { path: 'apps/web', content: JSON.stringify({ devDependencies: { vite: '^8' } }) },
      // A port named by a sibling must not override another member's default.
      { path: 'apps/api', content: JSON.stringify({ scripts: { dev: 'node server.js --port 9999' } }) },
    ]);

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default', workspace: 'apps/web' },
    ]);
  });

  it('distinguishes the same port found in two different workspaces', () => {
    const one = detectAppPorts([{ path: 'apps/web', content: JSON.stringify({ devDependencies: { vite: '^8' } }) }]);
    const other = detectAppPorts([{ path: 'apps/admin', content: JSON.stringify({ devDependencies: { vite: '^8' } }) }]);

    expect(one.fingerprint).not.toBe(other.fingerprint);
  });
});

describe('workspace pattern parsing', () => {
  it('reads the npm workspaces array', () => {
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }), null))
      .toEqual(['apps/*', 'packages/*']);
  });

  it('reads the workspaces object form', () => {
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: { packages: ['apps/web'] } }), null))
      .toEqual(['apps/web']);
  });

  it('reads the pnpm workspace file, which is the only declaration in many repos', () => {
    const yaml = [
      'packages:',
      '  - "apps/*"',
      "  - 'packages/*'",
      '',
      'allowBuilds:',
      '  esbuild: true',
    ].join('\n');

    expect(parseWorkspacePatterns(JSON.stringify({ scripts: { dev: 'turbo dev' } }), yaml))
      .toEqual(['apps/*', 'packages/*']);
  });

  it('merges both declarations without duplicating', () => {
    expect(parseWorkspacePatterns(
      JSON.stringify({ workspaces: ['apps/*'] }),
      'packages:\n  - apps/*\n  - tools/*\n',
    )).toEqual(['apps/*', 'tools/*']);
  });

  it.each([
    ['a recursive glob', 'apps/**'],
    ['a negation', '!apps/legacy'],
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', '../outside/*'],
    ['a nested parent traversal', 'apps/../../etc'],
    ['a bare current directory', '.'],
    ['a mid-segment wildcard', 'apps/*/src'],
    ['a shell metacharacter', 'apps/$(whoami)'],
    ['a quoted expansion', 'apps/`id`'],
  ])('drops %s rather than interpreting it', (_label, pattern) => {
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: [pattern] }), null)).toEqual([]);
  });

  it('yields nothing for a repository that declares no workspaces', () => {
    expect(parseWorkspacePatterns(JSON.stringify({ scripts: { dev: 'vite' } }), null)).toEqual([]);
    expect(parseWorkspacePatterns(null, null)).toEqual([]);
  });

  it('survives a malformed root manifest', () => {
    expect(parseWorkspacePatterns('{ not json', 'packages:\n  - apps/*\n')).toEqual(['apps/*']);
  });

  it('caps the number of honored patterns', () => {
    const many = Array.from({ length: 40 }, (_value, index) => `apps${index}/*`);
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: many }), null))
      .toHaveLength(MAX_WORKSPACE_PATTERNS);
  });
});
