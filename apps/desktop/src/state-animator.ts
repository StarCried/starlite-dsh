import type { PetSnapshot, PetState, WidgetController } from "./vendor-types.js";
import type { AnimationMappings } from "./types.js";

type VisualState = Exclude<PetState, "thinking">;

/** Owns the single foreground animation channel and guards stale completions. */
export class StateAnimator {
  readonly #controller: WidgetController;
  #mappings: AnimationMappings;
  #state: VisualState | undefined;
  #generation = 0;
  #ambientTimer: ReturnType<typeof setTimeout> | undefined;
  #paused = false;
  #foreground: "state" | "gesture" | undefined;

  constructor(controller: WidgetController, mappings: AnimationMappings) {
    this.#controller = controller;
    this.#mappings = mappings;
  }

  setMappings(mappings: AnimationMappings): void {
    this.#clearAmbient();
    this.#generation += 1;
    this.#foreground = undefined;
    this.#mappings = mappings;
    this.#state = undefined;
    this.#controller.stopAnimation();
  }

  apply(snapshot: PetSnapshot): void {
    const state = snapshot.state === "thinking" ? "working" : snapshot.state;
    if (state === this.#state) return;
    this.#clearAmbient();
    this.#state = state;
    const animation = this.#mappings[state];
    if (!animation) {
      this.#generation += 1;
      this.#foreground = undefined;
      this.#controller.stopAnimation();
      return;
    }
    if (state === "idle") {
      // A short DSH operation can end before its visual gesture. Finish the
      // authored clip instead of cutting it off as soon as Idle arrives.
      if (!this.#foreground) this.#playIdle();
      return;
    }
    // A changed state is immediately relevant, especially approval, failure
    // and blocked notifications. Do not queue it behind an obsolete gesture.
    void this.#playOnce(animation, "state");
  }

  async click(): Promise<void> {
    if (this.#state !== "idle" || this.#foreground || this.#paused || !this.#mappings.click.length) return;
    await this.#gesture(this.#mappings.click);
  }

  async #gesture(pool: readonly string[]): Promise<void> {
    if (this.#state !== "idle" || this.#foreground || this.#paused) return;
    await this.#playOnce(pool[Math.floor(Math.random() * pool.length)]!, "gesture");
  }

  async #playOnce(animation: string, kind: "state" | "gesture"): Promise<void> {
    this.#clearAmbient();
    const generation = ++this.#generation;
    this.#foreground = kind;
    const result = await this.#controller
      .playAnimation(animation, { mode: "once", restart: true })
      .catch(() => undefined);
    if (generation !== this.#generation) return;
    this.#foreground = undefined;
    if (result !== "completed") return;
    this.#playIdle();
  }

  #playIdle(): void {
    this.#generation += 1;
    void this.#controller
      .playAnimation(this.#mappings.idle, { mode: "loop", restart: false })
      .catch(() => undefined);
    if (this.#state === "idle") this.#scheduleAmbient();
  }

  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#clearAmbient();
    if (!paused && this.#state === "idle" && !this.#foreground) this.#scheduleAmbient();
  }

  #scheduleAmbient(): void {
    if (this.#paused || this.#foreground || !this.#mappings.ambient.length || this.#ambientTimer) return;
    this.#ambientTimer = setTimeout(() => {
      this.#ambientTimer = undefined;
      if (this.#state === "idle" && !this.#paused) void this.#gesture(this.#mappings.ambient);
    }, 60_000 + Math.random() * 60_000);
  }

  #clearAmbient(): void {
    if (this.#ambientTimer) clearTimeout(this.#ambientTimer);
    this.#ambientTimer = undefined;
  }

  disconnected(): void {
    this.#clearAmbient();
    this.#generation += 1;
    this.#foreground = undefined;
    this.#state = undefined;
    this.#controller.stopAnimation();
  }
}
