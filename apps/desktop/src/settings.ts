import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmResourceLicense, showResourceLicense, type ResourcePackInspection } from "./resource-pack-dialog.js";
import type { AnimationSource, AnimationMappings, AnimationState, DesktopPreferences, DesktopSettings, LibraryModel, ModelInspection, ModelInstallRequest } from "./types.js";

const STATES: ReadonlyArray<{ key: AnimationState; label: string; required: boolean }> = [
  { key: "idle", label: "待机（必填）", required: true },
  { key: "working", label: "工作中（含思考）", required: false },
  { key: "completed", label: "完成", required: false },
  { key: "error", label: "出错", required: false },
  { key: "blocked", label: "遇到阻碍", required: false },
  { key: "approval", label: "等待确认", required: false },
  { key: "click", label: "点击回应", required: false },
  { key: "ambient", label: "偶发小动作", required: false },
];

interface SettingsWrite {
  key: string;
  operation: () => Promise<DesktopSettings>;
  waiters: Array<{ resolve: (settings: DesktopSettings) => void; reject: (reason: unknown) => void }>;
}
const PREFERENCE_FIELDS = {
  fps:"fps", dpr:"maxDevicePixelRatio", scale:"scale", privacy:"privacyMode", "bubble-mode":"bubbleMode",
} as const;

