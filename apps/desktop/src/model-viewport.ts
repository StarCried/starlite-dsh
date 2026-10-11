export interface ModelViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
}

const BASE: ModelViewport = {left:0,top:0,width:320,height:480,baseWidth:320,baseHeight:480};
// Fixed canvas margins cover the selected full-body gestures and spring motion.
// Keep this shared with renderer configuration: action bounds never resize it.
export const VRM_VIEWPORT_PADDING = Object.freeze({left:128,top:64,right:128,bottom:192});
const MAX_BUBBLE_HEIGHT = 432;
const BUBBLE_MARGIN = 12;
const BUBBLE_GAP = 24;
const MIN_BUBBLE_HEIGHT = 128;
const RESERVE = MAX_BUBBLE_HEIGHT+BUBBLE_MARGIN+BUBBLE_GAP;
const PORTRAIT_TOP = VRM_VIEWPORT_PADDING.top+RESERVE;
const FIXED: ModelViewport = {
  ...BASE,left:-VRM_VIEWPORT_PADDING.left,top:-PORTRAIT_TOP,
  width:BASE.width+VRM_VIEWPORT_PADDING.left+VRM_VIEWPORT_PADDING.right,
  height:BASE.height+VRM_VIEWPORT_PADDING.top+VRM_VIEWPORT_PADDING.bottom+RESERVE,
};

/** Reserve one stable native surface at mount. Bubble/action changes only affect
 * bubble layout, never native geometry or the model's screen anchor. */
export class ModelViewportBridge {
  #vrm = false;
  #viewport = BASE;
  #screenSpace: number | undefined;
  readonly #bubbleResize: ResizeObserver;
  readonly #bubbleVisibility: MutationObserver;
  #pending = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly host: HTMLElement,
    readonly anchor: HTMLElement,
    readonly send: (viewport: ModelViewport | null) => Promise<unknown>,
    readonly invalidate: () => void,
    readonly applied: () => void,
    readonly failed: () => void,
    readonly bubble: HTMLElement,
    readonly bubbleChanged: () => void = () => {},
  ) {
    this.#bubbleResize = new ResizeObserver(() => this.#layoutBubble());
    this.#bubbleResize.observe(bubble);
    this.#bubbleVisibility = new MutationObserver(() => this.#layoutBubble());
    this.#bubbleVisibility.observe(bubble, {attributes:true,attributeFilter:["hidden","data-interactive"]});
  }

  get pending(): boolean { return this.#pending > 0; }

  configure(vrm: boolean): Promise<void> {
    if (vrm === this.#vrm) return this.#tail;
    this.#vrm = vrm;
    this.#apply(vrm ? FIXED : null);
    return this.#tail;
  }

  hostPosition(position: {x:number;y:number}, scale: number): {x:number;y:number} {
    const dpi = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return {
      x:(position.x - Math.round(this.#viewport.left * dpi)) / dpi,
      y:(position.y - Math.round(this.#viewport.top * dpi)) / dpi,
    };
  }

  /** CSS px from model anchor to work-area top. This only budgets/positions the
   * bubble; it must never move a character in response to a changing message. */
  setScreenSpace(aboveModel: number): void {
    if (!Number.isFinite(aboveModel)) return;
    this.#screenSpace = aboveModel;
    this.#layoutBubble();
  }

  ready(): Promise<void> { return this.#tail; }

  destroy(): Promise<void> {
    this.#bubbleResize.disconnect();
    this.#bubbleVisibility.disconnect();
    return this.configure(false);
  }

  #layoutBubble(): void {
    if (!this.#vrm) return;
    const above = this.#screenSpace;
    const maxHeight = above === undefined ? MAX_BUBBLE_HEIGHT
      : Math.max(MIN_BUBBLE_HEIGHT,Math.min(MAX_BUBBLE_HEIGHT,Math.floor(above-BUBBLE_MARGIN-BUBBLE_GAP)));
    const previousHeight = this.anchor.style.getPropertyValue("--bubble-max-height");
    const previousTop = this.anchor.style.getPropertyValue("--bubble-top");
    this.anchor.style.setProperty("--bubble-max-height",`${maxHeight}px`);
    const height = this.bubble.hidden ? 0 : this.bubble.getBoundingClientRect().height;
    const visibleHeight = Number.isFinite(height) && height > 0 ? Math.min(Math.ceil(height),maxHeight) : 0;
    // Anchor to the portrait, not the transparent gesture margin above it.
    // Measure after setting max-height so a previously clipped question cannot
    // leave a later short balance card stuck at its old position. At the screen
    // edge only the bubble moves; the model keeps its user-chosen screen anchor.
    const workTop = above === undefined ? BUBBLE_MARGIN : PORTRAIT_TOP-above+BUBBLE_MARGIN;
    const top = Math.max(BUBBLE_MARGIN,PORTRAIT_TOP-BUBBLE_GAP-visibleHeight,workTop);
    this.anchor.style.setProperty("--bubble-top",`${top}px`);
    if(previousHeight!==`${maxHeight}px`||previousTop!==`${top}px`)this.bubbleChanged();
  }

  #apply(value: ModelViewport | null): void {
    this.#viewport = value ?? BASE;
    this.anchor.classList.toggle("vrm-viewport", value !== null);
    const variables: Record<string,string> = value ? {
      "--model-left":`${-value.left}px`, "--model-top":`${-value.top}px`,
      "--model-width":`${value.baseWidth}px`, "--model-height":`${value.baseHeight}px`,
      "--bubble-left":`${-value.left+value.baseWidth/2}px`, "--bubble-width":`${value.baseWidth-32}px`,
    } : {};
    for (const key of ["--model-left","--model-top","--model-width","--model-height","--bubble-left","--bubble-top","--bubble-width","--bubble-max-height"]) {
      if (variables[key]) this.anchor.style.setProperty(key,variables[key]);
      else this.anchor.style.removeProperty(key);
    }
    this.#layoutBubble();
    this.invalidate();
    ++this.#pending;
    // Native geometry and hit masks share a queue; stale masks are cleared once
    // on backend changes, not repeatedly during animation or message updates.
    const sent = this.send(value);
    let succeeded = false;
    this.#tail = Promise.all([this.#tail.catch(()=>{}),sent]).then(() => {succeeded=true;}).catch(error => {
      this.failed();throw error;
    }).finally(() => {
      if (--this.#pending === 0 && succeeded) this.applied();
    });
    void this.#tail.catch(()=>{});
  }
}
