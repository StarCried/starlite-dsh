export type { PetSnapshot, PetState } from "@starcried/starlite-dsh-protocol";

export interface AnimationClip {
  name: string;
  timestepMs: number;
  length: number;
  leadIn: number;
  leadOut: number;
  weight: number;
  lanes: ReadonlyArray<{
    parameter: string;
    axis?: "x" | "y";
    defaultValues: readonly [number, number];
    interpolation: "nearest" | "stepped" | "linear" | "cubic";
    keyframes: ReadonlyArray<{ frame: number; value: number; tension: number }>;
  }>;
}

export type AnimationPlaybackResult = "completed" | "interrupted" | "stopped";
export interface ModelHitMask {
  width: number; height: number; left: number; top: number;
  displayWidth: number; displayHeight: number;
  viewportWidth: number; viewportHeight: number; bits: Uint8Array;
}

export interface WidgetController {
  readonly status: "disabled" | "loading" | "running" | "paused" | "fallback" | "destroyed";
  pause(): void;
  resume(): void;
  getAnimations(): ReadonlyArray<{ name: string; durationMs: number }>;
  playAnimation(
    name: string,
    options?: { mode?: "once" | "loop"; restart?: boolean },
  ): Promise<AnimationPlaybackResult>;
  stopAnimation(): void;
  resetCamera(): void;
  observeInteractionMask(listener?: (mask: ModelHitMask | undefined) => void): void;
  setPointerPosition(clientX: number, clientY: number): void;
  setHostPosition?(x: number, y: number): void;
  setPerformanceVisible?(visible: boolean): void;
  destroy(): void;
}

// Structural contract for externally staged modules. No renderer internals cross it.
export type ModelBackend = "inochi2d" | "vrm";
export interface ModelModule {
  mountModelWidget(host: HTMLElement, config: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<WidgetController>;
}
export interface ModelSlot {
  mount(factory: (signal: AbortSignal) => Promise<WidgetController>): Promise<WidgetController | undefined>;
  destroy(): void;
}
export interface ModelCore {
  ModelMountSlot: new () => ModelSlot;
  mountModelWidget(host: HTMLElement, config: Record<string, unknown>, modules: Record<ModelBackend, () => Promise<ModelModule>>, options?: {signal?: AbortSignal}): Promise<WidgetController>;
}
