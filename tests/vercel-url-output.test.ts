import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import type { VercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import type {
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
} from '../src/providers/vercel/client.js';
import type { ProviderBranchRequest } from '../src/providers/types.js';
import type { ShellRunner } from '../src/lib/shell.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import { createVercelBranchMetadataStore, createVercelScopeMetadataStore } from '../src/providers/vercel/metadata.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
import { DISPLAY_STATUS_OUTPUT } from './vercel-display-status.fixture.js';

const remote = 'github.com/acme/repo';
const branch = 'feature/ui';
const DISPLAY_TOKEN = 'test-novnc-token-aaaaaaaaaaaaaaaaaaaa';
const NOVNC_URL = `https://sandbox.example/vnc.html?token=${DISPLAY_TOKEN}&autoconnect=1`;
const NOVNC_LINE = `6080: ${NOVNC_URL}  (noVNC display)`;
function runner(): ShellRunner {
  return {
    exec: vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
      if (args[0] === 'ls-remote') return 'ref: refs/heads/main\tHEAD\n';
      throw new Error(`unexpected exec: ${args.join(' ')}`);
    }),
    execQuiet: vi.fn(async (_command: string, args: string[]) => args[0] === 'check-ref-format'
      ? { stdout: '', code: 0 }
      : { stdout: `sha\trefs/heads/${branch}\n`, code: 0 }),
    spawnInherit: vi.fn(),
  };
}

function sandbox(): VercelSandboxHandle {
  return {
    name: 'devbox-vercel-url-test',
    status: 'running',
    cwd: '/vercel/sandbox',
  } as unknown as VercelSandboxHandle;
}

interface FixtureOptions {
  opener?: (url: string) => void | Promise<void>;
  lifecycle?: Partial<VercelLifecycle>;
  client?: VercelSandboxClient;
  terminal?: VercelTerminalAdapter;
}

