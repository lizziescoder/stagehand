import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PackageJson = { version: string };

const pkgPath = join(__dirname, "..", "package.json");
const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, "utf8"));

const commit: string = (() => {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "";
  }
})();

const fullVersion: `${string}` =
  commit !== "" ? `${pkg.version}+${commit}` : pkg.version;

const banner = `/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND
 *  Run \`pnpm run gen-version\` to refresh.
 */
export const STAGEHAND_VERSION = "${fullVersion}" as const;
`;

writeFileSync(join(__dirname, "..", "lib", "version.ts"), banner);
