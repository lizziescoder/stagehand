import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';

type DepMap = Record<string, string>;
interface RootPackageJson {
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}
interface UserSpecResult {
  spec?: string;
  path?: string;   // absolute path of the manifest we read
}

/* ── find the user’s dependency spec ─────────────────────────── */
function readUserSpec(): UserSpecResult {
  let dir = process.env.INIT_CWD || process.cwd();

  while (dir !== dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const raw = JSON.parse(readFileSync(pj, 'utf8')) as Partial<RootPackageJson> & { name?: string };

      if (raw.name === '@browserbasehq/stagehand') {      // skip our own
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

/* ── helpers ──────────────────────────────────────────────────── */
const semverLike = (s?: string) =>
  !!s && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(s);

/* ── main logic ───────────────────────────────────────────────── */
const thisPkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

const { spec: userSpec, path: userPath } = readUserSpec();

const gitHash =
  thisPkg.gitHead ??
  process.env.npm_package_gitHead ??
  (() => {
    try {
      return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
      return '';
    }
  })();

/** Base version logic (unchanged) */
const baseVersion =
  userSpec && !semverLike(userSpec)
    ? userSpec
    : gitHash
      ? `${thisPkg.version}-${gitHash.slice(0, 7)}`
      : thisPkg.version;

/** ▶︎ NEW: append debug origin */
const debugOrigin = userPath
  ? `pkg:${relative(process.env.INIT_CWD || process.cwd(), userPath)}`
  : gitHash
    ? 'git'
    : 'self';

const resolved = `${baseVersion}|${debugOrigin}`;   // final literal

/* ── emit file ────────────────────────────────────────────────── */
const output = `/**
 * Auto-generated – do not edit by hand.
 * Format: "<version>|<origin>"
 *   • origin "pkg:…" → path to the consumer's package.json
 *   • origin "git"   → commit hash appended
 *   • origin "self"  → came from Stagehand’s own version field
 */
export const STAGEHAND_VERSION: string = '${resolved}';
`;

writeFileSync(join(__dirname, '..', 'lib', '__generated_version.ts'), output);