import type {VisitorToolbar} from "./vendor-types.js";

export interface PortraitRect {left:number;top:number;width:number;height:number}
export const TOOLBAR_GAP = 10;
const LEAVE_DELAY_MS = 650;
const NEAR_MARGIN = 24;

/** Native cursor events also arrive over transparent pixels and while paused.
 * The reference portrait stays fixed through size/animation changes. */
export class PetVisitorToolbar {
  #enabled = false;
  #visible = false;
  #focused = false;
  #near = false;
  #lastPoint: {x:number;y:number} | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reference: PortraitRect;
  readonly #focus = (event: Event) => {
    this.#focused = (event as CustomEvent<{focused:boolean}>).detail.focused;
    if (this.#focused && this.#enabled) this.#show(true);
    else if(!this.#near)this.#leave();
  };

  constructor(readonly toolbar: VisitorToolbar, reference: PortraitRect, readonly changed: () => void) {
    this.#reference = {...reference};
    toolbar.element.addEventListener("starlite-toolbar-focus", this.#focus);
    this.place();
    toolbar.show(false);
  }

  get visible(): boolean { return this.#visible; }
  get element(): HTMLElement { return this.toolbar.element; }
  get rect(): PortraitRect {
    const p=this.#reference,{width,height}=this.toolbar.dimensions;
    return {left:p.left+p.width/2-width/2,top:p.top+p.height+TOOLBAR_GAP,width,height};
  }
  place(): void {
    const rect=this.rect;
    this.toolbar.place(rect.left+rect.width/2,rect.top,1000);
  }
  setReference(reference:PortraitRect): void {
    this.clear();this.#reference={...reference};this.place();
  }
  configure(enabled: boolean): void {
    this.#enabled=enabled;
    if(!enabled)this.clear();
  }
  pointer(x:number,y:number,portrait:PortraitRect): void {
    if(!Number.isFinite(x) || !Number.isFinite(y))return;
    if(this.#lastPoint?.x===x&&this.#lastPoint.y===y)return;
    this.#lastPoint={x,y};
    if(!this.#enabled)return;
    const near=(r:PortraitRect)=>x>=r.left-NEAR_MARGIN&&x<=r.left+r.width+NEAR_MARGIN&&y>=r.top-NEAR_MARGIN&&y<=r.top+r.height+NEAR_MARGIN;
    this.#near=near(portrait)||near(this.rect);
    if(this.#near){this.#stopTimer();this.#show(true);}
    else this.#leave();
  }
  clear(): void {
    this.#stopTimer();this.#focused=false;this.#near=false;this.#show(false);
    // Shared focus-within styling intentionally keeps keyboard controls visible.
    // A native hide/blur must release that focus before clearing its hit region.
    const active=this.element.ownerDocument.activeElement;
    if(active instanceof HTMLElement&&this.element.contains(active))active.blur();
  }
  destroy(): void {
    this.clear();this.toolbar.element.removeEventListener("starlite-toolbar-focus",this.#focus);this.toolbar.destroy();
  }
  #stopTimer(): void {if(this.#timer!==undefined)clearTimeout(this.#timer);this.#timer=undefined;}
  #leave(): void {
    if(this.#focused||!this.#visible||this.#timer!==undefined)return;
    this.#timer=setTimeout(()=>{this.#timer=undefined;this.#show(false);},LEAVE_DELAY_MS);
  }
  #show(visible:boolean): void {
    if(this.#visible===visible)return;
    this.#visible=visible;this.toolbar.show(visible);this.changed();
  }
}

/** Same persisted range as the full quick menu; adjust ten percentage points. */
export function steppedPetScale(scale:number,direction:-1|1):number {
  return Math.max(Math.min(.5,scale),Math.min(Math.max(1.5,scale),Math.round((scale+direction*.1)*100)/100));
}

/** Position restoration must keep the fixed controls on screen after shrinking. */
export function portraitWithToolbar(portrait:PortraitRect,toolbar?:PortraitRect):PortraitRect {
  if(!toolbar)return portrait;
  const left=Math.min(portrait.left,toolbar.left),top=Math.min(portrait.top,toolbar.top);
  return {left,top,width:Math.max(portrait.left+portrait.width,toolbar.left+toolbar.width)-left,
    height:Math.max(portrait.top+portrait.height,toolbar.top+toolbar.height)-top};
}
