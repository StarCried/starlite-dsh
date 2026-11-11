import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCurrentDocs, docsOnly, syncVersions } from "./release-state.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = await syncVersions(root);
await checkCurrentDocs(root, version);
const [base] = process.argv.slice(2);
if (base) {
  if (!/^[a-f0-9]{40}$/u.test(base)) throw Error("Expected a base commit SHA");
  const paths = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {cwd: root, encoding: "utf8", windowsHide: true}).trim().split(/\r?\n/u).filter(Boolean);
  const full = !docsOnly(paths);
  console.log(JSON.stringify({full, paths}));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `full=${full}\n`);
} else console.log(`Current release docs and owned versions agree: ${version}`);