export async function startSettings(): Promise<void> {
  let settings = await invoke<DesktopSettings>("get_settings");
  let inspection: ModelInspection | undefined;
  let sourcePath: string | undefined;
  let animationSources: AnimationSource[] = [];
  let profilePath: string | undefined;
  let generation = 0;
  let checking = false;
  let importing = false;
  let writing = false;
  let preferenceRevision = 0;
  let settingsRevision = 0;
  const dirtyPreferences = new Map<keyof DesktopPreferences, number>();
  const failedWrites = new Map<string, string>();
  const pendingWrites: SettingsWrite[] = [];
  const library = requiredElement("model-library");
  const choose = requiredElement<HTMLButtonElement>("choose-model");
  const importPack = requiredElement<HTMLButtonElement>("import-resource-pack");
  const chooseAnimations = requiredElement<HTMLButtonElement>("choose-animations");
  const chooseProfile = requiredElement<HTMLButtonElement>("choose-profile");
  const clearProfile = requiredElement<HTMLButtonElement>("clear-profile");
  const importButton = requiredElement<HTMLButtonElement>("import-model");
  const importLicense = requiredElement<HTMLButtonElement>("view-import-license");
  const importDialog = requiredElement<HTMLDialogElement>("add-model-dialog");
  const importError = requiredElement("import-error");
  const resources = requiredElement("vrm-resources");
  const pathLabel = requiredElement("model-path");
  const status = requiredElement("inspection-status");
  const error = requiredElement("settings-error");
  const saveStatus = requiredElement("settings-status");
  const form = requiredElement<HTMLFormElement>("settings-form");
  const mappings = requiredElement("animation-mappings");
  const importMappings = requiredElement("import-mappings");

  populatePreferences(settings.preferences);
  const activeModel = () => settings.models.find(model => model.id === settings.activeModelId);
  const mergedPreferences = (): DesktopPreferences => {
    const visible = readPreferences();
    return {...settings.preferences, ...Object.fromEntries([...dirtyPreferences.keys()].map(key => [key, visible[key]]))};
  };
  let displayedMapping = "";
  let displayedLibrary = "";

  const updateImport = () => {
    const idle = importMappings.querySelector<HTMLSelectElement>('select[data-state="idle"]')?.value;
    importButton.disabled = importing || checking || !sourcePath || inspection?.backend !== "vrm" || !inspection.compatibilitySupported || !idle;
    importPack.disabled = importing || checking;
    choose.disabled = importing;
    for (const button of [chooseAnimations, chooseProfile, clearProfile]) button.disabled = importing || checking;
    requiredElement<HTMLButtonElement>("close-model-import").disabled = importing;
  };
  const render = () => {
    const model = activeModel();
    const signature = JSON.stringify([settings.activeModelId, settings.models.map(({ id, title, backend, animations }) => ({ id, title, backend, count: animations.length }))]);
    if (signature !== displayedLibrary) {
      displayedLibrary = signature;
      renderLibrary(library, settings.models, settings.activeModelId, selectModel, viewLicense, openImport);
    }
    // Saving a preference or mapping must not replace the focused field.
    const mappingSignature = JSON.stringify([model?.id, model?.animations]);
    if (mappingSignature !== displayedMapping) {
      displayedMapping = mappingSignature;
      renderMappings(mappings, model?.animations ?? [], model?.mappings, "animation-pool-help");
      requiredElement("mapping-section").hidden = !model;
    }
  };
  const adoptSettings = (next: DesktopSettings) => {
    settings = next;
    const visible = readUncheckedPreferences();
    populatePreferences(Object.fromEntries(Object.entries(next.preferences).map(([key, value]) => [key, dirtyPreferences.has(key as keyof DesktopPreferences) ? visible[key as keyof DesktopPreferences] : value])) as unknown as DesktopPreferences);
    render();
  };
  const drainWrites = async () => {
    if (writing) return;
    writing = true;
    while (pendingWrites.length) {
      const next = pendingWrites.shift()!;
      saveStatus.textContent = "正在保存…";
      const revision = settingsRevision;
      try {
        const result = await next.operation();
        if (settingsRevision === revision) adoptSettings(result);
        failedWrites.delete(next.key);
        error.textContent = [...failedWrites.values()].at(-1) ?? "";
        saveStatus.textContent = failedWrites.size ? "部分更改未保存" : settings.activeModelId === "weiguang-default" && !activeModel() ? "重启 DSH 后自动下载微光资源。" : "已自动保存";
        for (const waiter of next.waiters) waiter.resolve(result);
      } catch (reason) {
        failedWrites.set(next.key, safeError(reason));
        error.textContent = safeError(reason);
        saveStatus.textContent = "更改未保存";
        for (const waiter of next.waiters) waiter.reject(reason);
      }
    }
    writing = false;
  };
  const enqueueWrite = (key: string, operation: SettingsWrite["operation"]): Promise<DesktopSettings> => {
    const result = new Promise<DesktopSettings>((resolve, reject) => {
      const queued = pendingWrites.find(write => write.key === key);
      if (queued) { queued.operation = operation; queued.waiters.push({resolve, reject}); }
      else pendingWrites.push({key, operation, waiters: [{resolve, reject}]});
    });
    // Start in a microtask so several synchronous edits become one write.
    void Promise.resolve().then(drainWrites);
    return result;
  };
  const reportFailure = (reason: unknown) => { error.textContent = safeError(reason); };

  function selectModel(modelId: string | null): void {
    void enqueueWrite("selection", () => invoke<DesktopSettings>("select_model", {modelId})).catch(reportFailure);
  }
  async function viewLicense(modelId: string): Promise<void> {
    try {
      const license = await invoke<{title: string; text: string} | null>("get_model_license", {modelId});
      if (!license) throw new Error("模型未提供许可信息，请向模型作者确认使用范围。");
      showResourceLicense(license);
    } catch (reason) { reportFailure(reason); }
  }
  function openImport(): void { if (!importDialog.open) importDialog.showModal(); }

  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("change", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    try {
      if (target.closest(".preferences")) {
        readPreferences();
        const field = PREFERENCE_FIELDS[target.id as keyof typeof PREFERENCE_FIELDS];
        if (!field) return;
        dirtyPreferences.set(field, ++preferenceRevision);
        void enqueueWrite("preferences", async () => {
          const revisions = new Map(dirtyPreferences);
          const preferences = mergedPreferences();
          const result = await invoke<DesktopSettings>("update_preferences", {preferences});
          for (const [key, revision] of revisions) if (dirtyPreferences.get(key) === revision) dirtyPreferences.delete(key);
          return result;
        }).catch(reportFailure);
      } else if (target.closest("#animation-mappings")) {
        const modelId = settings.activeModelId;
        if (!modelId) return;
        const nextMappings = readMappings(mappings);
        void enqueueWrite("mappings:" + modelId, () => invoke<DesktopSettings>("update_model_mappings", {modelId, mappings: nextMappings})).catch(reason => {
          if (settings.activeModelId === modelId && !pendingWrites.some(write => write.key === "mappings:" + modelId)) {
            renderMappings(mappings, activeModel()?.animations ?? [], activeModel()?.mappings, "animation-pool-help");
          }
          reportFailure(reason);
        });
      }
    } catch (reason) {
      if (target.closest("#animation-mappings")) renderMappings(mappings, activeModel()?.animations ?? [], activeModel()?.mappings, "animation-pool-help");
      reportFailure(reason); saveStatus.textContent = "更改未保存";
    }
  });
  requiredElement("close-model-import").addEventListener("click", () => importDialog.close());
  importDialog.addEventListener("cancel", event => { if (importing) event.preventDefault(); });
  importMappings.addEventListener("change", updateImport);
  importLicense.addEventListener("click", () => { if (inspection?.license) showResourceLicense(inspection.license); });

  const clearImport = () => {
    generation++;
    sourcePath = undefined; inspection = undefined; animationSources = []; profilePath = undefined;
    resources.hidden = true; importLicense.hidden = true;
    pathLabel.textContent = "尚未选择";
    importMappings.replaceChildren(); status.textContent = ""; importError.textContent = "";
    updateImport();
  };
  const importResource = async () => {
    if (importing || checking) return;
    importing = true; importError.textContent = ""; updateImport();
    try {
      const path = await open({title:"选择独立授权的资源包",multiple:false,directory:false,filters:[{name:"StarLite 资源包",extensions:["zip"]}]});
      if (typeof path !== "string") return;
      status.textContent = "正在检查资源包…";
      const pack = await invoke<ResourcePackInspection>("inspect_resource_pack", {path});
      if (!await confirmResourceLicense(pack)) { status.textContent = "已取消导入。"; return; }
      status.textContent = "正在导入…";
      await enqueueWrite("import", () => invoke<DesktopSettings>("install_resource_pack", {
        path, expectedSha256:pack.sha256, preferences:mergedPreferences(), acceptLicense:true,
      }));
      clearImport(); importDialog.close(); saveStatus.textContent = "模型已添加并启用";
    } catch (reason) {
      status.textContent = "导入失败，原有模型未改变。";
      importError.textContent = safeError(reason);
    } finally { importing = false; updateImport(); }
  };
  importPack.addEventListener("click", () => { void importResource(); });
  const inspect = async () => {
    if (!sourcePath) return;
    const ticket = ++generation;
    inspection = undefined; checking = true; importError.textContent = ""; importLicense.hidden = true;
    status.textContent = "正在检查模型和动作…"; updateImport();
    try {
      const result = await invoke<ModelInspection>("inspect_model", {path:sourcePath, animationSources, profilePath});
      if (ticket !== generation) return;
      inspection = result;
      if (!result.compatibilitySupported || result.backend !== "vrm") {
        status.textContent = "模型或资源不兼容。";
        importError.textContent = result.backend !== "vrm" ? "本版本暂不支持 Inochi2D，请使用 VRM。" : result.issues.map(({message}) => message).join("；");
        return;
      }
      let previous: AnimationMappings | undefined;
      try { previous = readMappings(importMappings); } catch { /* No complete mapping yet. */ }
      const suggested = suggestMappings(result);
      if (previous) {
        for (const key of ["idle","working","completed","error","blocked","approval"] as const) {
          const value = previous[key];
          if (value && result.animations.some(animation => animation.name === value)) suggested[key] = value;
        }
        for (const key of ["click","ambient"] as const) suggested[key] = previous[key].filter(name => result.animations.some(animation => animation.name === name));
      }
      renderMappings(importMappings, result.animations, suggested, "import-pool-help");
      importLicense.hidden = !result.license;
      status.textContent = result.animations.length ? "检查通过：" + result.animations.length + " 个动画。请选择待机动作。" : "请添加 VRMA 动作，并选择待机动作。";
    } catch (reason) {
      if (ticket !== generation) return;
      status.textContent = "模型检查失败。"; importError.textContent = safeError(reason);
    } finally { if (ticket === generation) { checking = false; updateImport(); } }
  };
  choose.addEventListener("click", async () => {
    try {
      const selected = await open({title:"选择 VRM 模型",multiple:false,directory:false,filters:[{name:"VRM",extensions:["vrm"]}]});
      if (typeof selected !== "string" || importing) return;
      if (!selected.toLowerCase().endsWith(".vrm")) throw new Error("本版本暂不支持 Inochi2D，请选择 .vrm 模型。");
      sourcePath = selected; animationSources = []; profilePath = undefined;
      importMappings.replaceChildren(); resources.hidden = false;
      requiredElement("animation-files").textContent = "尚未选择动作";
      requiredElement("profile-file").textContent = "标准 VRM";
      pathLabel.textContent = selected.split(/[\\/]/u).at(-1) ?? "已选择模型";
      await inspect();
    } catch (reason) { importError.textContent = safeError(reason); }
  });
  chooseAnimations.addEventListener("click", async () => {
    const ticket = generation;
    try {
      const selected = await open({title:"选择 VRMA 动作",multiple:true,directory:false,filters:[{name:"VRM Animation",extensions:["vrma"]}]});
      if (!selected || importing || ticket !== generation) return;
      animationSources = (Array.isArray(selected) ? selected : [selected]).map(path => ({path,name:path.split(/[\\/]/u).at(-1)!.replace(/\.vrma$/iu,"")}));
      requiredElement("animation-files").textContent = animationSources.length + " 个动作";
      await inspect();
    } catch (reason) { importError.textContent = safeError(reason); }
  });
  chooseProfile.addEventListener("click", async () => {
    const ticket = generation;
    try {
      const selected = await open({title:"选择角色配置",multiple:false,directory:false,filters:[{name:"角色配置",extensions:["json"]}]});
      if (typeof selected !== "string" || importing || ticket !== generation) return;
      profilePath = selected; requiredElement("profile-file").textContent = selected.split(/[\\/]/u).at(-1) ?? "角色配置";
      await inspect();
    } catch (reason) { importError.textContent = safeError(reason); }
  });
  clearProfile.addEventListener("click", () => { profilePath = undefined; requiredElement("profile-file").textContent = "标准 VRM"; void inspect(); });
  importButton.addEventListener("click", async () => {
    if (importing || checking || importButton.disabled || !sourcePath) return;
    importing = true; importError.textContent = ""; updateImport();
    try {
      const request: ModelInstallRequest = {backend:"vrm",sourcePath,animationSources,...(profilePath ? {profilePath} : {}),mappings:readMappings(importMappings),preferences:readPreferences()};
      await enqueueWrite("import", () => invoke<DesktopSettings>("install_model", {request:{...request,preferences:mergedPreferences()}}));
      clearImport(); importDialog.close(); saveStatus.textContent = "模型已添加并启用";
    } catch (reason) { importError.textContent = safeError(reason); }
    finally { importing = false; updateImport(); }
  });

  render(); updateImport();
  const unlisten = await listen<DesktopSettings>("settings-changed", ({payload}) => { settingsRevision++; adoptSettings(payload); });
  globalThis.addEventListener("pagehide", unlisten, {once:true});
  try {
    await enqueueWrite("prepare", () => invoke<DesktopSettings>("prepare_model"));
    if (!preferenceRevision && !failedWrites.size) saveStatus.textContent = settings.activeModelId === "weiguang-default" && !activeModel() ? "重启 DSH 后自动下载微光资源。" : "更改自动保存";
  } catch (reason) { saveStatus.textContent = "默认模型尚未就绪"; reportFailure(reason); }
}

