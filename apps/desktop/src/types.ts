import type { AnimationClip, PetState } from "./vendor-types.js";

export type AnimationState = PetState | "click";

export interface AnimationMappings {
  idle: string;
  thinking: string | null;
  working: string | null;
  completed: string | null;
  error: string | null;
  blocked: string | null;
  approval: string | null;
  click: string | null;
}

export interface InstalledModel {
  modelPath: string;
  sourceSha256: string;
  animations: AnimationClip[];
  mappings: AnimationMappings;
}

export interface DesktopPreferences {
  fps: 30 | 60;
  maxDevicePixelRatio: number;
  scale: number;
  privacyMode: boolean;
}

export interface DesktopSettings {
  schemaVersion: 1;
  preferences: DesktopPreferences;
  model?: InstalledModel;
}

export interface ModelInspection {
  sourceSha256: string;
  sourceBytes: number;
  modelName?: string;
  animations: AnimationClip[];
  compatibilitySupported: boolean;
  issues: Array<{ code: string; severity: "error" | "warning"; message: string }>;
}

export interface ModelInstallRequest {
  sourcePath: string;
  mappings: AnimationMappings;
  preferences: DesktopPreferences;
}
