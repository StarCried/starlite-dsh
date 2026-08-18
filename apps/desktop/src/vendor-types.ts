export type { PetSnapshot, PetState } from "@dsh-inochi2d-pet/protocol";

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
  destroy(): void;
}

export interface Inochi2DModule {
  mountInochi2DWidget(
    element: HTMLElement,
    config: {
      model: string;
      fallback: string;
      display: { width: number; height: number };
      render: { fps: number; maxDevicePixelRatio: number; initialScale: number; autoFit: boolean };
      mobile: { show: boolean };
      animations: readonly AnimationClip[];
      interactions: { pointer: boolean; click: false; drag: false };
    },
  ): Promise<WidgetController>;
}
