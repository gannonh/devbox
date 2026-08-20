import { describe, expect, it } from 'vitest';
import { routesForRender } from '../src/providers/vercel/provider-routes.js';
import type { VercelSandboxHandle } from '../src/providers/vercel/client.js';
import type { AppPortFlowResult } from '../src/providers/vercel/app-port-flow.js';

describe('routesForRender', () => {
  it('synthesizes missing applied ports from sandbox.domain when the handle is stale', () => {
    const sandbox = {
      routes: [
        { port: 6080, subdomain: 'box', url: 'https://box.example/6080' },
      ],
      domain: (port: number) => `https://box.example/${port}`,
    } as unknown as VercelSandboxHandle;
    const appPorts: AppPortFlowResult = {
      selected: [5173],
      applied: [5173, 6080],
      updated: true,
      labels: { 5173: 'vite' },
    };

    expect(routesForRender(sandbox, appPorts)).toEqual([
      { port: 5173, subdomain: '', url: 'https://box.example/5173' },
      { port: 6080, subdomain: 'box', url: 'https://box.example/6080' },
    ]);
  });

  it('keeps handle routes when they already match applied', () => {
    const routes = [
      { port: 5173, subdomain: 'box', url: 'https://box.example/5173' },
      { port: 6080, subdomain: 'box', url: 'https://box.example/6080' },
    ];
    const sandbox = { routes, domain: () => 'unused' } as unknown as VercelSandboxHandle;
    const appPorts: AppPortFlowResult = {
      selected: [5173],
      applied: [5173, 6080],
      updated: true,
      labels: { 5173: 'vite' },
    };

    expect(routesForRender(sandbox, appPorts)).toEqual(routes);
  });
});
