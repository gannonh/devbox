#!/usr/bin/env node
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TARGETS = ['web', 'electron', 'native', 'cli', 'tui', 'api', 'sdk', 'mixed'];
const ALWAYS_VISUAL_TARGETS = ['web', 'electron', 'native', 'tui', 'mixed'];
const COMMAND_KINDS = ['e2e', 'contract', 'supporting'];
const SLICE_RESULTS = ['Pass', 'Fail', 'Blocked', 'Not tested'];
const CHECKPOINTS = ['starting', 'key', 'final'];

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function fail(message) {
  console.error(`FAIL: ${message}`);
  failures += 1;
}
function fileIsNonempty(path) {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
}
function fileHasImageSignature(path) {
  if (!fileIsNonempty(path)) return false;
  const bytes = readFileSync(path);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpeg || gif || webp;
}
function isGitHubIssueUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/issues\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

let failures = 0;
const evidenceDir = arg('evidence');
if (!evidenceDir) {
  console.error('Usage: verify-evidence.mjs --evidence <dir>');
  process.exit(2);
}

const manifestPath = join(evidenceDir, 'evidence.json');
if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`invalid evidence.json: ${error.message}`);
}

if (manifest) {
  for (const field of ['scope', 'target', 'mode', 'timestamp', 'git_commit']) {
    if (!manifest[field]) fail(`missing manifest field ${field}`);
  }
  if (!TARGETS.includes(manifest.target)) fail(`invalid target: ${manifest.target}`);
  if (!['user-facing', 'technical-enablement'].includes(manifest.mode)) fail(`invalid evidence mode: ${manifest.mode}`);
  if (typeof manifest.visual !== 'boolean') fail('visual must be true or false');
  if (ALWAYS_VISUAL_TARGETS.includes(manifest.target) && manifest.visual !== true) {
    fail(`target ${manifest.target} must set visual to true`);
  }

  if (!Array.isArray(manifest.artifacts)) fail('artifacts must be an array');
  if (!Array.isArray(manifest.commands)) fail('commands must be an array');
  if (!Array.isArray(manifest.slices) || manifest.slices.length === 0) fail('slices must be a non-empty array');
  if (!Array.isArray(manifest.notes)) fail('notes must be an array');

  const artifacts = manifest.artifacts ?? [];
  for (const artifact of artifacts) {
    if (!artifact.path) {
      fail('artifact missing path');
      continue;
    }
    if (!fileIsNonempty(artifact.path)) fail(`artifact file is missing or empty: ${artifact.path}`);
    if (artifact.type === 'screenshot') {
      if (!CHECKPOINTS.includes(artifact.checkpoint)) fail(`screenshot needs checkpoint starting, key, or final: ${artifact.path}`);
      if (!fileHasImageSignature(artifact.path)) fail(`screenshot is not a readable PNG, JPEG, GIF, or WebP: ${artifact.path}`);
    }
  }

  const commands = manifest.commands ?? [];
  for (const command of commands) {
    if (!COMMAND_KINDS.includes(command.kind)) fail(`invalid command kind: ${command.kind}`);
    if (!command.name) fail('command missing name');
    if (!Array.isArray(command.argv) || command.argv.length === 0) fail(`command ${command.name ?? '<unnamed>'} missing argv`);
    if (!command.output_path || !fileIsNonempty(command.output_path)) fail(`command output is missing or empty: ${command.output_path ?? '<missing>'}`);
  }

  const slices = manifest.slices ?? [];
  for (const slice of slices) {
    const label = slice.name ?? slice.id ?? '<unnamed>';
    if (!slice.id || !slice.name) fail(`slice ${label} needs id and name`);
    if (!SLICE_RESULTS.includes(slice.result)) fail(`slice ${label} has invalid result: ${slice.result}`);
    if (!Array.isArray(slice.evidence) || slice.evidence.length === 0) {
      fail(`slice ${label} needs evidence paths`);
    } else {
      for (const path of slice.evidence) {
        if (!fileIsNonempty(path)) fail(`slice ${label} evidence is missing or empty: ${path}`);
      }
    }
    if (slice.result !== 'Pass') fail(`slice ${label} is ${slice.result ?? 'missing a result'}`);
  }

  const requiredKind = manifest.mode === 'technical-enablement' ? 'contract' : 'e2e';
  const hasRequiredCommand = commands.some((command) => command.kind === requiredKind && command.exit_code === 0);
  if (!hasRequiredCommand) fail(`${manifest.mode} evidence needs a passing captured command with kind ${requiredKind}`);

  if (manifest.mode === 'technical-enablement') {
    const exception = manifest.technical_enablement;
    for (const field of ['approval_ref', 'blocker', 'minimum_scope', 'unlocked_slice', 'dependency_ref']) {
      if (!exception?.[field]) fail(`technical_enablement needs ${field}`);
    }
    if (exception?.approval_ref && !isGitHubIssueUrl(exception.approval_ref)) {
      fail('technical_enablement approval_ref must be a GitHub issue or issue-comment URL');
    }
    if (exception?.dependency_ref && !isGitHubIssueUrl(exception.dependency_ref)) {
      fail('technical_enablement dependency_ref must be a GitHub issue URL');
    }
  }

  if (manifest.visual === true) {
    const screenshots = artifacts.filter((artifact) => artifact.type === 'screenshot');
    if (!screenshots.some((artifact) => artifact.checkpoint === 'starting')) {
      fail('visual evidence needs a starting screenshot');
    }
    if (!screenshots.some((artifact) => artifact.checkpoint === 'final')) {
      fail('visual evidence needs a final screenshot');
    }
    const startingPaths = new Set(screenshots.filter((artifact) => artifact.checkpoint === 'starting').map((artifact) => artifact.path));
    const hasDistinctFinal = screenshots.some((artifact) => artifact.checkpoint === 'final' && !startingPaths.has(artifact.path));
    if (startingPaths.size > 0 && !hasDistinctFinal) {
      fail('starting and final checkpoints must use distinct screenshot artifacts');
    }

    const hasVideo = artifacts.some((artifact) => artifact.type === 'video');
    const videoSkipPattern = /^Video:\s*Skipped\s*[—-]\s*.+;\s*attempted:\s*.+;\s*suggested tooling:\s*.+$/i;
    const hasVideoSkipped = (manifest.notes ?? []).some((note) => videoSkipPattern.test(note));
    if (!hasVideo && !hasVideoSkipped) {
      fail('visual evidence needs a video artifact or `Video: Skipped — <reason>; attempted: <tool>; suggested tooling: <tooling>`');
    }
  }
}

const reportPath = join(evidenceDir, 'evidence.md');
if (!fileIsNonempty(reportPath)) fail(`missing or empty ${reportPath}`);

if (failures > 0) process.exit(1);
console.log(`Evidence OK: ${evidenceDir}`);
