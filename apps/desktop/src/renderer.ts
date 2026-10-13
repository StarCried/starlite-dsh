import { convertFileSrc } from "@tauri-apps/api/core";
import type { DesktopSettings } from "./types.js";
import type { ModelCore, ModelModule, ModelSlot, WidgetController } from "./vendor-types.js";
import { VRM_VIEWPORT_PADDING } from "./model-viewport.js";
import { selectedModel } from "./model-selection.js";
const CORE_URL = "/runtime/core/index.js";
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const loadCore = () => import(/* @vite-ignore */ CORE_URL) as Promise<ModelCore>;
export async function createModelSlot(): Promise<ModelSlot> {
  const { ModelMountSlot } = await loadCore();
  return new ModelMountSlot();
}
export function modelConfig(settings: DesktopSettings): Record<string, unknown> {
  const model = selectedModel(settings);
  if (settings.activeModelId === null) throw new Error("Model is disabled");
  if (!model) throw new Error("No installed model");
  if (model.backend !== "vrm") throw new Error("Inochi2D is disabled in this version");
  if (!model.vrm) throw new Error("Model component is incomplete");
  return {
    backend: model.backend, model: convertFileSrc(model.modelPath), fallback: TRANSPARENT_PIXEL,
    display: { width: 320, height: 480 },
    render: { fps: settings.preferences.fps, maxDevicePixelRatio: settings.preferences.maxDevicePixelRatio, initialScale: settings.preferences.scale, autoFit: true, fitPadding:.92,viewportPadding:VRM_VIEWPORT_PADDING },
    mobile: { show: true }, interactions: { pointer: true, click: false, drag: false },
    animations: model.vrm.animations.map(({name,path}) => ({name,url:convertFileSrc(path)})),
    ...(model.vrm.profilePath ? {profile:convertFileSrc(model.vrm.profilePath)} : {}),
    ambient: {animations:[model.mappings.idle]},
    camera: {yawDegrees:0,pitchDegrees:5,fovDegrees:20,targetHeight:.54},
    gaze: {maxYawDegrees:25,maxPitchDegrees:15,smoothingMs:100},
  };
}
export async function mountModel(host: HTMLElement, settings: DesktopSettings, signal: AbortSignal): Promise<WidgetController> {
  const config = modelConfig(settings);
  const core = await loadCore();
  signal.throwIfAborted();
  const load = async (name: string): Promise<ModelModule> => {
    const url = `/runtime/${name}/index.js`;
    const runtime = await import(/* @vite-ignore */ url) as ModelModule;
    signal.throwIfAborted();
    if (typeof runtime.mountModelWidget !== "function") throw new Error("Model runtime is incompatible");
    const href = `/runtime/${name}/widget.css`;
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; document.head.append(link);
    }
    return runtime;
  };
  // Isolate each asynchronous mount so a late renderer never changes a new host.
  const surface = document.createElement("div"); surface.className = "model-surface"; host.replaceChildren(surface);
  const cleanup = () => surface.remove();
  signal.addEventListener("abort", cleanup, {once:true});
  try {
    const controller = await core.mountModelWidget(surface, config, {
      inochi2d: async () => { throw new Error("Inochi2D is disabled in this version"); },
      vrm: () => load("vrm"),
    }, {signal});
    if (controller.status === "fallback" || controller.status === "disabled") {controller.destroy(); throw new Error("Model failed to load");}
    return controller;
  } catch (error) { cleanup(); throw error; }
}
