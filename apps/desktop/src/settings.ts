import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmResourceLicense, type ResourcePackInspection } from "./resource-pack-dialog.js";
import type {
  AnimationSource,
  AnimationMappings,
  AnimationState,
  DesktopPreferences,
  DesktopSettings,
  ModelInspection,
  ModelInstallRequest,
} from "./types.js";

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

export async function startSettings(): Promise<void> {
  let settings = await invoke<DesktopSettings>("get_settings");
  let inspection: ModelInspection | undefined;
  let sourcePath: string | undefined;
  let animationSources: AnimationSource[] = [];
  let profilePath: string | undefined;
  let generation = 0;
  let checking = false;
  let saving = false;
  let importing = false;
  let preferencesEdited = false;
  const choose = requiredElement<HTMLButtonElement>("choose-model");
  const importPack = requiredElement<HTMLButtonElement>("import-resource-pack");
  const chooseAnimations = requiredElement<HTMLButtonElement>("choose-animations");
  const chooseProfile = requiredElement<HTMLButtonElement>("choose-profile");
  const clearProfile = requiredElement<HTMLButtonElement>("clear-profile");
  const resources = requiredElement("vrm-resources");
  const pathLabel = requiredElement("model-path");
  const status = requiredElement("inspection-status");
  const error = requiredElement("settings-error");
  const form = requiredElement<HTMLFormElement>("settings-form");
  const mappings = requiredElement("animation-mappings");
  const save = requiredElement<HTMLButtonElement>("save-settings");
  populatePreferences(settings.preferences);
  renderMappings(mappings, settings.model?.animations ?? [], settings.model?.mappings);
  pathLabel.textContent = settings.model ? "已安装模型" : "尚未选择";
  save.textContent = settings.model ? "保存设置" : "导入并保存";
  const updateSave = () => {
    const valid = sourcePath ? inspection?.compatibilitySupported : Boolean(settings.model);
    const idle = mappings.querySelector<HTMLSelectElement>('select[data-state="idle"]')?.value;
    save.disabled = saving || importing || checking || !valid || !idle;
    importPack.disabled = saving || importing || checking;
  };
  form.addEventListener("change", event => {
    if ((event.target as HTMLElement).closest(".preferences")) preferencesEdited = true;
    updateSave();
  });
  updateSave();
  importPack.addEventListener("click", async () => {
    if (importing || saving || checking) return;
    importing = true;
    error.textContent = "";
    updateSave();
    for (const button of [choose, chooseAnimations, chooseProfile, clearProfile]) button.disabled = true;
    try {
      const path = await open({title:"选择独立授权的资源包",multiple:false,directory:false,filters:[{name:"StarLite 资源包",extensions:["zip"]}]});
      if (typeof path !== "string") return;
      status.textContent = "正在检查资源包…";
      const pack = await invoke<ResourcePackInspection>("inspect_resource_pack", {path});
      if (!await confirmResourceLicense(pack)) {
        status.textContent = "已取消导入。";
        return;
      }
      status.textContent = "正在自动导入…";
      const preferences = readPreferences();
      if (!settings.model && !preferencesEdited) {
        preferences.fps = 30;
        preferences.maxDevicePixelRatio = 1.5;
      }
      settings = await invoke<DesktopSettings>("install_resource_pack", {
        path, expectedSha256:pack.sha256, preferences, acceptLicense:true,
      });
      sourcePath = undefined; inspection = undefined; animationSources = []; profilePath = undefined;
      resources.hidden = true;
      populatePreferences(settings.preferences);
      renderMappings(mappings, settings.model?.animations ?? [], settings.model?.mappings);
      requiredElement<HTMLDetailsElement>("mapping-details").open = false;
      pathLabel.textContent = pack.title;
      status.textContent = "资源包已自动导入并保存，可以开始使用。";
      save.textContent = "保存设置";
    } catch (reason) {
      status.textContent = "资源包导入失败，原模型和设置未改变。";
      error.textContent = safeError(reason);
    } finally {
      importing = false;
      for (const button of [choose, chooseAnimations, chooseProfile, clearProfile]) button.disabled = false;
      updateSave();
    }
  });
  const inspect = async () => {
    if (!sourcePath) return;
    const ticket = ++generation;
    inspection = undefined; checking = true; error.textContent = "";
    status.textContent = "正在检查模型和动作…"; updateSave();
    try {
      const result = await invoke<ModelInspection>("inspect_model", {path:sourcePath, animationSources, profilePath});
      if (ticket !== generation) return;
      inspection = result;
      if (!result.compatibilitySupported) {
        status.textContent = "模型或资源不兼容，不能导入。";
        error.textContent = result.issues.map(({message}) => message).join("；");
        return;
      }
      status.textContent = result.animations.length ? `检查通过：${result.animations.length} 个动画。请选择待机动作。` : "模型可预览；请添加动作并选择待机后保存。";
      renderMappings(mappings, result.animations, suggestMappings(result));
      requiredElement<HTMLDetailsElement>("mapping-details").open = true;
      save.textContent = "导入并保存";
    } catch (reason) {
      if (ticket !== generation) return;
      status.textContent = "模型检查失败。"; error.textContent = safeError(reason);
    } finally { if (ticket === generation) { checking = false; updateSave(); } }
  };
  choose.addEventListener("click", async () => {
    try {
      const selected = await open({ title: "选择模型", multiple:false, directory:false, filters:[{name:"模型",extensions:["inp","vrm"]}] });
      if (typeof selected !== "string" || saving || importing) return;
      sourcePath = selected; animationSources = []; profilePath = undefined;
      resources.hidden = !selected.toLowerCase().endsWith(".vrm");
      requiredElement("animation-files").textContent = "尚未选择动作";
      requiredElement("profile-file").textContent = "标准 VRM";
      pathLabel.textContent = selected.split(/[\\/]/u).at(-1) ?? "已选择模型";
      if (!resources.hidden && !settings.model && !preferencesEdited) populatePreferences({...settings.preferences,fps:30,maxDevicePixelRatio:1.5});
      await inspect();
    } catch (reason) { error.textContent = safeError(reason); }
  });
  chooseAnimations.addEventListener("click", async () => {
    const ticket = generation;
    try {
      const selected = await open({title:"选择 VRMA 动作",multiple:true,directory:false,filters:[{name:"VRM Animation",extensions:["vrma"]}]});
      if (!selected || saving || importing || ticket !== generation) return;
      animationSources = (Array.isArray(selected) ? selected : [selected]).map(path => ({path,name:path.split(/[\\/]/u).at(-1)!.replace(/\.vrma$/iu,"")}));
      requiredElement("animation-files").textContent = `${animationSources.length} 个动作`;
      await inspect();
    } catch (reason) { error.textContent = safeError(reason); }
  });
  chooseProfile.addEventListener("click", async () => {
    const ticket = generation;
    try {
      const selected = await open({title:"选择角色配置",multiple:false,directory:false,filters:[{name:"角色配置",extensions:["json"]}]});
      if (typeof selected !== "string" || saving || importing || ticket !== generation) return;
      profilePath = selected;
      requiredElement("profile-file").textContent = selected.split(/[\\/]/u).at(-1) ?? "角色配置";
      await inspect();
    } catch (reason) { error.textContent = safeError(reason); }
  });
  clearProfile.addEventListener("click", () => { profilePath = undefined; requiredElement("profile-file").textContent = "标准 VRM"; void inspect(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || importing || checking || save.disabled) return;
    saving = true; error.textContent = ""; updateSave();
    for (const button of [choose,chooseAnimations,chooseProfile,clearProfile]) button.disabled = true;
    try {
      const request: ModelInstallRequest = {
        backend: inspection?.backend ?? settings.model?.backend ?? "inochi2d",
        sourcePath: sourcePath ?? "", animationSources, ...(profilePath ? {profilePath} : {}),
        mappings: readMappings(mappings), preferences: readPreferences(),
      };
      settings = await invoke<DesktopSettings>(sourcePath ? "install_model" : "update_settings", {request});
      sourcePath = undefined; inspection = undefined; animationSources = []; profilePath = undefined; resources.hidden = true;
      pathLabel.textContent = "已安装模型"; status.textContent = "设置已保存。"; save.textContent = "保存设置";
    } catch (reason) { error.textContent = safeError(reason); }
    finally { saving = false; for (const button of [choose,chooseAnimations,chooseProfile,clearProfile]) button.disabled = false; updateSave(); }
  });
}

