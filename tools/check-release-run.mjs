import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { assertPreparedRun, json, REPOSITORY, verifyFiles } from "./release-state.mjs";

const [runId, manifestPath] = process.argv.slice(2);
if (!/^[1-9]\d*$/u.test(runId ?? "")) throw Error("A preparation run_id is required");
const run = JSON.parse(execFileSync("gh", ["api", `repos/${REPOSITORY}/actions/runs/${runId}`], {encoding: "utf8", windowsHide: true}));
if (String(run.id) !== runId) throw Error("Unexpected preparation run_id");
const manifest = manifestPath ? await json(manifestPath) : undefined;
const revision = assertPreparedRun(run, manifest);
if (manifest) await verifyFiles(manifest, dirname(resolve(manifestPath)));
console.log(`Verified preparation run ${runId} at ${revision}${manifest ? " and archived files" : ""}`);
