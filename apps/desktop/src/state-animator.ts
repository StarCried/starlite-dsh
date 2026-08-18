import type { PetSnapshot, PetState, WidgetController } from "./vendor-types.js";
import type { AnimationMappings } from "./types.js";

const LOOP_STATES = new Set<PetState>(["idle", "thinking", "working", "blocked", "approval"]);

/** Owns the single foreground animation channel and guards stale completions. */
export class StateAnimator {
  readonly #controller: WidgetController;
  #mappings: AnimationMappings;
  #state: PetState | undefined;
  #generation = 0;

  constructor(controller: WidgetController, mappings: AnimationMappings) {
    this.#controller = controller;
    this.#mappings = mappings;
  }

  setMappings(mappings: AnimationMappings): void {
    this.#mappings = mappings;
    this.#state = undefined;
  }

  apply(snapshot: PetSnapshot): void {
    if (snapshot.state === this.#state) return;
    this.#state = snapshot.state;
    const generation = ++this.#generation;
    const animation = this.#mappings[snapshot.state];
    if (!animation) {
      this.#controller.stopAnimation();
      return;
    }
    const mode = LOOP_STATES.has(snapshot.state) ? "loop" : "once";
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
  }

  async click(): Promise<void> {
    if (this.#state !== "idle" || !this.#mappings.click) return;
    const generation = ++this.#generation;
    const result = await this.#controller
      .playAnimation(this.#mappings.click, { mode: "once", restart: true })
      .catch(() => undefined);
    if (!result) return;
    if (generation !== this.#generation || this.#state !== "idle") return;
    // A loop promise intentionally stays pending until interruption. Start it
    // without awaiting so the Click handler itself can settle immediately.
    void this.#controller
      .playAnimation(this.#mappings.idle, { mode: "loop", restart: true })
      .catch(() => undefined);
  }

  disconnected(): void {
    this.#generation += 1;
    this.#state = undefined;
    this.#controller.stopAnimation();
  }
}
