export const inject=["sessions"];
interface Address {parentSessionId:string;childSessionId:string;mode:"one-shot"|"continuable"}
interface List {ids:string[];phase:string;subagentsByParent?:Record<string,{entries:{kind:string;id:string;mode?:Address["mode"]}[]}>}
export interface Sessions {
  list:{getSnapshot():List;subscribe(listener:()=>void):()=>void};
  open(id:string):void;openSubagent(address:Address):void;
  refresh():Promise<void>;refreshSubagents(id:string):Promise<void>;
}
/** A navigation hint is consumed only after the authoritative list/catalog contains it. */
export function followCompanionSession(sessions:Sessions,location:Pick<Location,"href">,history:Pick<History,"replaceState"|"state">):()=>void{
  const url=new URL(location.href), fragment=new URLSearchParams(url.hash.slice(1)),ids=fragment.getAll("companionSession"),id=ids[0];
  if(ids.length!==1||!id||id.length>256||Array.from(id).some(c=>c.charCodeAt(0)<32))return ()=>undefined;
  let done=false,discovering=false;const visited=new Set<string>();let unsubscribe:()=>void=()=>undefined;
  const stop=()=>{done=true;unsubscribe();clearTimeout(timer)};
  const consume=()=>{fragment.delete("companionSession");url.hash=fragment.toString();history.replaceState(history.state,"",url.href);stop()};
  const inspect=()=>{
    if(done)return;
    const list=sessions.list.getSnapshot();
    if(list.phase!=="ready")return;
    if(list.ids.includes(id)){stop();sessions.open(id);consume();return;}
    for(const [parentSessionId,catalog]of Object.entries(list.subagentsByParent??{})){
      const entry=catalog.entries.find(row=>row.kind==="child"&&row.id===id);
      if(entry&&(entry.mode==="one-shot"||entry.mode==="continuable")){
        stop();sessions.openSubagent({parentSessionId,childSessionId:id,mode:entry.mode});consume();return;
      }
    }
    if(!discovering){discovering=true;void discover().catch(()=>undefined).finally(()=>{discovering=false})}
  };
  const discover=async()=>{
    // Metadata only. Bounded discovery never sends prompts or selects a nearby session.
    while(!done&&visited.size<128){
      const list=sessions.list.getSnapshot();
      const children=Object.values(list.subagentsByParent??{}).flatMap(c=>c.entries.filter(e=>e.kind==="child").map(e=>e.id));
      const pending=[...list.ids,...children].find(candidate=>!visited.has(candidate));
      if(!pending)break;visited.add(pending);
      await sessions.refreshSubagents(pending).catch(()=>undefined);inspect();
    }
  };
  const timer=setTimeout(stop,20000);
  unsubscribe=sessions.list.subscribe(inspect);
  inspect();void sessions.refresh().then(inspect,()=>undefined);
  return stop;
}
export function apply(context:{sessions:Sessions;effect?(callback:()=>()=>void):unknown}):()=>void{
  const start=()=>followCompanionSession(context.sessions,window.location,window.history);
  if(context.effect){context.effect(start);return ()=>undefined}
  return start();
}
