import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';

type DepMap = Record<string, string>;

interface RootPackageJson {
  name?: string;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}

/** Information about what the consumer wrote in their package.json. */
interface UserSpecResult {
  /** The dependency spec string (e.g. "workspace:*", "file:../stagehand"). */
  spec?: string;
  /** Absolute path of the manifest we found it in. */
  path?: string;
}

function readUserSpec(): UserSpecResult {
  let dir: string | undefined = process.env.INIT_CWD || process.cwd();

  while (dir && dir !== dirname(dir)) {
    const pj = join(dir, 'package.json');

    if (existsSync(pj)) {
      const raw = JSON.parse(readFileSync(pj, 'utf8')) as RootPackageJson;

      // Skip our own manifest inside the store
      if (raw.name === '@browserbasehq/stagehand') {
        dir = dirname(dir);
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

const semverLike = (s?: string): boolean =>
  !!s && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(s);

const thisPkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

// 1️⃣  Preferred: npm / pnpm provide the exact spec via env-var
const envSpec: string | undefined = process.env.npm_package_from;

// 2️⃣  Fallback: try to locate the consumer’s package.json (works in Yarn & others)
const { spec: userSpec, path: userPath } = readUserSpec();
const explicitSpec = envSpec ?? userSpec;

// Commit hash visible when installed from a git URL
const gitHash: string =
  thisPkg.gitHead ??
  process.env.npm_package_gitHead ??
  (() => {
    try {
      return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
      return '';
    }
  })();

// Compute the base version string
const baseVersion: string =
  explicitSpec && !semverLike(explicitSpec)
    ? explicitSpec
    : gitHash
      ? `${thisPkg.version}-${gitHash.slice(0, 7)}`
      : thisPkg.version;

// Produce an origin tag for debugging
const debugOrigin: string = envSpec
  ? 'env'
  : userPath
    ? `pkg:${relative(process.env.INIT_CWD || process.cwd(), userPath)}`
    : gitHash
      ? 'git'
      : 'self';

// Final literal that will be imported by library code
const resolved: string = `${baseVersion}|${debugOrigin}`;

const output = `/**
 * Auto-generated – DO NOT EDIT.
 *
 * Format: "<version>|<origin>"
 *   • origin "env"   → from npm_package_from
 *   • origin "pkg:…" → from consumer package.json
 *   • origin "git"   → semver + commit hash
 *   • origin "self"  → Stagehand’s own version
 */
export const STAGEHAND_VERSION: string = '${resolved}';
`;

writeFileSync(join(__dirname, '..', 'lib', '__generated_version.ts'), output);