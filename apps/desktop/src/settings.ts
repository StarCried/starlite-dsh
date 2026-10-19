import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { showModelLicense } from "./model-license-dialog.js";
import { showModelImportHelp } from "./model-import-dialog.js";
import { showModelInspection } from "./model-inspection-dialog.js";
import type { AnimationMappings, AnimationState, DesktopPreferences, DesktopSettings, LibraryModel, ModelInspection, ModelInstallRequest, ModelRemoval } from "./types.js";

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
  fps:"fps", dpr:"maxDevicePixelRatio", scale:"scale", privacy:"privacyMode", "bubble-mode":"bubbleMode", "performance-overlay":"performanceOverlay",
} as const;

export async function startSettings(): Promise<void> {
  let settings = await invoke<DesktopSettings>("get_settings");
  let importing = false;
  const removing = new Set<string>();
  let writing = false;
  let preferenceRevision = 0;
  let settingsRevision = 0;
  const dirtyPreferences = new Map<keyof DesktopPreferences, number>();
  const failedWrites = new Map<string, string>();
  const pendingWrites: SettingsWrite[] = [];
  const library = requiredElement("model-library");
  const error = requiredElement("settings-error");
  const saveStatus = requiredElement("settings-status");
  const form = requiredElement<HTMLFormElement>("settings-form");
  const mappings = requiredElement("animation-mappings");

  populatePreferences(settings.preferences);
  const activeModel = () => settings.models.find(model => model.id === settings.activeModelId);
  const mergedPreferences = (): DesktopPreferences => {
    const visible = readPreferences();
    return {...settings.preferences, ...Object.fromEntries([...dirtyPreferences.keys()].map(key => [key, visible[key]]))};
  };
  let displayedMapping = "";
  let displayedLibrary = "";

  const render = () => {
    const model = activeModel();
    const signature = JSON.stringify([settings.activeModelId, settings.models.map(({ id, title, backend, animations }) => ({ id, title, backend, count: animations.length }))]);
    if (signature !== displayedLibrary) {
      displayedLibrary = signature;
      renderLibrary(library, settings.models, settings.activeModelId, selectModel, viewLicense, viewInfo, removeModel, openImport);
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
    const preparationResolved = next.activeModelId === null || activeModel() !== undefined;
    if (preparationResolved && failedWrites.delete("prepare") && !writing) {
      error.textContent = [...failedWrites.values()].at(-1) ?? "";
      saveStatus.textContent = failedWrites.size ? "部分更改未保存" : "已自动保存";
    }
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
      showModelLicense(license);
    } catch (reason) { reportFailure(reason); }
  }
  async function viewInfo(modelId: string): Promise<void> {
    const model = settings.models.find(item => item.id === modelId);
    if (!model) return;
    // Native inspection adds the approved program Idle itself; installed
    // copies must not be mistaken for a user-supplied reserved-name motion.
    const animationSources = model.vrm?.animations.filter(animation => animation.name !== "StarLiteIdle") ?? [];
    try { showModelInspection(await invoke<ModelInspection>("inspect_model", {path:model.modelPath, animationSources, profilePath:model.vrm?.profilePath})); }
    catch (reason) { reportFailure(reason); }
  }
  async function removeModel(modelId: string, title: string): Promise<void> {
    if (removing.has(modelId)) return;
    removing.add(modelId);
    try {
      if (!await confirmRemoval(title)) return;
      let warning: string | undefined;
      await enqueueWrite("remove:" + modelId, async () => {
        const result = await invoke<ModelRemoval>("remove_model", {modelId});
        warning = result.cleanupWarning;
        return result.settings;
      });
      saveStatus.textContent = warning ?? "模型已移除";
    } catch (reason) { reportFailure(reason); }
    finally { removing.delete(modelId); }
  }
  function openImport(): void { void importModel(); }

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
  const importModel = async () => {
    if (importing) return;
    importing = true;
    const add = requiredElement<HTMLButtonElement>("add-model");
    add.disabled = true;
    error.textContent = "";
    try {
      const path = await open({title:"添加 VRM 模型",multiple:false,directory:false,filters:[{name:"VRM",extensions:["vrm"]}]});
      if (typeof path !== "string") return;
      if (!path.toLowerCase().endsWith(".vrm")) throw new Error("请选择 .vrm 模型文件。本版本不支持 Inochi2D。");
      saveStatus.textContent = "正在检查模型…";
      const result = await invoke<ModelInspection>("inspect_model", {path});
      if (!result.compatibilitySupported || result.backend !== "vrm") throw new Error(result.issues.map(({message}) => message).join("；") || "模型不兼容。");
      const request: ModelInstallRequest = {backend:"vrm",sourcePath:path,animationSources:[],mappings:result.defaultMappings,preferences:mergedPreferences()};
      await enqueueWrite("import", () => invoke<DesktopSettings>("install_model", {request:{...request,preferences:mergedPreferences()}}));
      saveStatus.textContent = "模型已添加";
    } catch (reason) {
      reportFailure(reason);
      saveStatus.textContent = "添加失败，原有模型未改变";
    } finally {
      importing = false;
      requiredElement<HTMLButtonElement>("add-model").disabled = false;
    }
  };

  render();
  const unlisten = await listen<DesktopSettings>("settings-changed", ({payload}) => { settingsRevision++; adoptSettings(payload); });
  globalThis.addEventListener("pagehide", unlisten, {once:true});
  try {
    await enqueueWrite("prepare", () => invoke<DesktopSettings>("prepare_model"));
    if (!preferenceRevision && !failedWrites.size) saveStatus.textContent = settings.activeModelId === "weiguang-default" && !activeModel() ? "重启 DSH 后自动下载微光资源。" : "更改自动保存";
  } catch (reason) { saveStatus.textContent = "默认模型尚未就绪"; reportFailure(reason); }
}

