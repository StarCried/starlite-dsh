import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AnimationMappings,
  AnimationState,
  DesktopPreferences,
  DesktopSettings,
  ModelInspection,
  ModelInstallRequest,
} from "./types.js";

const STATES: ReadonlyArray<{ key: AnimationState; label: string; required: boolean }> = [
  { key: "idle", label: "Idle（必填）", required: true },
  { key: "thinking", label: "Thinking", required: false },
  { key: "working", label: "Working", required: false },
  { key: "completed", label: "Completed", required: false },
  { key: "error", label: "Error", required: false },
  { key: "blocked", label: "Blocked", required: false },
  { key: "approval", label: "Approval", required: false },
  { key: "click", label: "Click", required: false },
];

export async function startSettings(): Promise<void> {
  let settings = await invoke<DesktopSettings>("get_settings");
  let inspection: ModelInspection | undefined;
  let sourcePath: string | undefined;
  const choose = requiredElement<HTMLButtonElement>("choose-model");
  const pathLabel = requiredElement("model-path");
  const status = requiredElement("inspection-status");
  const error = requiredElement("settings-error");
  const form = requiredElement<HTMLFormElement>("settings-form");
  const mappings = requiredElement("animation-mappings");
  const save = requiredElement<HTMLButtonElement>("save-settings");
  populatePreferences(settings.preferences);
  renderMappings(mappings, settings.model?.animations ?? [], settings.model?.mappings);
  save.textContent = settings.model ? "保存设置" : "导入并保存";

  choose.addEventListener("click", async () => {
    error.textContent = "";
    const selected = await open({
      title: "选择 Inochi2D 模型",
      multiple: false,
      directory: false,
      filters: [{ name: "Inochi2D Puppet", extensions: ["inp"] }],
    });
    if (typeof selected !== "string") return;
    sourcePath = selected;
    pathLabel.textContent = selected.split(/[\\/]/u).at(-1) ?? "已选择模型";
    status.textContent = "正在检查模型…";
    save.disabled = true;
    try {
      inspection = await invoke<ModelInspection>("inspect_model", { path: selected });
      if (!inspection.compatibilitySupported) {
        status.textContent = "模型不符合当前 Web 兼容范围，不能导入。";
        error.textContent = inspection.issues.map(({ message }) => message).join("；");
        return;
      }
      status.textContent = `检查通过：${inspection.animations.length} 个动画。`;
      renderMappings(mappings, inspection.animations, suggestMappings(inspection));
      save.textContent = "导入并保存";
      save.disabled = false;
    } catch (reason) {
      inspection = undefined;
      status.textContent = "模型检查失败。";
      error.textContent = safeError(reason);
    } finally {
      if (!inspection?.compatibilitySupported) save.disabled = true;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    save.disabled = true;
    try {
      const request: ModelInstallRequest = {
        sourcePath: sourcePath ?? "",
        mappings: readMappings(mappings),
        preferences: readPreferences(),
      };
      settings = sourcePath
        ? await invoke<DesktopSettings>("install_model", { request })
        : await invoke<DesktopSettings>("update_settings", { request });
      sourcePath = undefined;
      inspection = undefined;
      pathLabel.textContent = settings.model ? "已安装模型" : "尚未选择";
      status.textContent = "设置已保存。";
      save.textContent = "保存设置";
    } catch (reason) {
      error.textContent = safeError(reason);
    } finally {
      save.disabled = false;
    }
  });
}

function renderMappings(
  host: HTMLElement,
  animations: ReadonlyArray<{ name: string }>,
  current?: AnimationMappings,
): void {
  host.replaceChildren();
  for (const state of STATES) {
    const row = document.createElement("div");
    row.className = "mapping-row";
    const label = document.createElement("label");
    label.textContent = state.label;
    const select = document.createElement("select");
    select.dataset.state = state.key;
    if (!state.required) select.append(new Option("禁用", ""));
    for (const animation of animations) select.append(new Option(animation.name, animation.name));
    const selected = current?.[state.key];
    if (selected && animations.some(({ name }) => name === selected)) select.value = selected;
    label.append(select);
    row.append(label);
    host.append(row);
  }
}

function suggestMappings(inspection: ModelInspection): AnimationMappings {
  const names = inspection.animations.map(({ name }) => name);
  const exact = (key: string) => names.find((name) => name.toLowerCase() === key) ?? null;
  const idle = exact("idle");
  return {
    idle: idle ?? "",
    thinking: exact("thinking"),
    working: exact("working"),
    completed: exact("completed"),
    error: exact("error"),
    blocked: exact("blocked"),
    approval: exact("approval"),
    click: exact("click"),
  };
}

function readMappings(host: HTMLElement): AnimationMappings {
  const values = Object.fromEntries(
    [...host.querySelectorAll<HTMLSelectElement>("select[data-state]")]
      .map((select) => [select.dataset.state, select.value || null]),
  ) as unknown as AnimationMappings;
  if (!values.idle) throw new Error("Idle 动画必须选择且必须存在于模型中。");
  return values;
}

function populatePreferences(preferences: DesktopPreferences): void {
  requiredElement<HTMLSelectElement>("fps").value = String(preferences.fps);
  requiredElement<HTMLInputElement>("dpr").value = String(preferences.maxDevicePixelRatio);
  requiredElement<HTMLInputElement>("scale").value = String(preferences.scale);
  requiredElement<HTMLInputElement>("privacy").checked = preferences.privacyMode;
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
