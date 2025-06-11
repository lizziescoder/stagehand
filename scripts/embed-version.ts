/**
 * scripts/embed-version.ts
 *
 * Produces lib/__generated_version.ts with the literal:
 *   "<version>|<origin>"
 * Where origin ∈ { env, resolved, pkg:<path>, git, self }.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';

/* ─ types ─ */
type DepMap = Record<string, string>;
interface RootPackageJson {
  name?: string;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}
interface UserSpecResult { spec?: string; path?: string; }

/* ─ helper: walk up from INIT_CWD (if any) ─ */
function readUserSpec(): UserSpecResult {
  let dir: string | undefined = process.env.INIT_CWD;
  if (!dir) return {};

  while (dir !== dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const raw = JSON.parse(readFileSync(pj, 'utf8')) as RootPackageJson;
      if (raw.name === '@browserbasehq/stagehand') {
        dir = dirname(dir); // skip our own
        continue;
      }
      const spec =
        raw.dependencies?.['@browserbasehq/stagehand'] ??
        raw.devDependencies?.['@browserbasehq/stagehand'] ??
        raw.optionalDependencies?.['@browserbasehq/stagehand'];
      if (spec) return { spec, path: pj };
    }
    dir = dirname(dir);
  }
  return {};
}

/* ─ semver quick-check ─ */
const semverLike = (s?: string) =>
  !!s && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(s);

/* ─ Stagehand’s own manifest ─ */
const thisPkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

/* ─ signals, in priority order ─ */
const envSpec         = process.env.npm_package_from;            // rarely set by pnpm
const resolvedUrl     = process.env.npm_package_resolved;        // always set by pnpm
const { spec, path }  = readUserSpec();

const explicitSpec    = envSpec ?? spec;

/* attempt to pull a 7-char commit hash from the resolved tarball URL */
const resolvedHash    =
  resolvedUrl?.match(/\/tar\.gz\/([a-f0-9]{7,40})$/)?.[1]?.slice(0, 7) ?? '';

const gitHash         =
  thisPkg.gitHead ??
  process.env.npm_package_gitHead ??
  resolvedHash ??
  (() => {                                   // local dev fallback
    try { return execSync('git rev-parse --short HEAD').toString().trim(); }
    catch { return ''; }
  })();

/* ─ decide the version literal ─ */
const baseVersion =
  explicitSpec && !semverLike(explicitSpec)
    ? explicitSpec                           // e.g. github:, file:, workspace:
    : gitHash
      ? `${thisPkg.version}-${gitHash}`      // semver + hash
      : thisPkg.version;                     // plain registry install

/* ─ origin tag for debugging ─ */
const origin =
  envSpec      ? 'env'
    : resolvedHash ? 'resolved'
      : path         ? `pkg:${relative(process.env.INIT_CWD ?? '', path)}`
        : gitHash      ? 'git'
          :                'self';

const resolved = `${baseVersion}|${origin}`;

/* ─ emit file ─ */
const output = `/**
 * Auto-generated – DO NOT EDIT.
 * Format: "<version>|<origin>".
 */
export const STAGEHAND_VERSION: string = '${resolved}';
`;

writeFileSync(join(__dirname, '..', 'lib', '__generated_version.ts'), output);