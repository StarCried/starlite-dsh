import type { DesktopSettings, LibraryModel } from "./types.js";

/** A null selection intentionally keeps the companion hidden. */
export function selectedModel(settings: DesktopSettings): LibraryModel | undefined {
  return settings.models.find(model => model.id === settings.activeModelId);
}

/** Metadata and action mapping edits do not recreate the WebGL renderer. */
export function renderingIdentity(settings: DesktopSettings): string {
  const model = selectedModel(settings);
  return JSON.stringify([
    model?.id, model?.backend, model?.modelPath, model?.vrm,
    settings.preferences.fps, settings.preferences.maxDevicePixelRatio, settings.preferences.scale,
  ]);
}
