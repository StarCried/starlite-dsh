import type {PetSnapshot,PetActivity,PetInteraction,PetAnswer} from "@starcried/starlite-dsh-protocol";
import type {DesktopPreferences} from "./types.js";
import {createQuestionForm} from "./question-form.js";

const ACTIVITIES:Record<PetActivity,string>={thinking:"思考中",responding:"输出中",command:"运行命令",editing:"编辑文件",reading:"读取文件",searching:"搜索中",compacting:"压缩上下文",tool:"使用工具",waiting:"等待输入",completed:"已完成",error:"出错",blocked:"遇到阻碍",idle:"待机"};
const STATE_ACTIVITY={thinking:"思考中",working:"工作中",completed:"已完成",error:"发生错误，请查看 DSH",blocked:"任务被阻塞，请查看 DSH",approval:"等待确认，请查看 DSH",idle:"待机"};

export function renderPlainBubble(element:HTMLElement,text:string,kind:string,title?:string):void{
  let content=element.querySelector<HTMLSpanElement>(".bubble-content"),heading=element.querySelector<HTMLSpanElement>(".bubble-title");
  if(!content){content=document.createElement("span");content.className="bubble-content";element.replaceChildren(content);heading=null;}
  if(title){if(!heading){heading=document.createElement("span");heading.className="bubble-title";element.prepend(heading)}heading.textContent=title;}else heading?.remove();
  content.textContent=text;element.dataset.bubbleKind=kind;delete element.dataset.interactive;element.hidden=false;
  delete element.dataset.bubbleMode;
}
export function renderBubble(element:HTMLElement,snapshot:PetSnapshot,privacy:boolean,mode:DesktopPreferences["bubbleMode"]="compact"):void{
  if(snapshot.state==="idle"){element.hidden=true;element.replaceChildren();delete element.dataset.bubbleKind;delete element.dataset.interactive;return;}
  const activity=snapshot.activity==="waiting"&&!snapshot.inputRequest?STATE_ACTIVITY.approval:snapshot.activity?ACTIVITIES[snapshot.activity]:STATE_ACTIVITY[snapshot.state];
  const text=privacy||mode==="compact"?activity:snapshot.bubble?.text??activity;
  renderPlainBubble(element,text,privacy||mode==="compact"?"notice":snapshot.bubble?.kind??"notice",privacy?"DSH":snapshot.session?.title??"DSH 会话");
  element.dataset.bubbleMode=privacy?"compact":mode;
}

