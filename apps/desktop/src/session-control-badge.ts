import {t} from "./i18n.js";
import type {PortraitRect} from "./visitor-toolbar.js";

/** Persistent ownership notice, independent of the optional speech bubble. */
export class SessionControlBadge {
  readonly element=document.createElement("aside");
  readonly #label=document.createElement("span");
  #owner:string|undefined;
  #allowed=true;
  #rect:PortraitRect={left:0,top:0,width:0,height:30};
  constructor(exit:()=>void){
    this.element.className="session-control-badge";this.element.dataset.environmentExclusion="";this.element.hidden=true;
    const button=document.createElement("button");button.type="button";button.textContent="×";
    button.title=t("退出会话接管");button.setAttribute("aria-label",t("退出会话接管"));button.addEventListener("click",exit);
    this.element.append(this.#label,button);document.body.append(this.element);
  }
  get visible():boolean{return !this.element.hidden;}
  get rect():PortraitRect{return this.#rect;}
  owner(value:string|undefined):void{
    this.#owner=value;this.#label.textContent=value?`${t("会话接管")} · ${value}`:"";
    this.#label.title=this.#label.textContent;this.#sync();
  }
  show(allowed:boolean):void{this.#allowed=allowed;this.#sync();}
  place(portrait:PortraitRect):void{
    const width=Math.max(160,Math.min(250,portrait.width));
    this.#rect={left:portrait.left+portrait.width/2-width/2,top:portrait.top+portrait.height-32,width,height:30};
    Object.assign(this.element.style,{left:`${this.#rect.left}px`,top:`${this.#rect.top}px`,width:`${width}px`});
  }
  destroy():void{this.element.remove();}
  #sync():void{this.element.hidden=!this.#owner||!this.#allowed;}
}