function renderLibrary(host: HTMLElement, models: LibraryModel[], activeModelId: string | null, select: (id: string | null) => void, viewLicense: (id: string) => Promise<void>, add: () => void): void {
  host.replaceChildren();
  for (const model of models) {
    const card = document.createElement("article");
    card.className = "model-card"; card.dataset.active = String(model.id === activeModelId);
    const button = document.createElement("button");
    button.type = "button"; button.className = "model-choice"; button.dataset.modelId = model.id; button.setAttribute("aria-pressed", String(model.id === activeModelId)); button.disabled = model.backend !== "vrm";
    const title = document.createElement("strong"); title.textContent = model.title;
    const subtitle = document.createElement("span"); subtitle.textContent = model.backend === "vrm" ? "VRM · " + model.animations.length + " 个动作" : "Inochi2D · 本版本暂不支持";
    const selected = document.createElement("span"); selected.className = "model-selection"; selected.textContent = model.id === activeModelId ? "使用中" : "点击使用";
    button.append(title, subtitle, selected); button.addEventListener("click", () => select(model.id));
    const license = document.createElement("button");
    license.type = "button"; license.className = "model-license"; license.textContent = "查看许可"; license.setAttribute("aria-label", model.title + "的许可");
    license.addEventListener("click", () => { void viewLicense(model.id); });
    card.append(button, license); host.append(card);
  }
  if (!models.some(model => model.id === "weiguang-default")) {
    const preparing = document.createElement("article"); preparing.className = "model-card";
    const choose = document.createElement("button"); choose.type = "button"; choose.className = "model-choice";
    choose.dataset.modelId = "weiguang-default"; choose.setAttribute("aria-pressed", String(activeModelId === "weiguang-default"));
    const title = document.createElement("strong"); title.textContent = "微光";
    const hint = document.createElement("span"); hint.textContent = "待下载 · 点击使用";
    choose.append(title, hint); choose.addEventListener("click", () => select("weiguang-default"));
    const license = document.createElement("button"); license.type = "button"; license.className = "model-license"; license.textContent = "查看许可"; license.setAttribute("aria-label", "微光的许可");
    license.addEventListener("click", () => { void viewLicense("weiguang-default"); });
    preparing.append(choose, license); host.append(preparing);
  }
  const none = document.createElement("button");
  none.type = "button"; none.className = "model-card model-none"; none.dataset.modelId = "";
  none.setAttribute("aria-pressed", String(activeModelId === null)); none.dataset.active = String(activeModelId === null);
  none.textContent = "不显示模型"; none.addEventListener("click", () => select(null)); host.append(none);
  const addButton = document.createElement("button");
  addButton.type = "button"; addButton.className = "model-card model-add"; addButton.id = "add-model"; addButton.textContent = "＋ 添加模型"; addButton.addEventListener("click", add); host.append(addButton);
}