function renderMappings(
  host: HTMLElement,
  animations: ReadonlyArray<{ name: string }>,
  current?: AnimationMappings,
): void {
  host.replaceChildren();
  for (const state of STATES) {
    const pool = state.key === "click" || state.key === "ambient";
    if (pool) {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "animation-pool";
      fieldset.dataset.pool = state.key;
      fieldset.setAttribute("aria-describedby", "animation-pool-help");
      const legend = document.createElement("legend");
      legend.textContent = `${state.label} · 随机播放`;
      fieldset.append(legend);
      const choices = document.createElement("div");
      choices.className = "animation-choices";
      const selected = current?.[state.key];
      for (const animation of animations) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = animation.name;
        input.checked = Array.isArray(selected) && selected.includes(animation.name);
        const text = document.createElement("span");
        text.textContent = animation.name;
        label.append(input, text);
        choices.append(label);
      }
      if (!animations.length) {
        const empty = document.createElement("p");
        empty.className = "empty-animations";
        empty.textContent = "导入模型与动作后，在这里勾选。";
        choices.append(empty);
      }
      fieldset.append(choices);
      host.append(fieldset);
      continue;
    }
    const row = document.createElement("div");
    row.className = "mapping-row";
    const label = document.createElement("label");
    label.textContent = state.label;
    const select = document.createElement("select");
    select.dataset.state = state.key;
    select.append(new Option(state.required ? "请选择待机动作" : "禁用", ""));
    select.required = state.required;
    for (const animation of animations) select.append(new Option(animation.name, animation.name));
    const selected = current?.[state.key];
    for (const option of select.options) option.selected = Array.isArray(selected) ? selected.includes(option.value) : option.value === selected;
    label.append(select);
    row.append(label);
    host.append(row);
  }
}

