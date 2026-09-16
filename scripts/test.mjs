// Cross-platform test entry point.
//
// `node --test dist/**/*.test.js` relies on the shell expanding the glob, which
// cmd.exe / PowerShell on Windows do not do. Node 21+ expands globs itself, but
// Node 20 does not, so the only form that works on every supported Node version
// and shell is an explicit list of files.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = join("dist", "test");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(dir, name));

if (files.length === 0) {
  console.error(`No test files found in ${dir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
