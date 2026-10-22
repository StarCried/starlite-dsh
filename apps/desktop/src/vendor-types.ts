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

/** VRM-only calibration, matching the staged StarLite VRM controller contract. */
export interface ModelAdjustments {
  idle?: { armLiftDegrees?: number; palmTwistDegrees?: number; wristLiftDegrees?: number; handCurl?: number; elbowBendDegrees?: number };
  gaze?: { headStrength?: number; eyeStrength?: number; smoothingMs?: number };
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
  setDisplaySize?(width: number, height: number): void;
  setFrameRate?(fps: number | "display"): void;
  setPointerEnabled?(enabled: boolean): void;
  setBubblesVisible?(visible: boolean): void;
  setModelAdjustments?(adjustments: ModelAdjustments): void;
  refreshInteractionMask?(): void;
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
  QuickSettingsMenu: new (options: QuickMenuOptions) => QuickMenu;
  ModelMountSlot: new () => ModelSlot;
  mountModelWidget(host: HTMLElement, config: Record<string, unknown>, modules: Record<ModelBackend, () => Promise<ModelModule>>, options?: {signal?: AbortSignal}): Promise<WidgetController>;
}

export type QuickSettingItem = {id:string;label:string;disabled?:boolean;description?:string} & (
  | {kind:"toggle";value:boolean;onChange:(value:boolean)=>void|Promise<void>}
  | {kind:"range";value:number;min:number;max:number;step?:number;formatValue?:(value:number)=>string;onChange:(value:number)=>void|Promise<void>}
  | {kind:"select";value:string;options:readonly {value:string;label:string}[];onChange:(value:string)=>void|Promise<void>}
  | {kind:"action";onAction:()=>void|Promise<void>}
);
export interface QuickMenuOptions {title?:string;tabs:readonly {id:string;label:string;items:readonly QuickSettingItem[]}[]}
export interface QuickMenu {
  readonly element:HTMLElement;readonly isOpen:boolean;
  open(x:number,y:number):void;close():void;update(options:QuickMenuOptions):void;destroy():void;
}
