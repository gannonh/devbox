#!/usr/bin/env node
/**
 * Resolve the current digest behind Vercel's managed Universal image by
 * creating a short-lived Sandbox.  This avoids relying on a floating tag in a
 * Dockerfile while allowing the scheduled workflow to detect upstream drift.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Sandbox } from '@vercel/sandbox';

const startedAt = new Date().toISOString();
const reportPath = process.env.BASE_DIGEST_EVIDENCE;
const credentials = {
  ...(process.env.VERCEL_TOKEN ? { token: process.env.VERCEL_TOKEN } : {}),
  ...(process.env.VERCEL_TEAM_ID ? { teamId: process.env.VERCEL_TEAM_ID } : {}),
  ...(process.env.VERCEL_PROJECT_ID ? { projectId: process.env.VERCEL_PROJECT_ID } : {}),
};
let sandbox;
const report = {
  operation: 'resolve-universal-digest',
  requestedImage: 'vercel/sandbox/universal',
  startedAt,
  credentials: { scopedProject: Boolean(credentials.projectId), tokenSupplied: Boolean(credentials.token) },
};

try {
  sandbox = await Sandbox.create({
    ...credentials,
    image: 'vercel/sandbox/universal',
    timeout: 120_000,
    persistent: false,
    tags: { 'devbox-image': 'base-digest-probe' },
  });
  const resolved = sandbox.image ?? '';
  const match = /@(?<digest>sha256:[a-f0-9]{64})$/i.exec(resolved);
  if (!match) {
    throw new Error('Sandbox did not return a full Universal manifest digest');
  }
  report.resolvedImage = resolved.replace(/@sha256:.+$/, '@[digest]');
  report.digest = match.groups.digest;
  report.finishedAt = new Date().toISOString();
  console.log(match.groups.digest);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw new Error(`Unable to resolve the Universal base digest: ${report.error}`);
} finally {
  if (sandbox) {
    try {
      await sandbox.stop();
      report.sessionStatusAfterStop = sandbox.status;
    } catch (error) {
      report.stopError = error instanceof Error ? error.message : String(error);
    }
    try {
      await sandbox.delete();
      report.deleted = true;
    } catch (error) {
      report.deleteError = error instanceof Error ? error.message : String(error);
    }
  }
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true }).catch(() => {});
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (report.stopError || report.deleteError) {
  process.exitCode = 1;
}
