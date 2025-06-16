import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PackageJson = { version: string };

const pkg: PackageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
);

const commit = (() => {
  try {
    // full 40-char hash so it’s unambiguous
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    // happens only when building from a git-archive tarball that has no .git
    return "unknown";
  }
})();

const fullVersion = `${pkg.version}+${commit}` as const;

const banner = `/**
 * ⚠️  AUTO-GENERATED — DO NOT EDIT BY HAND
 *  Run \`pnpm run gen-version\` to refresh.
 */
export const STAGEHAND_VERSION = "${fullVersion}" as const;
`;

writeFileSync(join(__dirname, "..", "lib", "version.ts"), banner);
console.log(`Generated Stagehand version: ${fullVersion}`);
