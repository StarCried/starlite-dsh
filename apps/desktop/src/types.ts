import type { AnimationClip, ModelBackend, ModelAdjustments } from "./vendor-types.js";
export type { ModelAdjustments } from "./vendor-types.js";

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
  license?: { title: string; text: string };
  backend: ModelBackend;
  inochi2d?: { animations: AnimationClip[] };
  vrm?: { animations: AnimationSource[]; embeddedAnimations?: string[]; profilePath?: string };
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
  performanceOverlay: boolean;
  bubblesVisible?: boolean;
  pointerEnabled?: boolean;
}

export interface DesktopSettings {
  schemaVersion: 4;
  preferences: DesktopPreferences;
  models: LibraryModel[];
  activeModelId: string | null;
}

export interface LibraryModel extends InstalledModel {
  id: string;
  title: string;
  adjustments?: ModelAdjustments;
}

export interface ModelRemoval {
  settings: DesktopSettings;
  cleanupWarning?: string;
}

export interface ModelInspection {
  backend: ModelBackend;
  sourceSha256: string;
  sourceBytes: number;
  modelName?: string;
  license?: { title: string; text: string };
  animations: Array<{name: string; durationMs: number}>;
  defaultMappings: AnimationMappings;
  compatibilitySupported: boolean;
  issues: Array<{ code: string; severity: "error" | "warning"; message: string }>;
  capabilities?: {
    humanoid: {requiredBones: string[]; optionalBones: string[]};
    blink: {automatic: boolean; combined: boolean; left: boolean; right: boolean};
    lookAt: {mode: "bone" | "expression" | "none"; head: boolean; eyes: boolean; horizontal: boolean; vertical: boolean};
  };
  metrics?: {fileBytes: number; nodeCount: number; meshCount: number; primitiveCount: number; materialCount: number; textureCount: number; imageCount: number; vertexCount: number; triangleCount: number; morphTargetCount: number; decodedAccessorBytes: number};
}

export interface ModelInstallRequest {
  backend: ModelBackend;
  animationSources: AnimationSource[];
  profilePath?: string;
  sourcePath: string;
  mappings: AnimationMappings;
  preferences: DesktopPreferences;
}
