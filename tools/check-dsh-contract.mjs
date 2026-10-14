import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { navigationContract } from "./dsh-navigation-contract.mjs";
import { desktopNavigationContract } from "./dsh-desktop-contract.mjs";
import { questionLifecycleContract } from "./dsh-questions-contract.mjs";

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
const questions = await source("dsh-user-questions/lib/types/types.d.ts");
const questionLifecycle = questionLifecycleContract({
  questions,
  service: await source("dsh-user-questions/lib/types/index.d.ts"),
  fold: await optionalSource("dsh-user-questions/lib/types/projection.d.ts"),
  projections: await optionalSource("dsh-session-projection/lib/types/index.d.ts"),
  agents: await source("dsh-agent/lib/types/index.d.ts"),
});
const titles = await source("dsh-session-title/lib/types/index.d.ts");
const clientSessions = await source("dsh-api-session-controller/lib/types/client/contract/sessions.d.ts");
const navigation = navigationContract({
  sessions: clientSessions,
  list: await source("dsh-api-session-controller/lib/types/client/sessions/service.d.ts"),
  projections: await source("dsh-api-session-controller/lib/types/client/sessions/manager.d.ts"),
  workspace: await optionalSource("dsh-client-ui-workspace/lib/types/client/navigation.d.ts"),
  catalog: await optionalSource("dsh-subagent/lib/types/projection-types.d.ts"),
});
const webServer = await source("dsh-host-webserver/lib/types/index.d.ts");
const connection = await source("dsh-client-connection/lib/types/rpc.d.ts");

