import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ---------- helpers ---------- */
const semverLike = (s?: string) =>
  !!s && /^(\d+\.)?(\d+\.)?(\*|\d+)(?:[-^~<>=].*)?$/.test(s);

/** extract a 7-char commit hash from a GitHub tarball URL */
const hashFromResolved = (url: string | undefined): string | undefined => {
  const m = url?.match(/\/tar\.gz\/([a-f0-9]{7,40})/);
  return m ? m[1].slice(0, 7) : undefined;
};

/* ---------- Stagehand’s own manifest ---------- */
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; gitHead?: string };

/* ---------- signals available in every installer ---------- */
const resolvedUrl   = process.env.npm_package_resolved;         // always for pnpm
const envSpec       = process.env.npm_package_from ?? undefined;
const resolvedHash  = hashFromResolved(resolvedUrl);
const gitHeadVar    = process.env.npm_package_gitHead ?? pkg.gitHead;

/* ---------- decide the base version ---------- */
let literal = pkg.version;          // default fallback
let origin  = 'self';               // default origin tag

if (envSpec && !semverLike(envSpec)) {
  // spec is something like "github:user/repo#branch" or "file:../stagehand"
  literal = envSpec;
  origin  = 'env';
} else if (resolvedHash) {
  literal = `${pkg.version}-${resolvedHash}`;
  origin  = 'resolved';
} else if (gitHeadVar) {
  literal = `${pkg.version}-${gitHeadVar.slice(0, 7)}`;
  origin  = 'git';
}

/* ---------- emit the generated module ---------- */
const file = `/**
 * Auto-generated – do not edit.
 * Format: "<version>|<origin>"
 */
export const STAGEHAND_VERSION: string = '${literal}|${origin}';
`;

writeFileSync(join(__dirname, '..', 'lib', '__generated_version.ts'), file);