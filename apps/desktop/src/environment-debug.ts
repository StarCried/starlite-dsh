import type {EnvironmentColor, EnvironmentPatch} from "./environment-lighting.js";

export interface EnvironmentOverlays {
  viewportWidth: number;
  viewportHeight: number;
  regions: EnvironmentPatch[];
}

const FRAME_GAP = 6;
const VISIBLE_UI = "#bubble,[data-starlite-menu],[data-starlite-visitor-toolbar],[data-model-performance],[data-environment-exclusion]";

function clip(rect: EnvironmentPatch, width: number, height: number): EnvironmentPatch | undefined {
  const left=Math.max(0,rect.left),top=Math.max(0,rect.top);
  const right=Math.min(width,rect.left+rect.width),bottom=Math.min(height,rect.top+rect.height);
  return right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:undefined;
}

function visible(element: Element): boolean {
  for(let node:Element|null=element;node;node=node.parentElement){
    const style=getComputedStyle(node);
    if(node.hasAttribute("hidden")||style.display==="none"||style.visibility==="hidden")return false;
    // Keep the toolbar reserved at the beginning of its fade-in, too.
    if(style.opacity!==""&&Number(style.opacity)<=0&&node.getAttribute("data-visible")!=="true")return false;
  }
  return true;
}

/** Displays native-selected patches; it never chooses screen capture locations. */
export class EnvironmentSamplingOverlay {
  #enabled=false;
  #root:HTMLDivElement|undefined;
  #frames:EnvironmentPatch[]=[];
  #retired:{regions:EnvironmentPatch[];until:number}|undefined;
  readonly #recentUi=new Map<Element,{rect:EnvironmentPatch;until?:number}>();

  constructor(readonly label:string) {}

  setEnabled(enabled:boolean):void {
    this.#enabled=enabled;
    if(!enabled)this.clear();
  }

  update(sample:EnvironmentColor|null):void {
    const patches=sample?.patches;
    if(!this.#enabled||!patches||patches.length>8||!patches.length
      ||sample.viewportWidth!==innerWidth||sample.viewportHeight!==innerHeight
      ||patches.some(p=>![p.left,p.top,p.width,p.height].every(Number.isFinite)
        ||p.left<0||p.top<0||p.width<=0||p.height<=0||p.width>128||p.height>128
        ||p.left+p.width>innerWidth||p.top+p.height>innerHeight)){
      this.clear();return;
    }
    const root=this.#root??=document.createElement("div");
    root.dataset.environmentSamples="";
    root.setAttribute("role","img");root.setAttribute("aria-label",this.label);
    this.#frames=patches.map(p=>({left:p.left-FRAME_GAP,top:p.top-FRAME_GAP,width:p.width+2*FRAME_GAP,height:p.height+2*FRAME_GAP}));
    root.replaceChildren(...this.#frames.map(rect=>{
      const frame=document.createElement("span");frame.dataset.environmentSample="";
      Object.assign(frame.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
      return frame;
    }));
    if(!root.isConnected)document.body.append(root);
  }

  clear():void {
    if(this.#frames.length)this.#retired={regions:this.#edges(),until:performance.now()+150};
    this.#root?.remove();this.#root=undefined;this.#frames=[];
  }

  destroy():void {this.#enabled=false;this.clear();this.#retired=undefined;this.#recentUi.clear();}

  #edges():EnvironmentPatch[] {
    // Border plus a one-CSS-pixel antialiasing guard. The empty centre stays
    // available; old borders must not tint a new, slightly shifted sample.
    return this.#frames.flatMap(r=>[
      {left:r.left-1,top:r.top-1,width:r.width+2,height:3},
      {left:r.left-1,top:r.top+r.height-2,width:r.width+2,height:3},
      {left:r.left-1,top:r.top-1,width:3,height:r.height+2},
      {left:r.left+r.width-2,top:r.top-1,width:3,height:r.height+2},
    ]);
  }

  exclusions():EnvironmentOverlays {
    const now=performance.now(),width=innerWidth,height=innerHeight;
    const present=new Set<Element>();
    for(const element of document.querySelectorAll(VISIBLE_UI)){
      if(!visible(element))continue;
      const rect=element.getBoundingClientRect();
      if(rect.width<=0||rect.height<=0)continue;
      // Covers menu/bubble shadows and keeps disappearing UI excluded through
      // its fade and the next compositor frame. This never changes hit testing.
      const padding=element.hasAttribute("data-starlite-menu")?64:40;
      present.add(element);
      this.#recentUi.set(element,{rect:{left:rect.left-padding,top:rect.top-padding,width:rect.width+2*padding,height:rect.height+2*padding}});
    }
    for(const [element,value] of this.#recentUi){
      if(present.has(element))continue;
      // Start the grace period when disappearance is observed, rather than
      // at the previous 250ms poll, which may already be too old.
      value.until??=now+150;
      if(value.until<=now)this.#recentUi.delete(element);
    }
    if(this.#retired&&this.#retired.until<=now)this.#retired=undefined;
    const regions=[...this.#recentUi.values()].map(value=>value.rect)
      .concat(this.#edges(),this.#retired?.regions??[])
      .map(rect=>clip(rect,width,height)).filter((rect):rect is EnvironmentPatch=>Boolean(rect));
    // An unexpectedly crowded/debug layout disables this sample rather than
    // dropping an exclusion and accidentally reading our own UI.
    return {viewportWidth:width,viewportHeight:height,regions:regions.length<=40?regions:[{left:0,top:0,width,height}]};
  }

  matches(overlays:EnvironmentOverlays):boolean {
    return JSON.stringify(overlays)===JSON.stringify(this.exclusions());
  }
}
