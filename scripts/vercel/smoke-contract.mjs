const SLUG = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';
const DIGEST = 'sha256:[a-f0-9]{64}';
const FULL_VCR_REFERENCE = new RegExp(
  `^vcr\\.vercel\\.com/(${SLUG})/(${SLUG})/(${SLUG})@(${DIGEST})$`,
);

/**
 * Parse the only image-reference shape accepted by the smoke gate.
 * Tags, bare names, and references from another registry are rejected before
 * any Sandbox API call is attempted.
 */
export function parseFullyQualifiedVcrReference(value) {
  const match = FULL_VCR_REFERENCE.exec(value);
  if (!match) {
    throw new Error(
      'IMAGE_REF must be a fully-qualified VCR digest reference: vcr.vercel.com/<team>/<project>/<repository>@sha256:<64 hex digits>',
    );
  }
  return {
    registry: 'vcr.vercel.com',
    team: match[1],
    project: match[2],
    repository: match[3],
    digest: match[4],
  };
}

export const REQUIRED_SMOKE_CHECKS = Object.freeze([
  'image digest',
  'non-root user',
  'expected non-root identity',
  'passwordless sudo',
  'binary pi',
  'binary claude',
  'binary codex',
  'binary opencode',
  'binary gh',
  'binary node',
  'binary bun',
  'binary python',
  'binary chromium',
  'binary Xvfb',
  'binary fluxbox',
  'binary x11vnc',
  'binary websockify',
  'explicit startup',
  'display and proxy processes',
  'noVNC serves the pairing form unpaired',
  'noVNC rejects a wrong access code',
  'noVNC pairs the access code into a cookie',
  'paired noVNC HTTP',
  'noVNC rejects unpaired WebSocket',
  'noVNC rejects a wrong WebSocket cookie',
  'paired noVNC WebSocket',
  'terminal session',
]);

export const REQUIRED_SMOKE_TIMINGS = Object.freeze([
  'create',
  'session-create',
  'startup',
  'http',
  'websocket',
  'terminal',
  'session-terminal',
  'stop',
  'snapshot-cleanup',
  'delete',
]);

export { FULL_VCR_REFERENCE };
