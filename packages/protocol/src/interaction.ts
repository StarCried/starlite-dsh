export const MAX_INTERACTION_BYTES = 32_768;
export const ACTIVITIES = ["thinking", "responding", "command", "editing", "reading", "searching", "compacting", "tool", "waiting", "completed", "error", "blocked", "idle"] as const;
export type PetActivity = typeof ACTIVITIES[number];
export interface PetSession { ref: string; title: string }
export interface PetQuestion { id: string; question: string; header?: string; detail?: string; options: Array<{label: string; description?: string}>; multiSelect: boolean }
export type PetQuestionWait = {state:"timed";deadline:number;issuedAt:number}|{state:"continued"};
export interface PetInteraction { interactionVersion: 1; requestId: string; sessionRef: string; questions: PetQuestion[]; wait?:PetQuestionWait }
export interface PetAnswer { requestId: string; sessionRef: string; answers: Array<{id: string; selected: string[]; custom?: string}> }

export function isOpaqueRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
export function parsePetSession(value: unknown): PetSession {
  const row = record(value);
  if (!isOpaqueRef(row.ref)) throw Error("invalid session reference");
  return {ref:row.ref,title:text(row.title,320)};
}
export function parsePetInteraction(value: unknown): PetInteraction {
  const row = record(value);
  if(row.interactionVersion!==1 || !isOpaqueRef(row.requestId) || !isOpaqueRef(row.sessionRef)) throw Error("invalid interaction identity");
  const ids=new Set<string>();
  const questions=list(row.questions,8).map(raw=>{
    const item=record(raw),id=text(item.id,128); if(ids.has(id)) throw Error("duplicate question"); ids.add(id);
    const labels=new Set<string>();
    const options=item.options===undefined?[]:list(item.options,20,true).map(rawOption=>{
      const option=record(rawOption),label=text(option.label,1024);if(labels.has(label))throw Error("duplicate option");labels.add(label);
      return {label,...(option.description===undefined?{}:{description:text(option.description,2048)})};
    });
    if(item.multiSelect!==undefined && typeof item.multiSelect!=="boolean")throw Error("invalid multi-select flag");
    return {id,question:text(item.question,4096),options,multiSelect:item.multiSelect===true,
      ...(item.header===undefined?{}:{header:text(item.header,128)}),...(item.detail===undefined?{}:{detail:text(item.detail,8192)})};
  });
  let wait:PetQuestionWait|undefined;
  if(row.wait!==undefined){
    const value=record(row.wait);
    if(value.state==="continued")wait={state:"continued"};
    else if(value.state==="timed"&&Number.isSafeInteger(value.deadline)&&Number(value.deadline)>=0&&Number(value.deadline)<=8_640_000_000_000_000
      &&Number.isSafeInteger(value.issuedAt)&&Number(value.issuedAt)>=0&&Number(value.issuedAt)<=Number(value.deadline)&&Number(value.deadline)-Number(value.issuedAt)<=2_147_483_647)wait={state:"timed",deadline:Number(value.deadline),issuedAt:Number(value.issuedAt)};
    else throw Error("invalid question wait");
  }
  const result:PetInteraction={interactionVersion:1,requestId:row.requestId,sessionRef:row.sessionRef,questions,...(wait?{wait}:{})};
  bound(result);return result;
}
export function parsePetAnswer(value: unknown, request?: PetInteraction): PetAnswer {
  const row=record(value);if(!isOpaqueRef(row.requestId)||!isOpaqueRef(row.sessionRef))throw Error("invalid answer identity");
  const ids=new Set<string>();
  const answers=list(row.answers,8).map(raw=>{
    const item=record(raw),id=text(item.id,128);if(ids.has(id))throw Error("duplicate answer");ids.add(id);
    const selected=list(item.selected,20,true).map(label=>text(label,1024));
    if(new Set(selected).size!==selected.length)throw Error("duplicate selection");
    const custom=item.custom===undefined?undefined:text(item.custom,8192);
    if(!selected.length&&!custom)throw Error("empty answer");
    return {id,selected,...(custom===undefined?{}:{custom})};
  });
  const result:PetAnswer={requestId:row.requestId,sessionRef:row.sessionRef,answers};bound(result);
  if(request){
    if(result.requestId!==request.requestId||result.sessionRef!==request.sessionRef||answers.length!==request.questions.length)throw Error("stale or incomplete answer");
    for(const item of answers){
      const question=request.questions.find(q=>q.id===item.id);
      if(!question||(!question.multiSelect&&(item.selected.length>1||item.selected.length>0&&item.custom!==undefined)))throw Error("invalid selection");
      if(item.selected.some(label=>!question.options.some(option=>option.label===label)))throw Error("unknown option");
    }
  }
  return result;
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw Error("invalid interaction object");return value as Record<string,unknown>}
function text(value:unknown,max:number):string{
  // Preserve exact option labels and multiline answers; render only as text.
  // oxlint-disable-next-line no-control-regex
  if(typeof value!=="string"||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value))throw Error("invalid interaction text");return value;
}
function list(value:unknown,max:number,empty=false):unknown[]{if(!Array.isArray(value)||value.length>max||(!empty&&!value.length))throw Error("invalid interaction list");return value}
function bound(value:unknown):void{if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_INTERACTION_BYTES)throw Error("interaction exceeds wire limit")}
