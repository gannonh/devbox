import { describe, expect, it, vi } from 'vitest';
import { scanRemoteAppPorts } from '../src/providers/vercel/app-port-scan.js';
import { MAX_PACKAGE_JSON_BYTES, VITE_DEFAULT_PORT } from '../src/providers/vercel/app-ports.js';
import type {
  VercelCommandResult,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
} from '../src/providers/vercel/client.js';

const REVISION = 'a'.repeat(40);

interface ScanScript {
  revision?: { exitCode: number; stdout?: string } | Error;
  packageJson?: { exitCode: number; stdout?: string } | Error;
}

function scanClient(script: ScanScript) {
  const requests: VercelRunCommandRequest[] = [];
  const client = {
    runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      requests.push(request);
      const step = request.cmd === 'git' ? script.revision : script.packageJson;
      if (step instanceof Error) throw step;
      const resolved = step ?? { exitCode: 0, stdout: '' };
      return {
        exitCode: resolved.exitCode,
        stdout: async () => resolved.stdout ?? '',
      } as unknown as VercelCommandResult;
    }),
  } as unknown as VercelSandboxClient;
  return { client, requests };
}

function sandbox(): VercelSandboxHandle {
  return { name: 'devbox-test' } as unknown as VercelSandboxHandle;
}

async function scan(script: ScanScript) {
  const { client, requests } = scanClient(script);
  const result = await scanRemoteAppPorts({
    sandbox: sandbox(),
    client,
    workspace: '/vercel/sandbox/repo',
  });
  return { ...result, requests };
}

describe('remote app port scan', () => {
  it('reads the remote revision and root package.json from the checkout only', async () => {
    const result = await scan({
      revision: { exitCode: 0, stdout: `${REVISION}\n` },
      packageJson: { exitCode: 0, stdout: JSON.stringify({ scripts: { dev: 'vite' } }) },
    });

    expect(result.revision).toBe(REVISION);
    expect(result.detection.candidates).toEqual([
      { port: VITE_DEFAULT_PORT, framework: 'vite', source: 'framework-default' },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0]).toMatchObject({
      cmd: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: '/vercel/sandbox/repo',
    });
    expect(result.requests[1]).toMatchObject({ cmd: 'sh', cwd: '/vercel/sandbox/repo' });
    expect(result.requests[1].args?.join(' ')).toContain(`head -c ${MAX_PACKAGE_JSON_BYTES} ./package.json`);
  });

  it('treats a missing root package.json as no inferred ports', async () => {
    const result = await scan({
      revision: { exitCode: 0, stdout: REVISION },
      packageJson: { exitCode: 42 },
    });

    expect(result.revision).toBe(REVISION);
    expect(result.detection.candidates).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('surfaces a malformed root package.json as a bounded warning without failing', async () => {
    const result = await scan({
      revision: { exitCode: 0, stdout: REVISION },
      packageJson: { exitCode: 0, stdout: '{"scripts": {"dev": "vite --port 4321"' },
    });

    expect(result.detection.candidates).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('not valid JSON');
    expect(result.warnings.join('\n')).not.toContain('4321');
  });

  it('reports a read failure without echoing repository content', async () => {
    const result = await scan({
      revision: { exitCode: 0, stdout: REVISION },
      packageJson: { exitCode: 1, stdout: 'cat: package.json: secret content' },
    });

    expect(result.detection.candidates).toEqual([]);
    expect(result.warnings).toEqual(['remote root package.json could not be read (exit code 1)']);
  });

  it('infers nothing when the checkout revision cannot be resolved', async () => {
    const result = await scan({ revision: { exitCode: 128, stdout: '' } });

    expect(result.revision).toBeUndefined();
    expect(result.detection.candidates).toEqual([]);
    expect(result.warnings).toEqual([
      'remote checkout revision could not be resolved; no app ports were inferred',
    ]);
    expect(result.requests).toHaveLength(1);
  });

  it('rejects a revision that is not a full commit SHA', async () => {
    const result = await scan({ revision: { exitCode: 0, stdout: 'HEAD -> main\n' } });

    expect(result.revision).toBeUndefined();
    expect(result.requests).toHaveLength(1);
  });

  it('redacts secrets out of a scan transport failure', async () => {
    const { client } = scanClient({ revision: new Error('connect failed for token vercel-secret') });

    const result = await scanRemoteAppPorts({
      sandbox: sandbox(),
      client,
      workspace: '/vercel/sandbox/repo',
      secrets: ['vercel-secret'],
    });

    expect(result.warnings[0]).toContain('[REDACTED]');
    expect(result.warnings[0]).not.toContain('vercel-secret');
    expect(result.detection.candidates).toEqual([]);
  });

  it('bounds the scan with an abort signal on both commands', async () => {
    const { client, requests } = scanClient({
      revision: { exitCode: 0, stdout: REVISION },
      packageJson: { exitCode: 0, stdout: '{}' },
    });
    const controller = new AbortController();

    await scanRemoteAppPorts({
      sandbox: sandbox(),
      client,
      workspace: '/vercel/sandbox/repo',
      signal: controller.signal,
    });

    expect(requests.every((request) => request.signal === controller.signal)).toBe(true);
  });
});
