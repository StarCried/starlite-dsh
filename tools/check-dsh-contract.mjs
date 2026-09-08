import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const dshRoot = resolve(
  process.argv[2]
    ?? process.env.DSH_PACKAGE_ROOT
    ?? resolve(homedir(), ".local/lib/node_modules/@deepseek-ai/dsh"),
);
const dependencyRoots = [
  resolve(dshRoot, "node_modules/@deepseek-ai"),
  resolve(dshRoot, ".."),
];
const packageJson = await readJson(resolve(dshRoot, "package.json"));

const agent = await source("dsh-agent/lib/types/runtime-types.d.ts");
const sessionIndex = await source("dsh-session/lib/types/index.d.ts");
const sessionTypes = await source("dsh-session/lib/types/types.d.ts");
// Approval's Cordis and session augmentations lived together in 0.1.0, then
// moved partly into the public `types` entrypoint in 0.1.2. Read both files so
// the guard follows the package's exported contract instead of one layout.
const approval = [
  await source("dsh-user-approval/lib/types/index.d.ts"),
  await source("dsh-user-approval/lib/types/types.d.ts"),
].join("\n");
const nestedTools = await source("dsh-tools/lib/types/types.d.ts");
const llmTypes = await source("dsh-llm/lib/types/types.d.ts");
const llmMessages = await source("dsh-llm/lib/types/message.d.ts");

const requirements = [
  ["agent/status payload", agent, /'agent\/status'[\s\S]{0,500}payload:\s*\{[\s\S]{0,180}agent:\s*Agent;[\s\S]{0,180}status:\s*AgentStatus;/u],
  ["agent/error payload", agent, /'agent\/error'[\s\S]{0,500}payload:\s*\{[\s\S]{0,180}agent:\s*Agent;[\s\S]{0,300}error:\s*unknown;/u],
  ["session/event callback", sessionIndex, /'session\/event'[^\n]*session:\s*Session,\s*event:\s*SessionEvent/u],
  ["turn/start event", sessionTypes, /'turn\/start':\s*\{/u],
  ["turn/end structured reason", sessionTypes, /'turn\/end':\s*\{[\s\S]{0,180}reason:\s*TurnEndReason;/u],
  ["completed turn reason", sessionTypes, /kind:\s*'completed'/u],
  ["blocked turn reason", sessionTypes, /kind:\s*'blocked'/u],
  ["error turn reason", sessionTypes, /kind:\s*'error'/u],
  ["assistant/chunk event", sessionTypes, /'assistant\/chunk':\s*\{/u],
  ["assistant/message event", sessionTypes, /'assistant\/message':\s*\{/u],
  ["visible text stream chunk", llmTypes, /type:\s*'text-delta';[\s\S]{0,120}text:\s*string;/u],
  ["visible reasoning stream chunk", llmTypes, /type:\s*'reasoning-delta';[\s\S]{0,120}text:\s*string;/u],
  ["visible text content block", llmTypes, /type:\s*'text';[\s\S]{0,120}text:\s*string;/u],
  ["visible reasoning content block", llmTypes, /type:\s*'reasoning';[\s\S]{0,120}text:\s*string;/u],
  ["tool/call shape", sessionTypes, /'tool\/call':\s*\{[\s\S]{0,220}callId:\s*(?:Tool)?CallId;[\s\S]{0,120}name:\s*string;[\s\S]{0,120}arguments:\s*string;/u],
  ["tool/result message", sessionTypes, /'tool\/result':\s*\{[\s\S]{0,220}message:\s*ToolResultMessage;/u],
  ["tool-result call correlation", llmMessages, /interface\s+ToolMessageSource\s*\{[\s\S]{0,160}callId:\s*(?:Tool)?CallId;/u],
  ["approval/request callback", approval, /'approval\/request'[^\n]*req:\s*ApprovalRequest(?:Event)?/u],
  ["approval/asked event", approval, /'approval\/asked':\s*\{[\s\S]{0,180}id:\s*ApprovalRequestId;[\s\S]{0,180}toolName:\s*string;/u],
  ["approval/decided event", approval, /'approval\/decided':\s*\{[\s\S]{0,180}id:\s*ApprovalRequestId;[\s\S]{0,180}outcome:\s*ApprovalOutcome;/u],
  ["nested tool start shape", nestedTools, /interface\s+(?:Code|Ptc)DispatchStartEventData\s*\{[\s\S]{0,260}subCallId:\s*(?:Tool)?CallId;[\s\S]{0,120}name:\s*string;[\s\S]{0,120}arguments:\s*unknown;/u],
  ["nested tool start event", nestedTools, /'tool\/code-dispatch-start':\s*(?:Code|Ptc)DispatchStartEventData/u],
  ["nested tool finish event", nestedTools, /'tool\/code-dispatch':\s*(?:Code|Ptc)DispatchEventData/u],
];

const missing = requirements
  .filter(([, contents, pattern]) => !pattern.test(contents))
  .map(([name]) => name);

if (missing.length > 0) {
  throw new Error(
    `Unsupported DSH ${String(packageJson.version)} contract; review the adapter before updating:\n- ${missing.join("\n- ")}`,
  );
}

console.log(`DSH ${String(packageJson.version)} exposes every required desktop-pet contract.`);

async function source(relativePath) {
  for (const root of dependencyRoots) {
    const path = resolve(root, relativePath);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `Required DSH declaration is unavailable: ${relativePath} (searched ${dependencyRoots.join(", ")})`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
