import { describe, it, expect, vi } from 'vitest';
import { idLabel, containerFor, containerForAll, novncUrlFor, containerName } from '../src/lib/docker.js';
import type { ShellRunner } from '../src/lib/shell.js';

function mockShell(impl: Partial<ShellRunner>): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
    ...impl,
  } as ShellRunner;
}

describe('idLabel', () => {
  it('formats the devbox.branch label', () => {
    expect(idLabel('my-feature')).toBe('devbox.branch=my-feature');
  });
});

describe('containerFor', () => {
  it('queries running containers by branch label', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: 'abc123\n', code: 0 });
    const runner = mockShell({ execQuiet });

    const cid = await containerFor(runner, 'my-feature');
    expect(cid).toBe('abc123');
    expect(execQuiet).toHaveBeenCalledWith(
      'docker',
      ['ps', '-q', '--filter', 'label=devbox.branch=my-feature'],
      {},
    );
  });

  it('returns empty string when no container found', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const runner = mockShell({ execQuiet });
    expect(await containerFor(runner, 'nope')).toBe('');
  });
});

describe('containerForAll', () => {
  it('queries all containers (including stopped) by branch label', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: 'def456\n', code: 0 });
    const runner = mockShell({ execQuiet });

    const cid = await containerForAll(runner, 'my-feature');
    expect(cid).toBe('def456');
    expect(execQuiet).toHaveBeenCalledWith(
      'docker',
      ['ps', '-aq', '--filter', 'label=devbox.branch=my-feature'],
      {},
    );
  });
});

describe('novncUrlFor', () => {
  it('computes .orb.local URL from container name', async () => {
    const exec = vi.fn().mockResolvedValue('/my-box-name');
    const runner = mockShell({ exec });

    const url = await novncUrlFor(runner, 'abc123');
    expect(url).toBe('http://my-box-name.orb.local:6080/vnc.html');
    expect(exec).toHaveBeenCalledWith('docker', ['inspect', 'abc123', '--format', '{{.Name}}'], {});
  });

  it('strips leading slash from container name', async () => {
    const exec = vi.fn().mockResolvedValue('/vibrant-einstein');
    const runner = mockShell({ exec });
    const url = await novncUrlFor(runner, 'cid');
    expect(url).toBe('http://vibrant-einstein.orb.local:6080/vnc.html');
  });
});

describe('containerName', () => {
  it('returns the container name without the leading slash', async () => {
    const exec = vi.fn().mockResolvedValue('/my-box-name');
    const runner = mockShell({ exec });

    const name = await containerName(runner, 'abc123');
    expect(name).toBe('my-box-name');
    expect(exec).toHaveBeenCalledWith('docker', ['inspect', 'abc123', '--format', '{{.Name}}'], {});
  });

  it('strips leading slash from a long container name', async () => {
    const exec = vi.fn().mockResolvedValue('/devbox-my-feature-abc123');
    const runner = mockShell({ exec });
    expect(await containerName(runner, 'cid')).toBe('devbox-my-feature-abc123');
  });

  it('returns name as-is when there is no leading slash', async () => {
    const exec = vi.fn().mockResolvedValue('plain-name');
    const runner = mockShell({ exec });
    expect(await containerName(runner, 'cid')).toBe('plain-name');
  });
});