function renderMappings(host: HTMLElement, animations: ReadonlyArray<{ name: string }>, current: AnimationMappings | undefined, helpId: string): void {
  host.replaceChildren();
  for (const state of STATES) {
    const pool = state.key === "click" || state.key === "ambient";
    if (pool) {
      const fieldset = document.createElement("fieldset"); fieldset.className = "animation-pool"; fieldset.dataset.pool = state.key; fieldset.setAttribute("aria-describedby", helpId);
      const legend = document.createElement("legend"); legend.textContent = state.label + " · 随机播放"; fieldset.append(legend);
      const choices = document.createElement("div"); choices.className = "animation-choices";
      const selected = current?.[state.key];
      for (const animation of animations) {
        const label = document.createElement("label"); const input = document.createElement("input");
        input.type = "checkbox"; input.value = animation.name; input.checked = Array.isArray(selected) && selected.includes(animation.name);
        const text = document.createElement("span"); text.textContent = animation.name; label.append(input, text); choices.append(label);
      }
      if (!animations.length) { const empty = document.createElement("p"); empty.className = "empty-animations"; empty.textContent = "导入动作后，在这里勾选。"; choices.append(empty); }
      fieldset.append(choices); host.append(fieldset); continue;
    }
    const row = document.createElement("div"); row.className = "mapping-row";
    const label = document.createElement("label"); label.textContent = state.label;
    const select = document.createElement("select"); select.dataset.state = state.key; select.append(new Option(state.required ? "请选择待机动作" : "禁用", "")); select.required = state.required;
    for (const animation of animations) select.append(new Option(animation.name, animation.name));
    const selected = current?.[state.key]; for (const option of select.options) option.selected = option.value === selected;
    label.append(select); row.append(label); host.append(row);
  }
}

