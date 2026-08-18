import { chmod, link as linkFile, mkdtemp, mkdir, open as openFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectPiBundle, DEFAULT_PI_BUNDLE_LIMITS } from '../src/providers/vercel/pi-bundle.js';

const fifoSupported = process.platform !== 'win32' && canRunMkfifo();
const permissionsSupported = process.platform !== 'win32' && (process.getuid?.() ?? 1) !== 0;

describe('Pi configuration bundle', () => {
  it('collects regular files with root-relative paths and buffers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    await writeFile(join(root, 'agent', 'settings.json'), '{"packages":[]}');

    const result = await collectPiBundle({ root });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].path).toBe('agent/settings.json');
    expect(result.entries[0].content).toEqual(Buffer.from('{"packages":[]}'));
    expect(result.entries[0].mode).toBeTypeOf('number');
    expect(result.totalBytes).toBe(15);
    expect(result.entryCount).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('enforces the exact 5,000-entry boundary and reports the 5,001st path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-entries-'));
    await Promise.all(
      Array.from({ length: 5_000 }, (_, index) =>
        writeFile(join(root, `entry-${String(index).padStart(4, '0')}.txt`), '')),
    );

    const atLimit = await collectPiBundle({ root, limits: { maxEntries: 5_000 } });
    expect(atLimit.entryCount).toBe(5_000);

    await writeFile(join(root, 'entry-overflow.txt'), '');
    await expect(collectPiBundle({ root, limits: { maxEntries: 5_000 } }))
      .rejects.toThrow(/maximum of 5000 entries.*observed 5001.*entry-(?:\d{4}|overflow)\.txt/);
  }, 15_000);

  it('enforces the exact 16 MiB total-byte boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-total-'));
    const totalLimit = 16 * 1024 * 1024;
    await writeFile(join(root, 'a.bin'), Buffer.alloc(totalLimit));
    const limits = { maxTotalBytes: totalLimit, maxFileBytes: totalLimit };

    const atLimit = await collectPiBundle({ root, limits });
    expect(atLimit.totalBytes).toBe(totalLimit);

    await writeFile(join(root, 'b.bin'), Buffer.from([0]));
    await expect(collectPiBundle({ root, limits }))
      .rejects.toThrow(/maximum of 16777216 regular-file bytes.*observed 16777217.*(?:a|b)\.bin/);
  });

  it('enforces the exact 4 MiB single-file boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-file-'));
    const fileLimit = 4 * 1024 * 1024;
    await writeFile(join(root, 'a.bin'), Buffer.alloc(fileLimit));

    const atLimit = await collectPiBundle({ root, limits: { maxFileBytes: fileLimit } });
    expect(atLimit.totalBytes).toBe(fileLimit);

    await writeFile(join(root, 'b.bin'), Buffer.alloc(fileLimit + 1));
    await expect(collectPiBundle({ root, limits: { maxFileBytes: fileLimit } }))
      .rejects.toThrow(/maximum of 4194304 bytes.*observed 4194305.*b\.bin/);
  });

  it('rejects a short regular-file read with both expected and observed sizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-short-read-'));
    const filePath = join(root, 'settings.json');
    await writeFile(filePath, 'secret');
    const probe = await openFile(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...args: any[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    const originalRead = prototype.read;
    await probe.close();
    let calls = 0;
    const readSpy = vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) {
      calls += 1;
      if (calls === 1) return originalRead.call(this, buffer, offset, length - 1, position);
      return { bytesRead: 0, buffer };
    });

    try {
      await expect(collectPiBundle({ root }))
        .rejects.toThrow(/short read.*settings\.json.*expected 6.*received 5/);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('preserves regular-file permission bits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-mode-'));
    const file = join(root, 'secret.json');
    await writeFile(file, '{}');
    await chmod(file, 0o754);

    const result = await collectPiBundle({ root });

    expect(result.entries[0].mode).toBe(0o754);
  });

  it('falls back to HOME/.pi', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devbox-pi-home-'));
    const root = join(home, '.pi');
    await mkdir(root);
    await writeFile(join(root, 'auth.json'), 'credential');

    const result = await collectPiBundle({ env: { HOME: home } });

    expect(result.entries.map((entry) => entry.path)).toEqual(['auth.json']);
  });

  it('includes a hard link whose path is inside the Pi root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-hard-link-'));
    const source = join(root, 'source.json');
    const alias = join(root, 'hard-link.json');
    await writeFile(source, 'credential');
    await linkFile(source, alias);

    const result = await collectPiBundle({ root });

    expect(result.entries.map((entry) => entry.path).sort()).toEqual(['hard-link.json', 'source.json']);
    expect(result.entries.every((entry) => entry.content.equals(Buffer.from('credential')))).toBe(true);
  });

  it('keeps Pi settings and root authentication files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-auth-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    await writeFile(join(root, 'agent', 'settings.json'), '{"packages":["pi-auth"]}');
    await writeFile(join(root, 'auth.json'), '{"token":"redacted"}');

    const result = await collectPiBundle({ root });

    expect(result.entries.map((entry) => entry.path)).toEqual(['agent/settings.json', 'auth.json']);
  });

  it('excludes generated fff databases before applying the default file-size limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-fff-'));
    await mkdir(join(root, 'agent', 'fff', 'frecency'), { recursive: true });
    await writeFile(
      join(root, 'agent', 'fff', 'frecency', 'data.mdb'),
      Buffer.alloc(DEFAULT_PI_BUNDLE_LIMITS.maxFileBytes + 1),
    );
    await writeFile(join(root, 'agent', 'settings.json'), '{}');
    await writeFile(join(root, 'auth.json'), '{}');

    const result = await collectPiBundle({ root });

    expect(result.entries.map((entry) => entry.path).sort()).toEqual(['agent/settings.json', 'auth.json']);
    expect(result.totalBytes).toBe(4);
    expect(result.skipped).toEqual([]);
    expect(result.skippedCount).toBe(0);
  });

  it('returns an empty rootMissing bundle when the Pi root does not exist', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'devbox-pi-missing-'));

    const result = await collectPiBundle({ root: join(parent, '.pi') });

    expect(result).toEqual({
      entries: [],
      totalBytes: 0,
      entryCount: 0,
      skipped: [],
      skippedCount: 0,
      rootMissing: true,
    });
  });

  it.skipIf(!permissionsSupported)('reports an unreadable directory and continues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-permissions-'));
    const unreadable = join(root, 'private');
    await mkdir(unreadable);
    await writeFile(join(unreadable, 'secret.json'), '{}');
    await writeFile(join(root, 'allowed.json'), '{}');
    await chmod(unreadable, 0o000);

    let result;
    try {
      result = await collectPiBundle({ root });
    } finally {
      await chmod(unreadable, 0o700);
    }

    expect(result.entries.map((entry) => entry.path)).toEqual(['allowed.json']);
    expect(result.skipped).toEqual([
      { path: 'private', reason: expect.stringMatching(/EACCES|permission/i) },
    ]);
  });

  it('reports an existing non-directory Pi root without throwing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'devbox-pi-invalid-'));
    const root = join(parent, '.pi');
    await writeFile(root, 'not a directory');

    const result = await collectPiBundle({ root });

    expect(result).toEqual({
      entries: [],
      totalBytes: 0,
      entryCount: 0,
      skipped: [{ path: root, reason: expect.stringContaining('not a directory') }],
      skippedCount: 1,
      rootInvalid: true,
    });
  });

  it('does not treat a sibling Pi-evil path as inside the Pi root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'devbox-pi-boundary-'));
    const root = join(parent, '.pi');
    const outside = join(parent, '.pi-evil');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.json'), 'outside');
    await symlink(join(outside, 'secret.json'), join(root, 'secret.json'));

    const result = await collectPiBundle({ root });

    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'secret.json', reason: expect.stringContaining('outside') },
    ]);
  });

  it('does not recurse through an inside-root directory cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-'));
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'config.json'), '{}');
    await symlink('../nested', join(root, 'nested', 'back'), 'dir');

    const result = await collectPiBundle({ root });

    expect(result.entries.map((entry) => entry.path)).toEqual(['nested/config.json']);
    expect(result.skipped).toEqual([
      { path: 'nested/back', reason: expect.stringContaining('cycle') },
    ]);
  });

  it('terminates on a symlink loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-'));
    await symlink('loop', join(root, 'loop'), 'dir');

    const result = await collectPiBundle({ root });

    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'loop', reason: expect.stringContaining('resolve') },
    ]);
  });

  it('excludes and reports file and directory symlinks escaping the Pi root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'outside-file');
    await mkdir(join(outside, 'directory'), { recursive: true });
    await writeFile(join(outside, 'directory', 'secret.txt'), 'outside-directory');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape-file.txt'));
    await symlink(join(outside, 'directory'), join(root, 'escape-directory'), 'dir');

    const result = await collectPiBundle({ root });

    expect(result.entries).toEqual([]);
    expect([...result.skipped].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: 'escape-directory', reason: expect.stringContaining('outside') },
      { path: 'escape-file.txt', reason: expect.stringContaining('outside') },
    ]);
    expect(result.entries.some((entry) => entry.content.includes('outside'))).toBe(false);
  });

  it('includes a symlink that resolves inside the Pi root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-'));
    await writeFile(join(root, 'auth.json'), 'secret');
    await symlink('auth.json', join(root, 'auth-link.json'));

    const result = await collectPiBundle({ root });

    expect(result.entries.find((entry) => entry.path === 'auth-link.json')).toMatchObject({
      path: 'auth-link.json',
      content: Buffer.from('secret'),
    });
  });

  it.skipIf(!fifoSupported)('skips non-regular FIFO entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-'));
    const fifo = join(root, 'agent.pipe');
    execFileSync('mkfifo', [fifo]);
    await writeFile(join(root, 'settings.json'), '{}');

    const result = await collectPiBundle({ root });

    expect(result.entries.map((entry) => entry.path)).toEqual(['settings.json']);
    expect(result.skipped).toEqual([
      { path: 'agent.pipe', reason: expect.stringMatching(/FIFO/i) },
    ]);
  });

  it('bounds the skipped report while retaining its total count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-skipped-'));
    const outside = await mkdtemp(join(tmpdir(), 'devbox-pi-skipped-outside-'));
    const outsideFile = join(outside, 'secret.json');
    await writeFile(outsideFile, 'outside');
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        symlink(outsideFile, join(root, `escape-${index}.json`))),
    );

    const result = await collectPiBundle({ root });

    expect(result.entries).toEqual([]);
    expect(result.skipped).toHaveLength(100);
    expect(result.skippedCount).toBe(101);
  });

  it('excludes symlink aliases to excluded directories and files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-alias-'));
    const excludedDirectory = join(root, 'agent', 'sessions');
    const excludedFile = join(excludedDirectory, 'nested', 'session.json');
    await mkdir(join(excludedDirectory, 'nested'), { recursive: true });
    await writeFile(excludedFile, 'session');
    await symlink(excludedDirectory, join(root, 'sessions-alias'), 'dir');
    await symlink(excludedFile, join(root, 'session-file-alias.json'));

    const result = await collectPiBundle({ root });

    expect(result.entries).toEqual([]);
    expect([...result.skipped].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: 'session-file-alias.json', reason: expect.stringContaining('excluded') },
      { path: 'sessions-alias', reason: expect.stringContaining('excluded') },
    ]);
  });

  it('excludes session, npm, and cache subtrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-pi-bundle-'));
    await mkdir(join(root, 'agent', 'sessions', 'nested'), { recursive: true });
    await mkdir(join(root, 'agent', 'npm', 'nested'), { recursive: true });
    await mkdir(join(root, 'agent', 'cache', 'nested'), { recursive: true });
    await writeFile(join(root, 'agent', 'settings.json'), '{}');
    await writeFile(join(root, 'agent', 'sessions', 'nested', 'session.json'), '{}');
    await writeFile(join(root, 'agent', 'npm', 'nested', 'package.js'), 'module');
    await writeFile(join(root, 'agent', 'cache', 'nested', 'cache.json'), '{}');

    const result = await collectPiBundle({ root });

    expect(result.entries.map((entry) => entry.path)).toEqual(['agent/settings.json']);
  });
});

function canRunMkfifo(): boolean {
  try {
    execFileSync('which', ['mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
