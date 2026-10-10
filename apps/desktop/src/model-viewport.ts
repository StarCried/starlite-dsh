export interface ModelViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
}

const BASE: ModelViewport = {left:0,top:0,width:320,height:480,baseWidth:320,baseHeight:480};
const BUBBLE_MARGIN = 12;
// Includes the speech tail, so even the top of an expanded gesture stays clear.
const BUBBLE_GAP = 24;
const MIN_INPUT_HEIGHT = 128;

function validViewport(value: unknown): value is ModelViewport {
  if (!value || typeof value !== "object") return false;
  const v = value as ModelViewport;
  return [v.left,v.top,v.width,v.height,v.baseWidth,v.baseHeight].every(Number.isFinite)
    && v.baseWidth === 320 && v.baseHeight === 480 && v.left <= 0 && v.top <= 0
    && v.width <= 4096 && v.height <= 4096
    && v.width + v.left >= v.baseWidth && v.height + v.top >= v.baseHeight;
}

/** Reserve space above the drawing surface without moving or scaling the model. */
export class ModelViewportBridge {
  #vrm = false;
  #renderViewport = BASE;
  #viewport = BASE;
  #bubbleHeight = 0;
  #screenSpace: number | undefined;
  readonly #bubbleResize: ResizeObserver;
  readonly #bubbleVisibility: MutationObserver;
  #pending = 0;
  #tail: Promise<void> = Promise.resolve();
  #listener = (event: Event) => {
    if (!this.#vrm || !(event.target instanceof Node) || !this.host.contains(event.target)) return;
    const value: unknown = (event as CustomEvent<unknown>).detail;
    if (!validViewport(value)) { this.failed(); return; }
    if (Object.keys(BASE).every(key => value[key as keyof ModelViewport] === this.#renderViewport[key as keyof ModelViewport])) return;
    this.#apply(value);
  };

  constructor(
    readonly host: HTMLElement,
    readonly anchor: HTMLElement,
    readonly send: (viewport: ModelViewport | null) => Promise<unknown>,
    readonly invalidate: () => void,
    readonly applied: () => void,
    readonly failed: () => void,
    readonly bubble: HTMLElement,
  ) {
    // Register before the renderer mounts: its initial canvas can already be expanded.
    host.addEventListener("model-viewport-change", this.#listener);
    this.#bubbleResize = new ResizeObserver(() => this.#updateBubble());
    this.#bubbleResize.observe(bubble);
    this.#bubbleVisibility = new MutationObserver(() => this.#updateBubble());
    this.#bubbleVisibility.observe(bubble, {attributes:true,attributeFilter:["hidden","data-interactive"]});
  }

  get pending(): boolean { return this.#pending > 0; }

  configure(vrm: boolean): Promise<void> {
    const previous = this.#vrm;
    this.#vrm = vrm;
    if (vrm || previous) this.#apply(vrm ? BASE : null);
    return this.#tail;
  }

  hostPosition(position: {x:number;y:number}, scale: number): {x:number;y:number} {
    const dpi = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return {
      x:(position.x - Math.round(this.#viewport.left * dpi)) / dpi,
      y:(position.y - Math.round(this.#viewport.top * dpi)) / dpi,
    };
  }

  /** CSS px from the logical model anchor to the current monitor's work-area
   * top. Return the minimum downward anchor correction if even a short bubble
   * cannot fit. Long input forms scroll before requiring any model movement. */
  setScreenSpace(aboveModel: number): number {
    if (!Number.isFinite(aboveModel)) return 0;
    this.#screenSpace = aboveModel;
    if (!this.#vrm) return 0;
    if (this.anchor.style.getPropertyValue("--bubble-max-height") !== `${this.#maxBubbleHeight(this.#renderViewport)}px`) this.#apply(this.#renderViewport);
    if (!this.#bubbleHeight || this.bubble.hidden) return 0;
    return Math.max(0,this.#bubbleHeight+BUBBLE_MARGIN+BUBBLE_GAP-this.#renderViewport.top-aboveModel);
  }

  ready(): Promise<void> { return this.#tail; }

  destroy(): Promise<void> {
    this.host.removeEventListener("model-viewport-change", this.#listener);
    this.#bubbleResize.disconnect();
    this.#bubbleVisibility.disconnect();
    return this.configure(false);
  }

  #measureBubble(): number {
    if (!this.#vrm || this.bubble.hidden) return 0;
    const height = this.bubble.getBoundingClientRect().height;
    return Number.isFinite(height) && height > 0 ? Math.ceil(height) : 0;
  }

  #updateBubble(): void {
    if (this.#vrm && (this.#measureBubble() !== this.#bubbleHeight
      || this.anchor.style.getPropertyValue("--bubble-max-height") !== `${this.#maxBubbleHeight(this.#renderViewport)}px`)) this.#apply(this.#renderViewport);
  }

  #maxBubbleHeight(value: ModelViewport): number {
    const limit = value.baseHeight-48;
    if (this.#screenSpace === undefined || this.bubble.dataset.interactive !== "true") return limit;
    return Math.max(MIN_INPUT_HEIGHT,Math.min(limit,Math.floor(this.#screenSpace+value.top-BUBBLE_MARGIN-BUBBLE_GAP)));
  }

  #apply(value: ModelViewport | null): void {
    // Apply the screen budget before measuring, so the native window reserves
    // the scrollable form's visible height rather than its full content height.
    if (value) this.anchor.style.setProperty("--bubble-max-height",`${this.#maxBubbleHeight(value)}px`);
    const bubbleHeight = this.#measureBubble();
    const reserve = value && bubbleHeight ? bubbleHeight + BUBBLE_MARGIN + BUBBLE_GAP : 0;
    const native = value ? {...value,top:value.top-reserve,height:value.height+reserve} : null;
    if (native && !validViewport(native)) {this.failed();return;}
    this.#renderViewport = value ?? BASE;
    this.#viewport = native ?? BASE;
    this.#bubbleHeight = bubbleHeight;
    this.anchor.classList.toggle("vrm-viewport", value !== null);
    const variables: Record<string,string> = native ? {
      "--model-left":`${-native.left}px`, "--model-top":`${-native.top}px`,
      "--model-width":`${native.baseWidth}px`, "--model-height":`${native.baseHeight}px`,
      "--bubble-left":`${-native.left + native.baseWidth / 2}px`,
      "--bubble-top":`${BUBBLE_MARGIN}px`, "--bubble-width":`${Math.min(420,native.baseWidth-32)}px`,
      "--bubble-max-height":`${this.#maxBubbleHeight(this.#renderViewport)}px`,
    } : {};
    for (const key of ["--model-left","--model-top","--model-width","--model-height","--bubble-left","--bubble-top","--bubble-width","--bubble-max-height"]) {
      if (variables[key]) this.anchor.style.setProperty(key,variables[key]);
      else this.anchor.style.removeProperty(key);
    }
    this.invalidate();
    ++this.#pending;
    // send shares the native geometry queue with mask/bubble updates. An old
    // in-flight mask finishes before resize clears it, never after that clear.
    const sent = this.send(native);
    let succeeded = false;
    this.#tail = Promise.all([this.#tail.catch(()=>{}),sent]).then(() => {succeeded=true;}).catch(error => {
      this.failed();throw error;
    }).finally(() => {
      if (--this.#pending === 0 && succeeded) this.applied();
    });
    void this.#tail.catch(()=>{});
  }
}
