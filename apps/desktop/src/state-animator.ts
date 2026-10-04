import type { PetSnapshot, PetState, WidgetController } from "./vendor-types.js";
import type { AnimationMappings } from "./types.js";

const LOOP_STATES = new Set<PetState>(["idle", "working", "blocked", "approval"]);

/** Owns the single foreground animation channel and guards stale completions. */
export class StateAnimator {
  readonly #controller: WidgetController;
  #mappings: AnimationMappings;
  #state: PetState | undefined;
  #generation = 0;
  #ambientTimer: ReturnType<typeof setTimeout> | undefined;
  #paused = false;

  constructor(controller: WidgetController, mappings: AnimationMappings) {
    this.#controller = controller;
    this.#mappings = mappings;
  }

  setMappings(mappings: AnimationMappings): void {
    this.#clearAmbient();
    this.#mappings = mappings;
    this.#state = undefined;
  }

  apply(snapshot: PetSnapshot): void {
    const state = snapshot.state === "thinking" ? "working" : snapshot.state;
    if (state === this.#state) return;
    this.#clearAmbient();
    this.#state = state;
    const generation = ++this.#generation;
    const animation = this.#mappings[state];
    if (!animation) {
      this.#controller.stopAnimation();
      return;
    }
    const mode = LOOP_STATES.has(state) ? "loop" : "once";
    void this.#controller.playAnimation(animation, { mode, restart: true })
      .then(() => {
        if (generation !== this.#generation) return;
        // Completed/Error remain neutral for the rest of their latch. The next
        // snapshot, rather than an implicit fallback, owns the next animation.
      })
      .catch(() => {
        // Rendering failures are contained in the desktop layer; state updates
        // and DSH remain unaffected.
      });
    if (state === "idle") this.#scheduleAmbient();
  }

  async click(): Promise<void> {
    if (this.#state !== "idle" || this.#paused || !this.#mappings.click.length) return;
    await this.#gesture(this.#mappings.click);
  }

  async #gesture(pool: readonly string[]): Promise<void> {
    this.#clearAmbient();
    const generation = ++this.#generation;
    const result = await this.#controller
      .playAnimation(pool[Math.floor(Math.random() * pool.length)]!, { mode: "once", restart: true })
      .catch(() => undefined);
    if (!result || result === "stopped") return;
    if (generation !== this.#generation || this.#state !== "idle") return;
    // A loop promise intentionally stays pending until interruption. Start it
    // without awaiting so the Click handler itself can settle immediately.
    void this.#controller
      .playAnimation(this.#mappings.idle, { mode: "loop", restart: true })
      .catch(() => undefined);
    this.#scheduleAmbient();
  }

  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#clearAmbient();
    if (!paused && this.#state === "idle") this.#scheduleAmbient();
  }

  #scheduleAmbient(): void {
    if (this.#paused || !this.#mappings.ambient.length || this.#ambientTimer) return;
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
    this.#state = undefined;
    this.#controller.stopAnimation();
  }
}
