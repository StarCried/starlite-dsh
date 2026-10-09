import type { ModelHitMask } from "./vendor-types.js";

export interface NativeHitMask extends Omit<ModelHitMask, "bits"> { bits: number[] }

/** Coalesce frames without allowing a late native update to restore an old model. */
export class InteractionMaskBridge {
  #mask: ModelHitMask | undefined;
  #pending: ModelHitMask | undefined;
  #hasPending = false;
  #sending = false;
  constructor(
    readonly send: (mask: NativeHitMask | null) => Promise<unknown>,
    readonly onFailure: () => void,
  ) {}
  update(mask: ModelHitMask | undefined): void {
    this.#mask = mask;
    this.#pending = mask;
    this.#hasPending = true;
    void this.#flush();
  }
  /** Native viewport resizing clears its coverage while preserving an active drag. */
  invalidateForViewport(): void {
    this.#mask = undefined;
    this.#pending = undefined;
    this.#hasPending = false;
  }
  hitTest(x: number, y: number): boolean {
    const mask = this.#mask;
    if (!mask || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const u = (x - mask.left) / mask.displayWidth;
    const v = (y - mask.top) / mask.displayHeight;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
    const pixel = Math.floor(v * mask.height) * mask.width + Math.floor(u * mask.width);
    return Boolean(mask.bits[pixel >> 3]! & (1 << (pixel & 7)));
  }
  async #flush(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#hasPending) {
        const mask = this.#pending;
        this.#hasPending = false;
        await this.send(mask ? {...mask,bits:Array.from(mask.bits)} : null);
      }
    } catch {
      this.#mask = undefined;
      this.#pending = undefined;
      this.#hasPending = false;
      this.onFailure();
    } finally { this.#sending = false; }
  }
}
