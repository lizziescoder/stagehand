import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Walk up from <cwd> until we leave every node_modules folder, then read
 * the first package.json we find.  That is the *root* project’s manifest.
 */
function findRootPackageJson(): string | null {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj) && !pj.includes('node_modules')) return pj;
    dir = dirname(dir);
  }
  return null;
}

/** The spec string the *user* wrote in their package.json, if any. */
function findUserSpec(): string | undefined {
  const rootPath = findRootPackageJson();
  if (!rootPath) return undefined;
  const root = JSON.parse(readFileSync(rootPath, 'utf8')) as Record<string, never>;
  return (
    root.dependencies?.['@browserbasehq/stagehand'] ??
    root.devDependencies?.['@browserbasehq/stagehand'] ??
    root.optionalDependencies?.['@browserbasehq/stagehand']
  );
}

/** `true` when the string is a plain semver/range (matches npm’s semver regex) */
function looksLikeSemver(spec: string | undefined): boolean {
  return !!spec && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(spec);
}

// ---------------- main logic -----------------
const thisPkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

const userSpec = findUserSpec();

/**
 * Priority order:
 * 1. If the user wrote a non-semver spec (workspace:, file:, github:, etc.),
 *    embed that exact string.
 * 2. Else, if we have a commit hash from npm/pnpm (git dependency),
 *    append it to the version from this package.json.
 * 3. Fallback: just the plain version.
 */
const gitHash =
  thisPkg.gitHead // added by npm when installing from git
  ?? process.env.npm_package_gitHead // sometimes set by pnpm
  ?? (() => {
    try {
      return execSync('git rev-parse --short HEAD').toString().trim();
    } catch { return ''; }
  })();

const resolved =
  userSpec && !looksLikeSemver(userSpec)
    ? userSpec
    : gitHash
      ? `${thisPkg.version}-${gitHash.slice(0, 7)}`
      : thisPkg.version;

const output = `/**
 * Auto-generated – do not edit by hand.
 */
export const STAGEHAND_VERSION: string = '${resolved}';
`;

writeFileSync(join(__dirname, '..', 'lib', '__generated_version.ts'), output);
console.info(`▶︎ Embedded STAGEHAND_VERSION = ${resolved}`);