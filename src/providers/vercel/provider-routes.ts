/**
 * Ready/resume/url route rendering for the Vercel provider.
 *
 * Kept out of the provider orchestration file so boot/attach wiring does not
 * share a growth budget with URL formatting.
 */
import {
  DEVBOX_NOVNC_PROXY_PORT,
  resolveDevcontainerPorts,
  samePortSet,
  VercelPortsError,
} from './ports.js';
import { VercelProviderError } from './errors.js';
import type { AppPortFlowResult } from './app-port-flow.js';
import { DEFAULT_APP_PORT_LABEL, type VercelRelayMapping } from './app-relay.js';
import type { SandboxRoute, VercelSandboxHandle } from './client.js';
import type { ProviderBranchRequest } from '../types.js';
import { renderSetupNotice, type VercelSetupStatus } from './setup.js';

export interface RenderedVercelRoute {
  route: SandboxRoute;
  /** The port the user chose, which is not the port the route exposes. */
  logicalPort: number;
  url: string;
  line: string;
}

export async function renderedRoutesForSandbox(
  sandbox: VercelSandboxHandle,
  repoRoot: string,
  token: string,
  extraLabels: Record<number, string> = {},
  appPorts?: AppPortFlowResult,
): Promise<RenderedVercelRoute[]> {
  return renderVercelRoutes(
    routesForRender(sandbox, appPorts),
    { ...await resolveRouteLabels(repoRoot), ...extraLabels },
    token,
    appPorts?.relays ?? [],
  );
}

/**
 * Prefer the handle's routes when they already match `applied`; otherwise
 * synthesize missing entries from `sandbox.domain` so a successful update is
 * visible even when the SDK handle has not refreshed yet.
 */
export function routesForRender(
  sandbox: VercelSandboxHandle,
  appPorts?: AppPortFlowResult,
): SandboxRoute[] {
  const current = [...(sandbox.routes ?? [])];
  if (!appPorts?.updated) return current;
  const currentPorts = current.map((route) => route.port);
  if (samePortSet(currentPorts, appPorts.applied)) return current;
  // Test and partial handles may omit `domain`; never crash readiness for that.
  if (typeof sandbox.domain !== 'function') return current;

  return appPorts.applied.map((port) => {
    const existing = current.find((route) => route.port === port);
    if (existing) return existing;
    return {
      port,
      subdomain: '',
      url: sandbox.domain(port),
    };
  });
}

// Labels are cosmetic enrichment on read surfaces. A malformed
// devcontainer.json must not break --url or a resume the way it cannot
// break stop/remove/list (see the up()-only ports resolution in the
// lifecycle); `up` fails hard on it when the ports actually matter.
export async function resolveRouteLabels(repoRoot: string): Promise<Record<number, string>> {
  try {
    return (await resolveDevcontainerPorts(repoRoot)).labels;
  } catch (error) {
    if (!(error instanceof VercelPortsError)) throw error;
    return {};
  }
}

export async function renderVercelBlock(
  request: ProviderBranchRequest,
  sandbox: VercelSandboxHandle,
  setupStatus: VercelSetupStatus | null,
  token: string,
  headline: string,
  appPorts?: AppPortFlowResult,
): Promise<void> {
  const routes = await renderedRoutesForSandbox(
    sandbox,
    request.repoRoot,
    token,
    appPorts?.labels ?? {},
    appPorts,
  );
  request.stderr.write(`${headline}\n`);
  for (const rendered of routes) request.stderr.write(`  ${rendered.line}\n`);
  if (routes.some(({ route }) => route.port === DEVBOX_NOVNC_PROXY_PORT)) {
    request.stderr.write(`  access code: ${token}\n`);
  }
  request.stderr.write(`  stop: devbox ${request.branch} --provider vercel --stop\n`);
  request.stderr.write(`  remove: devbox ${request.branch} --provider vercel --rm\n`);
  const setupNotice = renderSetupNotice(setupStatus);
  if (setupNotice) request.stderr.write(`${setupNotice}\n`);
}

export async function renderVercelReadyBlock(
  request: ProviderBranchRequest,
  sandbox: VercelSandboxHandle,
  setupStatus: VercelSetupStatus | null,
  token: string,
  appPorts?: AppPortFlowResult,
): Promise<void> {
  await renderVercelBlock(request, sandbox, setupStatus, token, 'Vercel devbox ready', appPorts);
}

export async function renderVercelAttachNotice(
  request: ProviderBranchRequest,
  sandbox: VercelSandboxHandle,
  setupStatus: VercelSetupStatus | null,
  token: string,
  appPorts?: AppPortFlowResult,
): Promise<void> {
  await renderVercelBlock(request, sandbox, setupStatus, token, 'Vercel devbox resumed', appPorts);
}

/**
 * Render actual Sandbox routes as the logical ports the user chose.
 *
 * An app route points at a relay listener whose port is an implementation
 * detail -- the kernel picked it, and it changes whenever the relay restarts.
 * Every line is joined back through the persisted mapping and labelled with
 * the logical port, so the number printed is the one the dev server binds and
 * the one `--expose-ports` would name. A route with no mapping is printed as
 * itself rather than invented.
 */
export function renderVercelRoutes(
  routes: readonly SandboxRoute[],
  labels: Record<number, string>,
  token: string,
  relays: readonly VercelRelayMapping[] = [],
): RenderedVercelRoute[] {
  const logicalOf = new Map(relays.map((mapping) => [mapping.relayPort, mapping]));
  return [...routes]
    .map((route) => {
      const mapping = logicalOf.get(route.port);
      const logicalPort = mapping?.logicalPort ?? route.port;
      const safe = assertSafeRouteUrl(route.url);
      const url = route.port === DEVBOX_NOVNC_PROXY_PORT
        ? novncPairingUrl(safe, token)
        : safe;
      // The default label says only "the user asked for this port", which the
      // port number already says; print those as plain public routes.
      const named = labels[logicalPort] ?? mapping?.label;
      const label = named === DEFAULT_APP_PORT_LABEL ? undefined : named;
      const description = route.port === DEVBOX_NOVNC_PROXY_PORT
        ? 'noVNC display'
        : label ? `${label} — public` : 'public';
      return {
        route,
        logicalPort,
        url,
        line: `${logicalPort}: ${url}  (${description})`,
      };
    })
    .sort((left, right) => left.logicalPort - right.logicalPort);
}

// The display link carries the branch access code so a click pairs the browser.
// The proxy exchanges it for an HttpOnly cookie and redirects the code out of
// the address bar; see images/vercel/novnc-proxy.mjs.
export function novncPairingUrl(routeUrl: string, token: string): string {
  // Resolve relatively: a Vercel route may carry a path prefix that an
  // absolute '/vnc.html' would discard.
  const parsed = new URL('vnc.html', routeUrl.endsWith('/') ? routeUrl : `${routeUrl}/`);
  parsed.searchParams.set('token', token);
  parsed.searchParams.set('autoconnect', '1');
  return parsed.href;
}

export function assertSafeRouteUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VercelProviderError('route', 'Vercel route URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new VercelProviderError('route', 'Vercel route URL must use https', 2);
  }
  if (parsed.username || parsed.password) {
    throw new VercelProviderError('route', 'Vercel route URL contains embedded credentials', 2);
  }
  if (parsed.search || parsed.hash) {
    throw new VercelProviderError('route', 'Vercel route URL contains query or fragment data', 2);
  }
  return url;
}
