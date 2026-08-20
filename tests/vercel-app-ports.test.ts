import { describe, expect, it } from 'vitest';
import {
  APP_PORT_DETECTOR_VERSION,
  detectAppPorts,
  describeAppPortCandidate,
  fingerprintAppPortCandidates,
  NEXT_DEFAULT_PORT,
  VITE_DEFAULT_PORT,
} from '../src/providers/vercel/app-ports.js';

function packageJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

describe('bounded app port detector', () => {
  it('detects the conventional Vite port from a dependency alone', () => {
    const detection = detectAppPorts(packageJson({ devDependencies: { vite: '^5.0.0' } }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default' },
    ]);
    expect(detection.conflicting).toBe(false);
    expect(detection.warnings).toEqual([]);
  });

  it('detects the conventional Vite port from a bare dev script with no dependency', () => {
    const detection = detectAppPorts(packageJson({ scripts: { dev: 'vite' } }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default' },
    ]);
  });

  it('detects the conventional Next port from a dependency alone', () => {
    const detection = detectAppPorts(packageJson({ dependencies: { next: '15.0.0' } }));

    expect(detection.candidates).toEqual([
      { port: NEXT_DEFAULT_PORT, framework: 'next', source: 'framework-default' },
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

    expect(detection.candidates).toEqual([{ port: 4321, framework: 'vite', source: 'dev-script' }]);
  });

  it('normalizes the Next -p forms against the Next default', () => {
    for (const dev of ['next dev -p 4000', 'next dev -p4000', 'PORT=4000 next dev']) {
      expect(detectAppPorts(packageJson({ dependencies: { next: '15.0.0' }, scripts: { dev } })).candidates)
        .toEqual([{ port: 4000, framework: 'next', source: 'dev-script' }]);
    }
  });

  it('accepts a framework executable after npx', () => {
    const detection = detectAppPorts(packageJson({ scripts: { dev: 'npx vite --port 4444' } }));

    expect(detection.candidates).toEqual([{ port: 4444, framework: 'vite', source: 'dev-script' }]);
  });

  it('reads a framework from a later command in a chained dev script', () => {
    const detection = detectAppPorts(packageJson({ scripts: { dev: 'npm run codegen && vite --port 4173' } }));

    expect(detection.candidates).toEqual([{ port: 4173, framework: 'vite', source: 'dev-script' }]);
  });

  it('surfaces conflicting literal ports as labeled candidates instead of choosing one', () => {
    const detection = detectAppPorts(packageJson({
      dependencies: { next: '15.0.0' },
      scripts: { dev: 'PORT=4100 next dev -p 4200' },
    }));

    expect(detection.candidates).toEqual([
      { port: 4100, framework: 'next', source: 'dev-script' },
      { port: 4200, framework: 'next', source: 'dev-script' },
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
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default' },
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
    const detection = detectAppPorts(null);

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings).toEqual([]);
  });

  it('warns without failing and without echoing content for malformed JSON', () => {
    const detection = detectAppPorts('{"scripts": {"dev": "vite --port 4321"');

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain('not valid JSON');
    expect(detection.warnings[0]).not.toContain('vite');
    expect(detection.warnings[0]).not.toContain('4321');
  });

  it('warns without failing when the root package.json is not an object', () => {
    const detection = detectAppPorts('["vite"]');

    expect(detection.candidates).toEqual([]);
    expect(detection.warnings[0]).toContain('not a JSON object');
  });

  it('attributes an unattached literal port to the sole detected framework', () => {
    const detection = detectAppPorts(packageJson({
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'node scripts/dev.mjs --port 4500' },
    }));

    expect(detection.candidates).toEqual([{ port: 4500, framework: 'vite', source: 'dev-script' }]);
  });

  it('drops an unattached literal port when two frameworks are in play', () => {
    const detection = detectAppPorts(packageJson({
      dependencies: { next: '15.0.0' },
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'node scripts/dev.mjs --port 4500' },
    }));

    expect(detection.candidates).toEqual([
      { port: NEXT_DEFAULT_PORT, framework: 'next', source: 'framework-default' },
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default' },
    ]);
  });

  it('rejects out-of-range literal ports rather than proposing them', () => {
    const detection = detectAppPorts(packageJson({
      devDependencies: { vite: '^5.0.0' },
      scripts: { dev: 'vite --port 99999' },
    }));

    expect(detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default' },
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
    expect(describeAppPortCandidate({ port: 5173, framework: 'vite', source: 'framework-default' }))
      .toBe('vite default');
    expect(describeAppPortCandidate({ port: 4000, framework: 'next', source: 'dev-script' }))
      .toBe('next dev script');
  });
});
