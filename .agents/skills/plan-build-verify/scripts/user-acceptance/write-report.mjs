#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const evidenceDir = arg('evidence');
if (!evidenceDir) {
  console.error('Usage: write-report.mjs --evidence <dir>');
  process.exit(2);
}
const manifestPath = join(evidenceDir, 'evidence.json');
if (!existsSync(manifestPath)) {
  console.error(`Missing manifest: ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const reportPath = join(evidenceDir, 'evidence.md');
const requiredKind = manifest.mode === 'technical-enablement' ? 'contract' : 'e2e';
const requiredCommand = manifest.commands?.find((command) => command.kind === requiredKind && command.exit_code === 0);
const screenshots = manifest.artifacts?.filter((artifact) => artifact.type === 'screenshot') ?? [];
const videos = manifest.artifacts?.filter((artifact) => artifact.type === 'video') ?? [];
const videoSkipPattern = /^Video:\s*Skipped\s*[—-]\s*.+;\s*attempted:\s*.+;\s*suggested tooling:\s*.+$/i;
const videoSkip = manifest.notes?.find((note) => videoSkipPattern.test(note));
const hasStartingScreenshot = screenshots.some((artifact) => artifact.checkpoint === 'starting');
const hasFinalScreenshot = screenshots.some((artifact) => artifact.checkpoint === 'final');
let screenshotStatus = 'Not applicable';
if (manifest.visual === true) {
  screenshotStatus = hasStartingScreenshot && hasFinalScreenshot
    ? `Pass - ${screenshots.map((artifact) => `\`${artifact.path}\``).join(', ')}`
    : 'Blocked - starting and final screenshot artifacts are required';
}
let videoStatus = 'Not applicable';
if (manifest.visual === true) {
  if (videos.length > 0) videoStatus = `Captured - ${videos.map((artifact) => `\`${artifact.path}\``).join(', ')}`;
  else if (videoSkip) videoStatus = videoSkip;
  else videoStatus = 'Blocked - standardized video skip note missing';
}
const lines = [];
lines.push(`# UAT Evidence: ${manifest.scope}`);
lines.push('');
lines.push(`UAT Scope: ${manifest.scope}`);
lines.push(`Target: ${manifest.target}`);
lines.push(`Evidence mode: ${manifest.mode}`);
lines.push(`Timestamp: ${manifest.timestamp}`);
lines.push(`Git commit: ${manifest.git_commit}`);
lines.push('');
lines.push('## Required Evidence Status');
lines.push(`- ${requiredKind === 'e2e' ? 'E2E' : 'Contract'}: ${requiredCommand ? `Pass - \`${requiredCommand.output_path}\`` : 'Blocked - no passing captured command'}`);
lines.push(`- Screenshots: ${screenshotStatus}`);
lines.push(`- Video: ${videoStatus}`);
lines.push('');
if (manifest.mode === 'technical-enablement') {
  lines.push('## Approved Technical Enablement');
  lines.push(`- Approval: ${manifest.technical_enablement?.approval_ref ?? 'Missing'}`);
  lines.push(`- Blocker: ${manifest.technical_enablement?.blocker ?? 'Missing'}`);
  lines.push(`- Minimum scope: ${manifest.technical_enablement?.minimum_scope ?? 'Missing'}`);
  lines.push(`- Unlocked slice: ${manifest.technical_enablement?.unlocked_slice ?? 'Missing'}`);
  lines.push(`- Dependency: ${manifest.technical_enablement?.dependency_ref ?? 'Missing'}`);
  lines.push('');
}
lines.push('## Slice-by-slice result');
if (manifest.slices?.length) {
  for (const slice of manifest.slices) {
    lines.push(`- ${slice.result}: ${slice.name}${slice.summary ? ` - ${slice.summary}` : ''}`);
  }
} else {
  lines.push('- Pending: no slices recorded yet.');
}
lines.push('');
lines.push('## Evidence');
if (manifest.artifacts?.length) {
  for (const artifact of manifest.artifacts) {
    lines.push(`- \`${artifact.path}\` - ${artifact.description ?? artifact.type}`);
  }
} else {
  lines.push('- No artifacts recorded yet.');
}
lines.push('');
lines.push('## Commands');
if (manifest.commands?.length) {
  for (const command of manifest.commands) {
    lines.push(`- Exit ${command.exit_code}: \`${command.command}\` -> \`${command.output_path}\``);
  }
} else {
  lines.push('- No commands recorded yet.');
}
if (manifest.notes?.length) {
  lines.push('');
  lines.push('## Notes');
  for (const note of manifest.notes) lines.push(`- ${note}`);
}
lines.push('');
lines.push('## Manual Run Instructions');
lines.push('1. Run the product using the documented local command for this target.');
lines.push('   Expected: the feature path is reachable without setup or launch errors.');
lines.push('2. Follow the same user path described in the acceptance slices above.');
lines.push('   Expected: each passing slice reaches the visible or inspectable outcome shown in the evidence.');
lines.push('');
lines.push('Recommendation: Pending user sign-off');
lines.push('Please reply: accept / reject');
lines.push('');
writeFileSync(reportPath, lines.join('\n'));
console.log(reportPath);
