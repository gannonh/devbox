import { describe, it, expect } from 'vitest';
import { detectPackageManager } from '../src/lib/lockfile.js';

describe('detectPackageManager', () => {
  it('returns "bun" when bun.lock is present', () => {
    expect(detectPackageManager(['bun.lock'])).toBe('bun');
  });

  it('returns "pnpm" when pnpm-lock.yaml is present', () => {
    expect(detectPackageManager(['pnpm-lock.yaml'])).toBe('pnpm');
  });

  it('returns "npm" when package-lock.json is present', () => {
    expect(detectPackageManager(['package-lock.json'])).toBe('npm');
  });

  it('returns "none" when no lockfile is present', () => {
    expect(detectPackageManager(['README.md', 'src/index.ts'])).toBe('none');
  });

  it('prioritizes bun over pnpm over npm when multiple lockfiles exist', () => {
    expect(detectPackageManager(['bun.lock', 'package-lock.json'])).toBe('bun');
    expect(detectPackageManager(['pnpm-lock.yaml', 'package-lock.json'])).toBe('pnpm');
  });

  it('returns "none" for empty array', () => {
    expect(detectPackageManager([])).toBe('none');
  });
});
