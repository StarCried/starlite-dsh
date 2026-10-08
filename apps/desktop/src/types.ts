import type { AnimationClip, ModelBackend } from "./vendor-types.js";

export type AnimationState = keyof AnimationMappings;

export interface AnimationMappings {
  idle: string;
  working: string | null;
  completed: string | null;
  error: string | null;
  blocked: string | null;
  approval: string | null;
  click: string[];
  ambient: string[];
}

export interface AnimationSource { name: string; path: string }

export interface InstalledModel {
  backend: ModelBackend;
  inochi2d?: { animations: AnimationClip[] };
  vrm?: { animations: AnimationSource[]; profilePath?: string };
  modelPath: string;
  sourceSha256: string;
  animations: Array<{name: string; durationMs: number}>;
  mappings: AnimationMappings;
}

export interface DesktopPreferences {
  fps: 30 | 60;
  maxDevicePixelRatio: number;
  scale: number;
  privacyMode: boolean;
  bubbleMode: "compact" | "detailed";
}

export interface DesktopSettings {
  schemaVersion: 3;
  preferences: DesktopPreferences;
  model?: InstalledModel;
}

export interface ModelInspection {
  backend: ModelBackend;
  sourceSha256: string;
  sourceBytes: number;
  modelName?: string;
  animations: Array<{name: string; durationMs: number}>;
  compatibilitySupported: boolean;
  issues: Array<{ code: string; severity: "error" | "warning"; message: string }>;
}

export interface ModelInstallRequest {
  backend: ModelBackend;
  animationSources: AnimationSource[];
  profilePath?: string;
  sourcePath: string;
  mappings: AnimationMappings;
  preferences: DesktopPreferences;
}