function suggestMappings(inspection: ModelInspection): AnimationMappings {
  const names = inspection.animations.map(({ name }) => name); const exact = (key: string) => names.find(name => name.toLowerCase() === key) ?? null;
  return {idle:"",working:exact("working"),completed:exact("completed"),error:exact("error"),blocked:exact("blocked"),approval:exact("approval"),click:exact("click") ? [exact("click")!] : [],ambient:[]};
}

function readMappings(host: HTMLElement): AnimationMappings {
  const values = Object.fromEntries([...host.querySelectorAll<HTMLSelectElement>("select[data-state]")].map(select => [select.dataset.state, select.value || null])) as unknown as AnimationMappings;
  for (const key of ["click", "ambient"] as const) values[key] = [...host.querySelectorAll<HTMLInputElement>('[data-pool="' + key + '"] input:checked')].map(input => input.value);
  if (!values.idle) throw new Error("待机动画必须选择且必须存在于模型中。");
  return values;
}

function populatePreferences(preferences: DesktopPreferences): void {
  requiredElement<HTMLSelectElement>("fps").value = String(preferences.fps);
  requiredElement<HTMLInputElement>("dpr").value = String(preferences.maxDevicePixelRatio);
  requiredElement<HTMLInputElement>("scale").value = String(preferences.scale);
  requiredElement<HTMLInputElement>("privacy").checked = preferences.privacyMode;
  requiredElement<HTMLSelectElement>("bubble-mode").value = preferences.bubbleMode;
}