function suggestMappings(inspection: ModelInspection): AnimationMappings {
  const names = inspection.animations.map(({ name }) => name);
  const exact = (key: string) => names.find((name) => name.toLowerCase() === key) ?? null;
  return {
    idle: "",
    working: exact("working"),
    completed: exact("completed"),
    error: exact("error"),
    blocked: exact("blocked"),
    approval: exact("approval"),
    click: exact("click") ? [exact("click")!] : [],
    ambient: [],
  };
}

function readMappings(host: HTMLElement): AnimationMappings {
  const values = Object.fromEntries(
    [...host.querySelectorAll<HTMLSelectElement>("select[data-state]")]
      .map((select) => [select.dataset.state, select.value || null]),
  ) as unknown as AnimationMappings;
  for (const key of ["click", "ambient"] as const) {
    values[key] = [...host.querySelectorAll<HTMLInputElement>(`[data-pool="${key}"] input:checked`)].map(input => input.value);
  }
  if (!values.idle) throw new Error("待机动画必须选择且必须存在于模型中。");
  return values;
}

function populatePreferences(preferences: DesktopPreferences): void {
  requiredElement<HTMLSelectElement>("fps").value = String(preferences.fps);
  requiredElement<HTMLInputElement>("dpr").value = String(preferences.maxDevicePixelRatio);
  requiredElement<HTMLInputElement>("scale").value = String(preferences.scale);
  requiredElement<HTMLInputElement>("privacy").checked = preferences.privacyMode;
  requiredElement<HTMLSelectElement>("bubble-mode").value = preferences.bubbleMode ?? "compact";
}

function readPreferences(): DesktopPreferences {
  const fps = Number(requiredElement<HTMLSelectElement>("fps").value);
  const maxDevicePixelRatio = Number(requiredElement<HTMLInputElement>("dpr").value);
  const scale = Number(requiredElement<HTMLInputElement>("scale").value);
  if (fps !== 30 && fps !== 60) throw new Error("帧率只能是 30 或 60。");
  if (!Number.isFinite(maxDevicePixelRatio) || maxDevicePixelRatio < 1 || maxDevicePixelRatio > 1.5) {
    throw new Error("DPR 上限必须在 1 到 1.5 之间。");
  }
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 3) {
    throw new Error("模型缩放必须在 0.25 到 3 之间。");
  }
  return {
    fps,
    maxDevicePixelRatio,
    scale,
    privacyMode: requiredElement<HTMLInputElement>("privacy").checked,
    bubbleMode: requiredElement<HTMLSelectElement>("bubble-mode").value === "detailed" ? "detailed" : "compact",
  };
}

function safeError(reason: unknown): string {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "操作失败；旧模型和设置未改变。";
  // oxlint-disable-next-line no-control-regex -- native errors are rendered as local plain text.
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").trim().slice(0, 500);
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${id}`);
  return element as T;
}
