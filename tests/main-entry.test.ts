import { describe, it, expect } from 'vitest';
import { isMainEntry } from '../src/cli.js';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

describe('isMainEntry', () => {
  it('returns true when argv1 resolves to the same real path as moduleUrl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-main-'));
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// test');
    const moduleUrl = pathToFileURL(realFile).href;
    // Direct invocation: argv1 is the real file path.
    expect(isMainEntry(realFile, moduleUrl)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when argv1 is a symlink that resolves to the module file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-symlink-'));
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// test');
    const symlinkPath = join(dir, 'bin', 'devbox');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    symlinkSync(realFile, symlinkPath);

    const moduleUrl = pathToFileURL(realFile).href;
    // argv1 is the symlink, moduleUrl is the real file URL — must still match.
    expect(isMainEntry(symlinkPath, moduleUrl)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when argv1 resolves to a different file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-diff-'));
    const fileA = join(dir, 'a.js');
    const fileB = join(dir, 'b.js');
    writeFileSync(fileA, '// a');
    writeFileSync(fileB, '// b');
    const moduleUrl = pathToFileURL(fileA).href;
    expect(isMainEntry(fileB, moduleUrl)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when argv1 is empty', () => {
    expect(isMainEntry('', 'file:///some/module.js')).toBe(false);
  });

  it('returns false when argv1 path does not exist', () => {
    expect(isMainEntry('/nonexistent/path/cli.js', 'file:///some/module.js')).toBe(false);
  });

  it('returns false when moduleUrl is empty', () => {
    expect(isMainEntry('/some/path/cli.js', '')).toBe(false);
  });
});