function readPreferences(): DesktopPreferences {
  const {fps, maxDevicePixelRatio, scale, privacyMode, bubbleMode} = readUncheckedPreferences();
  if (fps !== 30 && fps !== 60) throw new Error("帧率只能是 30 或 60。");
  if (!Number.isFinite(maxDevicePixelRatio) || maxDevicePixelRatio < 1 || maxDevicePixelRatio > 1.5) throw new Error("DPR 上限必须在 1 到 1.5 之间。");
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 3) throw new Error("模型缩放必须在 0.25 到 3 之间。");
  return {fps,maxDevicePixelRatio,scale,privacyMode,bubbleMode};
}

function readUncheckedPreferences(): DesktopPreferences {
  return {
    fps:Number(requiredElement<HTMLSelectElement>("fps").value) as 30 | 60,
    maxDevicePixelRatio:Number(requiredElement<HTMLInputElement>("dpr").value),
    scale:Number(requiredElement<HTMLInputElement>("scale").value),
    privacyMode:requiredElement<HTMLInputElement>("privacy").checked,
    bubbleMode:requiredElement<HTMLSelectElement>("bubble-mode").value === "detailed" ? "detailed" : "compact",
  };
}

function safeError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "操作失败；原有模型和设置未改变。";
  // oxlint-disable-next-line no-control-regex -- native errors are rendered as local plain text.
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").trim().slice(0, 500);
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id); if (!(element instanceof HTMLElement)) throw new Error("missing " + id); return element as T;
}
