/** Zero-LLM check against the official registry/executor, including app.asar via Electron. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

if (process.argv[2] === "--child") {
  await qualify(process.argv[3], process.argv[4]);
} else {
  if (!process.argv[2]) throw Error("Usage: node tools/qualify-dsh-session-control.mjs <official @deepseek-ai directory> [Electron executable]");
  const {build} = await import("esbuild"), temporary = await mkdtemp(join(tmpdir(), "starlite-control-sdk-"));
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("starlite-control-sdk-")) throw Error("unexpected smoke directory");
  try {
    const bundle = join(temporary, "host-api.mjs");
    await build({stdin: {contents: 'export {SessionControl} from "./packages/dsh-plugin/src/session-control.ts"; export {registerSessionTools} from "./packages/dsh-plugin/src/session-tools.ts";', resolveDir: process.cwd(), sourcefile: "host-api.ts"},
      outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent"});
    const child = spawnSync(process.argv[3] ?? process.execPath, [fileURLToPath(import.meta.url), "--child", bundle, resolve(process.argv[2])], {
      env: {...process.env, ...(process.argv[3] ? {ELECTRON_RUN_AS_NODE: "1"} : {})}, windowsHide: true, encoding: "utf8", timeout: 15000,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

async function qualify(bundle, base) {
  const {SessionControl, registerSessionTools} = await import(pathToFileURL(bundle).href);
  const official = name => import(pathToFileURL(join(base, name, "lib/index.js")).href);
  const {Context} = await official("cordis"), toolsPackage = await official("dsh-tools"), skillsPackage = await official("dsh-skill");
  const host = new Context();
  host.provide("systemPrompt", {tools: () => () => {}, section: () => () => {}});
  const tools = new toolsPackage.ToolRuntime(host), skills = new skillsPackage.SkillRegistry(host), control = new SessionControl();
  // DSH 0.2.2 separates capability registration from its selected executor.
  if (typeof tools.setExecutor === "function") {
    const {NativeToolExecutor} = await official("dsh-tool-executor-native");
    tools.setExecutor(new NativeToolExecutor(host));
  }
  const dispose = registerSessionTools(host, control);
  const report = {controlVersion: 1, enabled: true, available: true, model: {revision: crypto.randomUUID(), title: "Fixture", animations: [{name: "Wave", durationMs: 1000}]}, preferences: {bubblesVisible: true, pointerEnabled: true, scale: 1}};
  const checks = [];
  try {
    assert.equal(tools.get("starlite_inspect"), undefined); checks.push("disabled catalog empty");
    control.subscribe(frame => {if (frame.kind !== "cancel" && frame.kind !== "release") control.acknowledge({controlVersion: 1, leaseId: frame.leaseId, commandId: frame.commandId, status: "completed"});});
    control.setConnected(true); control.report(report);
    for (const name of ["starlite_inspect", "starlite_control", "starlite_perform", "starlite_stage"]) {
      assert(tools.get(name), name);
      toolsPackage.assertSupportedJsonSchema(tools.get(name).output.schema);
      toolsPackage.assertObjectJsonSchema(tools.get(name).parameters);
    }
    checks.push("four schemas accepted by official registry");
    assert((await skills.get("starlite-character"))?.content.includes("starlite_inspect")); checks.push("embedded skill loaded");
    const agent = {session: {}, ctx: host};
    const execute = async (name, args) => {
      const signal = new AbortController().signal, callId = crypto.randomUUID();
      let outcome;
      if (typeof tools.setExecutor === "function") {
        const toolSet = await tools.resolve({agent, signal, modelSelection: {provider: "fixture", model: "fixture"}});
        try {
          const batch = await tools.execute({calls: [{type: "tool-call", id: callId, name, arguments: JSON.stringify(args)}], agent, signal, toolSet});
          outcome = batch.results[0]?.result;
        } finally {toolSet.dispose();}
      } else outcome = await tools.execute({callId, name, arguments: args, agent, signal});
      assert.equal(outcome.isError, false, "official executor rejected StarLite tool"); return outcome.value;
    };
    assert.equal((await execute("starlite_inspect", {})).available, true);
    assert.equal((await execute("starlite_control", {action: "acquire"})).status, "completed");
    assert.equal((await execute("starlite_perform", {animation: "Wave", text: "Hello"})).status, "completed");
    assert.equal((await execute("starlite_stage", {scale: 1.2})).status, "completed");
    assert.equal((await execute("starlite_control", {action: "release"})).status, "completed");
    checks.push("official native executor inspect/acquire/perform/stage/release");
    control.report({...report, enabled: false}); assert.equal(tools.get("starlite_inspect"), undefined); assert.equal(await skills.get("starlite-character"), undefined);
    checks.push("disable unregisters tools and skill");
    process.stdout.write(`${JSON.stringify({ok: true, checks})}\n`);
  } finally {dispose(); control.close();}
}
