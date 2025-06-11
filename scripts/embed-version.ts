/**
 * scripts/embed-version.ts
 * Generates lib/__generated_version.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/* ──────────────────────────────────
 * 1. Locate the nearest lock.yaml
 * ────────────────────────────────── */
function findPnpmLock(): string | undefined {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const lockPath = join(dir, '.pnpm', 'lock.yaml');
    if (existsSync(lockPath)) return lockPath;
    dir = dirname(dir);
  }
  return undefined;
}

/* ──────────────────────────────────
 * 2. Parse Stagehand’s stanza
 * ────────────────────────────────── */
function readSpecFromLock(): string | undefined {
  const lockFile = findPnpmLock();
  if (!lockFile) return undefined;

  const text = readFileSync(lockFile, 'utf8');

  // Look for the mapping key `'@browserbasehq/stagehand':`
  // then capture its `specifier:` or `version:` field
  const match =
    text.match(
      /^ {2}'@browserbasehq\/stagehand':\s*\n(?: {4}.+\n)*? {4}(?:specifier|version):\s+([^\n]+)/m,
    ) ??
    undefined;

  return match?.[1]?.trim();
}

/* ──────────────────────────────────
 * 3. Helpers
 * ────────────────────────────────── */
const semverLike = (s?: string) =>
  !!s && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(s);

function shaFromTarball(url: string): string | undefined {
  const m = url.match(/\/tar\.gz\/([a-f0-9]{7,40})/);
  return m?.[1]?.slice(0, 7);
}

/* ──────────────────────────────────
 * 4. Load Stagehand’s own package.json
 * ────────────────────────────────── */
const thisPkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

/* ──────────────────────────────────
 * 5. Signals (priority order)
 * ────────────────────────────────── */
const lockSpec   = readSpecFromLock();                 // << new
const envSpec    = process.env.npm_package_from;
const pkgSpec: string | undefined = undefined;

const explicit   = lockSpec ?? envSpec ?? pkgSpec;

const hashFromLock =
  lockSpec && lockSpec.startsWith('https://')
    ? shaFromTarball(lockSpec)
    : undefined;

const gitHash =
  thisPkg.gitHead ||
  process.env.npm_package_gitHead ||
  hashFromLock ||
  (() => {
    try { return execSync('git rev-parse --short HEAD').toString().trim(); }
    catch { return ''; }
  })() || undefined;

/* ──────────────────────────────────
 * 6. Decide version literal
 * ────────────────────────────────── */
const baseVersion =
  explicit && !semverLike(explicit)
    ? explicit                                // github:, file:, workspace:, tar.gz/sha
    : gitHash
      ? `${thisPkg.version}-${gitHash}`
      : thisPkg.version;

/* ──────────────────────────────────
 * 7. Origin tag for debugging
 * ────────────────────────────────── */
const origin =
  lockSpec     ? 'lockfile'
    : envSpec      ? 'env'
      : gitHash      ? 'git'
        :                'self';

const resolved = `${baseVersion}|${origin}`;

/* ──────────────────────────────────
 * 8. Emit generated module
 * ────────────────────────────────── */
const output = `/**
 * Auto-generated – DO NOT EDIT.
 * Format: "<version>|<origin>"
 *   • origin "lockfile" → parsed from node_modules/.pnpm/lock.yaml
 *   • origin "env"      → from npm_package_from
 *   • origin "git"      → semver + commit hash
 *   • origin "self"     → Stagehand’s own version
 */
export const STAGEHAND_VERSION: string = '${resolved}';
`;

writeFileSync(join(__dirname, '..', 'lib', '__generated_version.ts'), output);