interface QuestionActions {
  read(id:string):Promise<PetInteraction>;answer(value:PetAnswer):Promise<void>;
  open(ref:string):Promise<void>;changed():void;
}
export class WorkBubble {
  #generation=0;#key:string|undefined;#latest:PetSnapshot|undefined;#preferences:DesktopPreferences|undefined;
  #waitTimer:ReturnType<typeof setInterval>|undefined;
  #hostFrame:{sequence:number;emittedAt:number;receivedAt:number}|undefined;
  #refreshCountdown:((frame:{emittedAt:number;receivedAt:number})=>void)|undefined;
  constructor(readonly element:HTMLElement,readonly actions:QuestionActions){}
  clear():void{this.#stopCountdown();this.#hostFrame=undefined;++this.#generation;this.#key=undefined;this.element.hidden=true;this.element.replaceChildren();delete this.element.dataset.interactive;this.actions.changed()}
  update(snapshot:PetSnapshot,preferences:DesktopPreferences):void{
    this.#latest=snapshot;this.#preferences=preferences;
    const key=!preferences.privacyMode&&snapshot.inputRequest&&snapshot.session?`${snapshot.session.ref}/${snapshot.inputRequest}`:undefined;
    if(!this.#hostFrame||snapshot.sequence>this.#hostFrame.sequence){
      this.#hostFrame={sequence:snapshot.sequence,emittedAt:snapshot.emittedAt,receivedAt:performance.now()};
      if(key&&key===this.#key)this.#refreshCountdown?.(this.#hostFrame);
    }
    if(key&&key===this.#key){const title=this.element.querySelector(".bubble-title");if(title)title.textContent=snapshot.session!.title;return;}
    this.#stopCountdown();++this.#generation;this.#key=key;
    if(!key){renderBubble(this.element,snapshot,preferences.privacyMode,preferences.bubbleMode);this.actions.changed();return;}
    this.#load(snapshot);
  }
  #load(snapshot:PetSnapshot):void{
    const generation=this.#generation,requestId=snapshot.inputRequest!,sessionRef=snapshot.session!.ref;
    renderPlainBubble(this.element,"正在加载输入…","notice",snapshot.session!.title);this.element.dataset.interactive="true";
    const body=this.element.querySelector(".bubble-content")!,open=document.createElement("button"),retry=document.createElement("button"),status=document.createElement("span");
    body.className="question-body";open.type="button";open.textContent="转到 DSH 回答";retry.type="button";retry.textContent="重试";retry.hidden=true;
    status.className="question-status question-navigation-status";status.setAttribute("role","status");status.hidden=true;
    open.addEventListener("click",async()=>{
      if(generation!==this.#generation)return;
      open.disabled=true;status.hidden=true;status.textContent="";this.actions.changed();
      try{await this.actions.open(sessionRef);}
      catch{if(generation===this.#generation){status.textContent="暂时无法转到 DSH 回答。请重试，或继续在气泡中回答。";status.hidden=false;open.disabled=false;this.actions.changed();}}
    });
    retry.addEventListener("click",()=>{if(this.#latest&&this.#preferences){this.#key=undefined;this.update(this.#latest,this.#preferences)}});
    this.element.append(open,retry,status);this.actions.changed();
    void this.actions.read(requestId).then(request=>{
      if(generation!==this.#generation)return;
      if(request.sessionRef!==sessionRef)throw Error("question changed");
      body.replaceChildren(createQuestionForm(request,async answer=>{
        if(generation!==this.#generation)throw Error("question changed");
        await this.actions.answer(answer);
      }));this.#showWait(request,generation,body);this.actions.changed();
    }).catch(()=>{
      if(generation!==this.#generation)return;
      body.textContent="输入请求暂时无法加载。";retry.hidden=false;this.actions.changed();
    });
  }
  #showWait(request:PetInteraction,generation:number,body:Element):void{
    if(!request.wait)return;
    const status=document.createElement("span");status.className="question-status question-wait-status";body.before(status);
    if(request.wait.state==="continued"){
      status.setAttribute("role","status");status.textContent="DSH 已继续处理，仍可补答。";return;
    }
    status.setAttribute("role","timer");
    const deadline=request.wait.deadline;
    // Both wire times belong to the Host. Only local monotonic elapsed time
    // advances the display; WSL and Windows wall clocks need not agree.
    let endsAt=performance.now()+deadline-request.wait.issuedAt;
    const shorten=(frame:{emittedAt:number;receivedAt:number})=>{endsAt=Math.min(endsAt,frame.receivedAt+deadline-frame.emittedAt);};
    if(this.#hostFrame)shorten(this.#hostFrame);
    const tick=()=>{
      if(generation!==this.#generation){this.#stopCountdown();return;}
      const seconds=Math.max(0,Math.ceil((endsAt-performance.now())/1000));
      const text=seconds?`剩余 ${seconds} 秒；到时 DSH 将继续处理。`:"等待时间已结束，DSH 将继续处理。";
      if(status.textContent!==text){status.textContent=text;this.actions.changed();}
      if(seconds===0)this.#stopCountdown();
    };
    this.#refreshCountdown=frame=>{shorten(frame);tick();};
    tick();if(endsAt>performance.now())this.#waitTimer=setInterval(tick,250);
  }
  #stopCountdown():void{clearInterval(this.#waitTimer);this.#waitTimer=undefined;this.#refreshCountdown=undefined;}
}
