import type {WidgetController} from "./vendor-types.js";

type LightingController = Pick<WidgetController, "setEnvironmentLighting">;
export interface EnvironmentColor {color: string}

/** Host-local sampling only; no screen data enters the DSH connection. */
export class EnvironmentLightingBridge {
  #controller: LightingController | undefined;
  #active = false;
  #strength = 1;
  #lastColor: string | undefined;
  #generation = 0;
  #pending = false;
  #destroyed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sample: () => Promise<EnvironmentColor | null>) {}

  configure(controller: LightingController | undefined, enabled: boolean, strength: number, active: boolean): void {
    if (this.#destroyed) return;
    const safeStrength = Number.isFinite(strength) ? Math.max(0, Math.min(2, strength)) : 1;
    const eligible = enabled && active && safeStrength > 0 && Boolean(controller?.setEnvironmentLighting);
    if (controller === this.#controller && eligible === this.#active && safeStrength === this.#strength) return;
    ++this.#generation;
    this.#clearTimer();
    if (this.#controller && (controller !== this.#controller || !eligible)) this.#controller.setEnvironmentLighting?.(null);
    if (controller !== this.#controller || !eligible) this.#lastColor = undefined;
    this.#controller = controller;
    this.#active = eligible;
    this.#strength = safeStrength;
    if (eligible && this.#lastColor) this.#controller?.setEnvironmentLighting?.({color:this.#lastColor,strength:safeStrength});
    if (eligible && !this.#pending) void this.#poll();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    ++this.#generation;
    this.#clearTimer();
    this.#controller?.setEnvironmentLighting?.(null);
    this.#controller = undefined;
    this.#lastColor = undefined;
    this.#active = false;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #poll(): Promise<void> {
    if (this.#destroyed || !this.#active || this.#pending) return;
    this.#pending = true;
    const generation = this.#generation;
    let sample: EnvironmentColor | null = null;
    try { sample = await this.sample(); } catch { /* A transient capture failure keeps the last valid lighting. */ }
    try {
      if (this.#destroyed || generation !== this.#generation || !this.#active) return;
      const color = typeof sample?.color === "string" && /^#[\da-f]{6}$/iu.test(sample.color) ? sample.color : undefined;
      if (color) {
        this.#lastColor = color;
        this.#controller?.setEnvironmentLighting?.({color,strength:this.#strength});
      }
    } finally {
      this.#pending = false;
      // Schedule from completion, never overlap or catch up after sleep. A
      // changed model/config gets a fresh sample without reusing the old one.
      if (!this.#destroyed && this.#active) this.#timer = setTimeout(() => {this.#timer = undefined; void this.#poll();}, generation === this.#generation ? 250 : 0);
    }
  }
}