// DSH 0.1.5 moved transient chunks out of SessionEventMap. If the new stream
// exists, validate its payload and frame shapes even if an older declaration
// also remains. A renamed event alone is not evidence of compatibility.
const usesAgentStream = /'agent\/assistant-stream'\s*\(/u.test(agent);
const streamRequirements = usesAgentStream ? [
  ["agent/assistant-stream payload", agent, /'agent\/assistant-stream'[^\n]*payload:\s*\{\s*agent:\s*Agent;\s*frame:\s*AssistantStreamFrame;/u],
  ["assistant stream start frame", agent, /type\s+AssistantStreamFrame\s*=\s*\{\s*readonly\s+type:\s*'start';/u],
  ["assistant stream chunk frame", agent, /\{\s*readonly\s+type:\s*'chunk';[^}]*readonly\s+chunk:\s*StreamChunk;/u],
] : [
  ["assistant/chunk shape", sessionTypes, /'assistant\/chunk':\s*\{[^}]*chunk:\s*StreamChunk;/u],
];

const requirements = [
  ["ordinary question waterfall", questions, /'user-questions\/request'[^\n]+next:\s*\(\)\s*=>\s*Promise<AskUserQuestionAnswer>/u],
  ["question choices and multiple selection", questions, /options\?: AskUserQuestionOption\[\];[\s\S]{0,200}multiSelect\?: boolean;/u],
  ["question answer shape", questions, /selected: string\[\];[\s\S]{0,160}custom\?: string;/u],
  ["session title read", titles, /get\(session: Session\): SessionTitleSnapshot \| undefined;/u],
  ["loopback web server port", webServer, /get port\(\): number;/u],
  ["loopback web server host", webServer, /get host\(\): Config\['host'\];/u],
  ["browser authentication URL", connection, /authenticatedUrl\(baseUrl: string\): string;/u],
  ["agent/status payload", agent, /'agent\/status'[\s\S]{0,500}payload:\s*\{[\s\S]{0,180}agent:\s*Agent;[\s\S]{0,180}status:\s*AgentStatus;/u],
  ["agent/error payload", agent, /'agent\/error'[\s\S]{0,500}payload:\s*\{[\s\S]{0,180}agent:\s*Agent;[\s\S]{0,300}error:\s*unknown;/u],
  ["session/event callback", sessionIndex, /'session\/event'[^\n]*session:\s*Session,\s*event:\s*SessionEvent/u],
  ["turn/start event", sessionTypes, /'turn\/start':\s*\{/u],
  ["turn/end structured reason", sessionTypes, /'turn\/end':\s*\{[\s\S]{0,180}reason:\s*TurnEndReason;/u],
  ["completed turn reason", sessionTypes, /kind:\s*'completed'/u],
  ["blocked turn reason", sessionTypes, /kind:\s*'blocked'/u],
  ["error turn reason", sessionTypes, /kind:\s*'error'/u],
  ...streamRequirements,
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
  ["nested tool start event", nestedTools, /'tool\/(?:code|ptc)-dispatch-start':\s*(?:Code|Ptc)DispatchStartEventData/u],
  ["nested tool finish event", nestedTools, /'tool\/(?:code|ptc)-dispatch':\s*(?:Code|Ptc)DispatchEventData/u],
];

const missing = requirements
  .filter(([, contents, pattern]) => !pattern.test(contents))
  .map(([name]) => name).concat(navigation.missing,questionLifecycle.missing);

if (missing.length > 0) {
  throw new Error(
    `Unsupported DSH ${String(packageJson.version)} contract; review the adapter before updating:\n- ${missing.join("\n- ")}`,
  );
}

console.log(`DSH ${String(packageJson.version)} exposes every required desktop-pet contract.`);
console.log(`DSH client navigation: ${navigation.kind}.`);
console.log(`DSH ordinary questions: ${questionLifecycle.kind}.`);

const desktopNavigation = desktopNavigationContract({
  context: await optionalSource("cordis/lib/types/context.d.ts"),
  registry: await optionalSource("cordis/lib/types/registry.d.ts"),
  fiber: await optionalSource("cordis/lib/types/fiber.d.ts"),
  profile: await optionalSource("dsh-app-boot/lib/types/profile-context.d.ts"),
  rpc: connection,
  host: await optionalSource("dsh-client-connection/lib/types/rpc-host.d.ts"),
  client: await optionalSource("dsh-client-connection/lib/types/client/index.d.ts"),
});
// Old supported Web builds need no Desktop carrier. New release qualification
// explicitly requires its complete shape; method names alone are insufficient.
if (process.argv.includes("--desktop") && !desktopNavigation.supported) {
  throw new Error(`DSH Desktop navigation contract changed:\n- ${desktopNavigation.missing.join("\n- ")}`);
}
console.log(`DSH Desktop navigation: ${desktopNavigation.supported ? "public profile + authenticated Connection RPC" : "not qualified (Web only)"}.`);

// Fees are optional at runtime, but a release advertising them must verify
// the public read/credential seams and durable usage vocabulary as well.
const [settings, credentials, persistence, handle, nativeDeepSeek, launchEnvironment, llmService, nativeApiKey, nativeApiKeyConfig, nativeApiKeyImplementation, deepSeekConfig, settingsEvents] = await Promise.all([
  source("dsh-settings/lib/types/index.d.ts"),
  source("dsh-credentials/lib/types/index.d.ts"),
  source("dsh-session-persistence/lib/types/index.d.ts"),
  source("dsh-session-persistence/lib/types/handle.d.ts"),
  source("dsh-llm-deepseek/lib/types/index.d.ts"),
  source("dsh-launch-environment/lib/types/index.d.ts"),
  source("dsh-llm/lib/types/index.d.ts"),
  optionalSource("dsh-llm-deepseek-api-key/lib/types/index.d.ts"),
  optionalSource("dsh-llm-deepseek-api-key/lib/types/config.d.ts"),
  optionalSource("dsh-llm-deepseek-api-key/lib/index.js"),
  optionalSource("dsh-llm-deepseek/lib/types/config.d.ts"),
  optionalSource("dsh-settings/lib/types/types.d.ts"),
]);
const namespaceSettings = /get<const Namespace extends string>\([^\n]+\): unknown;/u.test(settings);
const providerRequirements = namespaceSettings ? [
  ["settings resolved read", settings, /get<const Namespace extends string>\([^\n]+\): unknown;/u],
  ["native DeepSeek route", nativeDeepSeek, /`deepseek-official`/u],
  ["native DeepSeek settings namespace", nativeDeepSeek, /export declare const name = "llm-deepseek";/u],
  ["native DeepSeek credential reference", nativeDeepSeek, /apiKeyEnv\?: string;/u],
  ["native DeepSeek endpoint", nativeDeepSeek, /baseURL\?: string;/u],
  ["native DeepSeek official default", nativeDeepSeek, /PUBLIC_BASE_URL = "https:\/\/api\.deepseek\.com"/u],
] : [
  ["redacted live settings read", settings, /describe\(options\?: SettingsDescribeOptions\): SettingsDescriptor\[\];/u],
  ["settings secret redaction option", settings, /redactSecrets\?: boolean;/u],
  ["settings descriptor namespace", settings, /ns: SettingsNamespace;/u],
  ["settings descriptor plain value", settings, /value: unknown;/u],
  ["live settings change notification", settingsEvents ?? "", /'settings\/document-updated'\(ns: SettingsNamespace, revision: number\): void;/u],
  ["configurable provider directory", llmService, /listConfigurableProviders\(\): LlmConfigurableProvider\[\];/u],
  ["provider settings namespace", llmTypes, /settingsNs: string;/u],
  ["provider settings path", llmTypes, /settingsPath: readonly string\[\];/u],
  ["native DeepSeek API-key owner", nativeApiKey ?? "", /export declare const name = "llm-deepseek-api-key";/u],
  ["native DeepSeek API-key route registration", nativeApiKeyImplementation ?? "", /const PROVIDER = "deepseek-official";/u],
  ["native DeepSeek API-key settings directory", nativeApiKeyImplementation ?? "", /ctx\.llm\.registerConfigurableProviders\(/u],
  ["native DeepSeek credential reference", nativeApiKeyConfig ?? "", /apiKeyEnv\?: string;/u],
  ["native DeepSeek live endpoint", deepSeekConfig ?? "", /baseURL: Volatile<string \| undefined>;/u],
  ["native DeepSeek official default", deepSeekConfig ?? "", /PUBLIC_BASE_URL = "https:\/\/api\.deepseek\.com\/anthropic"/u],
];
const billingRequirements = [
  ...providerRequirements,
  ["credential reference read", credentials, /abstract resolve\(ref: CredentialRef\): Promise<ResolvedCredential \| undefined>;/u],
  ["credential record read", credentials, /abstract readRecord\(key: CredentialKey\): Promise<CredentialRecord \| undefined>;/u],
  ["trusted launch environment", launchEnvironment, /DSH_LAUNCH_ENVIRONMENT_KEY = "launchEnvironment"/u],
  ["launch environment value read", launchEnvironment, /get\(name: string\): LaunchEnvironmentEntry \| undefined;/u],
  ["stored session list", persistence, /abstract list\(options\?: SessionPersistenceListOptions\): Promise<readonly SessionPersistenceSnapshot\[\]>;/u],
  ["read-only session open", persistence, /abstract open\(id: SessionId, access: SessionAccess,/u],
  ["inherited event boundary", handle, /readonly inheritedEventCount: SessionLogOffset;/u],
  ["bounded event read", handle, /read\(offset\?: number, length\?: number, options\?: SessionHandleReadOptions\): Promise<SessionHandleReadResult>;/u],
  ["durable event timestamp", sessionTypes, /time: number;/u],
  ["attempt settlement", sessionTypes, /'assistant\/attempt':\s*\{/u],
  ["usage sample", llmTypes, /interface TokenUsage\s*\{[\s\S]{0,100}inputTokens: number;\s*outputTokens: number;/u],
];
const billingMissing = billingRequirements.filter(([, contents, pattern]) => !pattern.test(contents)).map(([label]) => label);
if (billingMissing.length) throw new Error(`DSH billing contract changed; review before release:\n- ${billingMissing.join("\n- ")}`);
console.log(`DSH ${String(packageJson.version)} exposes the read-only billing contracts.`);
console.log(`DSH billing settings: ${namespaceSettings ? "namespace" : "provider directory + redacted descriptors"}.`);

async function source(relativePath) {
  const contents = await optionalSource(relativePath);
  if (contents !== undefined) return contents;
  throw new Error(
    `Required DSH declaration is unavailable: ${relativePath} (searched ${dependencyRoots.join(", ")})`,
  );
}

async function optionalSource(relativePath) {
  for (const root of dependencyRoots) {
    const path = resolve(root, relativePath);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