function renderLibrary(host: HTMLElement, models: LibraryModel[], activeModelId: string | null, select: (id: string | null) => void, viewLicense: (id: string) => Promise<void>, viewInfo: (id: string) => Promise<void>, remove: (id: string, title: string) => Promise<void>, add: () => void): void {
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
    const actions = document.createElement("div"); actions.className = "model-card-actions";
    const info = document.createElement("button"); info.type = "button"; info.className = "model-license";
    info.textContent = "模型信息"; info.setAttribute("aria-label", model.title + "的模型信息");
    info.addEventListener("click", () => { void viewInfo(model.id); });
    actions.append(info, license, removalButton(model.id, model.title, remove));
    card.append(button, actions); host.append(card);
  }
  if (activeModelId === "weiguang-default" && !models.some(model => model.id === "weiguang-default")) {
    const preparing = document.createElement("article"); preparing.className = "model-card";
    const choose = document.createElement("button"); choose.type = "button"; choose.className = "model-choice";
    choose.dataset.modelId = "weiguang-default"; choose.setAttribute("aria-pressed", String(activeModelId === "weiguang-default"));
    const title = document.createElement("strong"); title.textContent = "微光";
    const hint = document.createElement("span"); hint.textContent = "待下载 · 点击使用";
    choose.append(title, hint); choose.addEventListener("click", () => select("weiguang-default"));
    const license = document.createElement("button"); license.type = "button"; license.className = "model-license"; license.textContent = "查看许可"; license.setAttribute("aria-label", "微光的许可");
    license.addEventListener("click", () => { void viewLicense("weiguang-default"); });
    const actions = document.createElement("div"); actions.className = "model-card-actions";
    actions.append(license, removalButton("weiguang-default", "微光", remove));
    preparing.append(choose, actions); host.append(preparing);
  }
  const none = document.createElement("button");
  none.type = "button"; none.className = "model-card model-none"; none.dataset.modelId = "";
  none.setAttribute("aria-pressed", String(activeModelId === null)); none.dataset.active = String(activeModelId === null);
  none.textContent = "不显示模型"; none.addEventListener("click", () => select(null)); host.append(none);
  const addCard = document.createElement("article"); addCard.className = "model-card model-add";
  const addButton = document.createElement("button");
  addButton.type = "button"; addButton.className = "model-choice"; addButton.id = "add-model"; addButton.setAttribute("aria-label", "添加 VRM 模型");
  const addTitle = document.createElement("strong"); addTitle.textContent = "＋ 添加 VRM 模型";
  addButton.append(addTitle); addButton.addEventListener("click", add);
  const help = document.createElement("button");
  help.type = "button"; help.className = "model-license"; help.id = "model-import-help"; help.textContent = "查看导入说明";
  help.setAttribute("aria-haspopup", "dialog"); help.addEventListener("click", showModelImportHelp);
  addCard.append(addButton, help); host.append(addCard);
}

function removalButton(id: string, title: string, remove: (id: string, title: string) => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.className = "model-license model-remove";
  button.textContent = "移除"; button.setAttribute("aria-label", "移除" + title);
  button.addEventListener("click", () => { void remove(id, title); });
  return button;
}

function confirmRemoval(title: string): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "model-license-dialog model-remove-dialog";
    dialog.setAttribute("aria-label", "移除模型");
    const heading = document.createElement("h2"); heading.textContent = "移除「" + title + "」？";
    const notice = document.createElement("p");
    notice.textContent = "移除模型及其动作映射，并清理本机导入副本；原始 VRM 文件保留。正在使用的模型会隐藏，重启后不会自动重新添加。";
    const actions = document.createElement("div"); actions.className = "license-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消"; cancel.autofocus = true;
    const confirm = document.createElement("button"); confirm.type = "button"; confirm.textContent = "移除";
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => dialog.close("remove"));
    actions.append(cancel, confirm); dialog.append(heading, notice, actions);
    dialog.addEventListener("close", () => {dialog.remove(); resolve(dialog.returnValue === "remove");}, {once:true});
    document.body.append(dialog); dialog.showModal();
  });
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
  requiredElement<HTMLInputElement>("performance-overlay").checked = preferences.performanceOverlay;
}

function readPreferences(): DesktopPreferences {
  const {fps, maxDevicePixelRatio, scale, privacyMode, bubbleMode, performanceOverlay} = readUncheckedPreferences();
  if (fps !== 30 && fps !== 60) throw new Error("帧率只能是 30 或 60。");
  if (!Number.isFinite(maxDevicePixelRatio) || maxDevicePixelRatio < 1 || maxDevicePixelRatio > 1.5) throw new Error("DPR 上限必须在 1 到 1.5 之间。");
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 3) throw new Error("模型缩放必须在 0.25 到 3 之间。");
  return {fps,maxDevicePixelRatio,scale,privacyMode,bubbleMode,performanceOverlay};
}

function readUncheckedPreferences(): DesktopPreferences {
  return {
    fps:Number(requiredElement<HTMLSelectElement>("fps").value) as 30 | 60,
    maxDevicePixelRatio:Number(requiredElement<HTMLInputElement>("dpr").value),
    scale:Number(requiredElement<HTMLInputElement>("scale").value),
    privacyMode:requiredElement<HTMLInputElement>("privacy").checked,
    bubbleMode:requiredElement<HTMLSelectElement>("bubble-mode").value === "detailed" ? "detailed" : "compact",
    performanceOverlay:requiredElement<HTMLInputElement>("performance-overlay").checked,
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