async function fixture(
  routes: readonly { port: number; subdomain: string; url: string }[],
  options: FixtureOptions & { devcontainerJson?: string } = {},
) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-vercel-url-output-'));
  await mkdir(join(repoRoot, '.devcontainer'));
  await writeFile(
    join(repoRoot, '.devcontainer', 'devcontainer.json'),
    options.devcontainerJson ?? JSON.stringify({
      forwardPorts: [3000, 5173],
      portsAttributes: { '5173': { label: 'Vite dev server' } },
    }),
  );
  const stateHome = await mkdtemp(join(tmpdir(), 'devbox-vercel-url-state-'));
  const identity = createVercelIdentity({ remote, branch, scope: { teamId: 'team-1', projectId: 'project-1' } });
  await createVercelScopeMetadataStore({ stateHome, repoKey: remote }).write({
    teamId: 'team-1',
    projectId: 'project-1',
  });
  await createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch }).write({
    displayCredentials: { username: 'devbox', password: DISPLAY_TOKEN },
    identity: {
      name: identity.name,
      repository: identity.canonicalRepository,
      branch: identity.branch,
      packageVersion: identity.packageVersion,
      tags: { ...identity.tags },
    },
    configuration: {
      imageReference: VERCEL_IMAGE_PIN.reference,
      sourceUrl: 'https://github.com/acme/repo.git',
      sourceRevision: 'main',
      requestedBranch: branch,
      needsBranchSetup: false,
      persistent: true,
      keepLastSnapshots: 1,
      timeoutMs: 1_800_000,
    },
  });
  const lifecycle = {
    routes: vi.fn(async () => routes),
    ...options.lifecycle,
  } as unknown as VercelLifecycle;
  const provider = createVercelProvider({
    runner: runner(),
    stateHome,
    lifecycle,
    ...(options.opener === undefined ? {} : { opener: options.opener }),
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errorOutput = '';
  stdout.on('data', (chunk) => { output += chunk.toString(); });
  stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
  const request: ProviderBranchRequest & { open: boolean } = {
    repoRoot,
    repoName: 'repo',
    env: {
      HOME: stateHome,
      GH_TOKEN: 'github-token',
      VERCEL_TOKEN: 'vercel-token',
    },
    tty: false,
    stdin: new PassThrough(),
    stdout,
    stderr,
    branch,
    open: false,
  };
  return {
    provider,
    request,
    output: () => output,
    errorOutput: () => errorOutput,
    opener: options.opener,
    sandbox: sandbox(),
  };
}

describe('Vercel URL output', () => {
  it('sorts routes and labels authenticated noVNC, configured apps, and unknown public apps', async () => {
    const test = await fixture([
      { port: 9000, subdomain: 'sandbox', url: 'https://sandbox.example/9000' },
      { port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' },
      { port: 5173, subdomain: 'sandbox', url: 'https://sandbox.example/5173' },
      { port: 3000, subdomain: 'sandbox', url: 'https://sandbox.example/3000' },
    ]);

    await expect(test.provider.url(test.request)).resolves.toEqual({ exitCode: 0 });

    expect(test.output()).toBe([
      '3000: https://sandbox.example/3000  (public)',
      '5173: https://sandbox.example/5173  (Vite dev server — public)',
      NOVNC_LINE,
      '9000: https://sandbox.example/9000  (public)',
      '',
    ].join('\n'));
  });

  it('opens the authenticated noVNC route instead of the first route', async () => {
    const opener = vi.fn();
    const test = await fixture([
      { port: 3000, subdomain: 'sandbox', url: 'https://sandbox.example/3000' },
      { port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' },
    ], { opener });
    test.request.open = true;

    await expect(test.provider.url(test.request)).resolves.toEqual({ exitCode: 0 });

    expect(opener).toHaveBeenCalledWith(NOVNC_URL);
  });

  it('fails --open actionably when authenticated noVNC is absent', async () => {
    const test = await fixture([
      { port: 3000, subdomain: 'sandbox', url: 'https://sandbox.example/3000' },
    ]);
    test.request.open = true;

    await expect(test.provider.url(test.request)).rejects.toMatchObject({
      code: 'route',
      exitCode: 2,
      message: expect.stringMatching(/noVNC.*6080/i),
    });
  });

  it('prints the labeled ready block before attaching the terminal on up', async () => {
    const routes = [
      { port: 5173, subdomain: 'sandbox', url: 'https://sandbox.example/5173' },
      { port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' },
      { port: 3000, subdomain: 'sandbox', url: 'https://sandbox.example/3000' },
    ];
    const events: string[] = [];
    const handle = { ...sandbox(), routes } as VercelSandboxHandle;
    const lifecycle = {
      up: vi.fn(async () => { events.push('up'); return handle; }),
      routes: vi.fn(async () => routes),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => { events.push('runtime-upload'); }),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, command: VercelRunCommandRequest) => {
        events.push(command.cmd);
        return command.cmd === '/usr/local/bin/devbox-status'
          ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
          : { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => { events.push('terminal-attach'); return { status: 'detached' as const, reason: 'escape' as const }; }),
    };
    const test = await fixture(routes, { lifecycle, client, terminal });

    await expect(test.provider.up(test.request)).resolves.toEqual({ exitCode: 0 });

    const ready = test.errorOutput().slice(test.errorOutput().indexOf('Vercel devbox ready'));
    expect(ready).toBe([
      'Vercel devbox ready',
      '  3000: https://sandbox.example/3000  (public)',
      '  5173: https://sandbox.example/5173  (Vite dev server — public)',
      `  ${NOVNC_LINE}`,
      '  stop: devbox feature/ui --provider vercel --stop',
      '  remove: devbox feature/ui --provider vercel --rm',
      'setup running; log: /vercel/.devbox/runtime/setup.log',
      '',
    ].join('\n'));
    expect(events.at(-1)).toBe('terminal-attach');
  });

  it('rejects credential-bearing route URLs before rendering or opening them', async () => {
    const opener = vi.fn();
    const test = await fixture([
      { port: 6080, subdomain: 'sandbox', url: 'https://devbox:hunter2@host.example/6080' },
    ], { opener });
    test.request.open = true;

    await expect(test.provider.url(test.request)).rejects.toMatchObject({
      code: 'route',
      exitCode: 2,
      message: expect.not.stringContaining('hunter2'),
    });

    expect(test.output()).not.toContain('hunter2');
    expect(opener).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS route URLs before rendering or opening them', async () => {
    for (const url of ['http://host.example/6080', 'ftp://host.example/6080', 'file:///tmp/display']) {
      const test = await fixture([{ port: 6080, subdomain: 'sandbox', url }]);
      await expect(test.provider.url(test.request)).rejects.toMatchObject({
        code: 'route',
        exitCode: 2,
        message: expect.stringContaining('https'),
      });
    }
  });

  it('rejects credential-bearing route URLs in the ready block without revealing them', async () => {
    const routes = [{ port: 6080, subdomain: 'sandbox', url: 'https://devbox:hunter2@host.example/6080' }];
    const handle = { ...sandbox(), routes } as VercelSandboxHandle;
    const lifecycle = {
      up: vi.fn(async () => handle),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, command: VercelRunCommandRequest) =>
        command.cmd === '/usr/local/bin/devbox-status'
          ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
          : { exitCode: 0 }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const test = await fixture(routes, { lifecycle, client, terminal });

    await expect(test.provider.up(test.request)).rejects.toMatchObject({
      code: 'route',
      exitCode: 2,
      message: expect.not.stringContaining('hunter2'),
    });

    expect(test.errorOutput()).not.toContain('hunter2');
    expect(terminal.attach).not.toHaveBeenCalled();
  });

  it('prints only a resumed noVNC notice on attach', async () => {
    const routes = [
      { port: 3000, subdomain: 'sandbox', url: 'https://sandbox.example/3000' },
      { port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' },
    ];
    const handle = { ...sandbox(), routes } as VercelSandboxHandle;
    const lifecycle = {
      attach: vi.fn(async () => handle),
      routes: vi.fn(async () => routes),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, command: VercelRunCommandRequest) =>
        command.cmd === '/usr/local/bin/devbox-status'
          ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
          : { exitCode: 0 }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const test = await fixture(routes, { lifecycle, client, terminal });

    await expect(test.provider.attach(test.request)).resolves.toEqual({ exitCode: 0 });

    const notice = test.errorOutput().slice(test.errorOutput().indexOf('Vercel devbox resumed'));
    expect(notice).toBe(
      `Vercel devbox resumed; ${NOVNC_LINE}\n`
      + 'setup running; log: /vercel/.devbox/runtime/setup.log\n',
    );
    expect(notice).not.toContain('--stop');
    expect(notice).not.toContain('3000:');
  });
  it('keeps --url working with unlabeled routes when devcontainer.json is malformed', async () => {
    const test = await fixture(
      [
        { port: 5173, subdomain: 'sandbox', url: 'https://sandbox.example/5173' },
        { port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' },
      ],
      { devcontainerJson: '{ "forwardPorts": [5173,, }' },
    );

    await expect(test.provider.url(test.request)).resolves.toEqual({ exitCode: 0 });

    expect(test.output()).toBe([
      '5173: https://sandbox.example/5173  (public)',
      NOVNC_LINE,
      '',
    ].join('\n'));
  });
});
