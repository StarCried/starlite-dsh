export interface ModelViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
}

const BASE: ModelViewport = {left:0,top:0,width:320,height:480,baseWidth:320,baseHeight:480};

function validViewport(value: unknown): value is ModelViewport {
  if (!value || typeof value !== "object") return false;
  const v = value as ModelViewport;
  return [v.left,v.top,v.width,v.height,v.baseWidth,v.baseHeight].every(Number.isFinite)
    && v.baseWidth === 320 && v.baseHeight === 480 && v.left <= 0 && v.top <= 0
    && v.width <= 4096 && v.height <= 4096
    && v.width + v.left >= v.baseWidth && v.height + v.top >= v.baseHeight;
}

/** Keep the model and bubble anchored while only its transparent drawing area grows. */
export class ModelViewportBridge {
  #vrm = false;
  #viewport = BASE;
  #pending = 0;
  #tail: Promise<void> = Promise.resolve();
  #listener = (event: Event) => {
    if (!this.#vrm || !(event.target instanceof Node) || !this.host.contains(event.target)) return;
    const value: unknown = (event as CustomEvent<unknown>).detail;
    if (!validViewport(value)) { this.failed(); return; }
    if (Object.keys(BASE).every(key => value[key as keyof ModelViewport] === this.#viewport[key as keyof ModelViewport])) return;
    this.#apply(value);
  };

  constructor(
    readonly host: HTMLElement,
    readonly anchor: HTMLElement,
    readonly send: (viewport: ModelViewport | null) => Promise<unknown>,
    readonly invalidate: () => void,
    readonly applied: () => void,
    readonly failed: () => void,
  ) {
    // Register before the renderer mounts: its initial canvas can already be expanded.
    host.addEventListener("model-viewport-change", this.#listener);
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

  ready(): Promise<void> { return this.#tail; }

  destroy(): Promise<void> {
    this.host.removeEventListener("model-viewport-change", this.#listener);
    return this.configure(false);
  }

  #apply(value: ModelViewport | null): void {
    this.#viewport = value ?? BASE;
    this.anchor.classList.toggle("vrm-viewport", value !== null);
    const variables: Record<string,string> = value ? {
      "--model-left":`${-value.left}px`, "--model-top":`${-value.top}px`,
      "--model-width":`${value.baseWidth}px`, "--model-height":`${value.baseHeight}px`,
      "--bubble-left":`${-value.left + value.baseWidth / 2}px`,
      "--bubble-top":`${-value.top + 10}px`, "--bubble-width":`${Math.min(420,value.baseWidth-32)}px`,
      "--bubble-max-height":`${value.baseHeight-48}px`,
    } : {};
    for (const key of ["--model-left","--model-top","--model-width","--model-height","--bubble-left","--bubble-top","--bubble-width","--bubble-max-height"]) {
      if (variables[key]) this.anchor.style.setProperty(key,variables[key]);
      else this.anchor.style.removeProperty(key);
    }
    this.invalidate();
    ++this.#pending;
    // send shares the native geometry queue with mask/bubble updates. An old
    // in-flight mask finishes before resize clears it, never after that clear.
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
