import { convertFileSrc } from "@tauri-apps/api/core";
import type { DesktopSettings } from "./types.js";
import type { Inochi2DModule, WidgetController } from "./vendor-types.js";

const RUNTIME_URL = "/runtime/inochi2d-web/index.js";
const RUNTIME_STYLE_URL = "/runtime/inochi2d-web/widget.css";
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export async function mountModel(
  host: HTMLElement,
  settings: DesktopSettings,
): Promise<WidgetController | undefined> {
  const model = settings.model;
  if (!model) return undefined;
  ensureRuntimeStylesheet();
  const runtime = await import(/* @vite-ignore */ RUNTIME_URL) as Inochi2DModule;
  if (typeof runtime.mountInochi2DWidget !== "function") {
    throw new Error("inochi2d-web runtime is incompatible");
  }
  host.replaceChildren();
  return runtime.mountInochi2DWidget(host, {
    model: convertFileSrc(model.modelPath),
    fallback: TRANSPARENT_PIXEL,
    display: { width: 480, height: 720 },
    render: {
      fps: settings.preferences.fps,
      maxDevicePixelRatio: settings.preferences.maxDevicePixelRatio,
      initialScale: settings.preferences.scale,
      autoFit: true,
    },
    mobile: { show: true },
    animations: model.animations,
    interactions: { pointer: true, click: false, drag: false },
  });
}

function ensureRuntimeStylesheet(): void {
  if (document.querySelector(`link[href="${RUNTIME_STYLE_URL}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = RUNTIME_STYLE_URL;
  document.head.append(link);
}
