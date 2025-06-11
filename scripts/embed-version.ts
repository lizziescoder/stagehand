import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

type DepMap = Record<string, string>;
interface RootPackageJson {
  dependencies?:   DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}

function readUserSpec(): string | undefined {
  // 1️⃣  Start from INIT_CWD if available; else fall back to process.cwd().
  let dir = process.env.INIT_CWD || process.cwd();

  while (dir !== dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const raw = JSON.parse(readFileSync(pj, 'utf8')) as Partial<RootPackageJson> & { name?: string };

      // Skip if this is Stagehand’s own package.json
      if (raw.name === '@browserbasehq/stagehand') {
        dir = dirname(dir);
        continue;
      }

      return (
        raw.dependencies?.['@browserbasehq/stagehand'] ??
        raw.devDependencies?.['@browserbasehq/stagehand'] ??
        raw.optionalDependencies?.['@browserbasehq/stagehand']
      );
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** `true` when the string is a plain semver/range (matches npm’s semver regex) */
function looksLikeSemver(spec: string | undefined): boolean {
  return !!spec && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(spec);
}

// ---------------- main logic -----------------
const thisPkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

const userSpec = readUserSpec();

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