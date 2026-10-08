import {describe,it,expect,vi} from "vitest";
import {browserEnvironment,openDshSession} from "../src/navigation.js";
import {followCompanionSession,type Sessions} from "../src/client.js";
describe("exact companion navigation",()=>{
  it("keeps authentication in the host opener and rejects non-loopback services",async()=>{
    const open=vi.fn(async(_url:string)=>undefined);
    const context={get:(name:string)=>name==="webServer"?{host:"127.0.0.1",port:4194}:{authenticatedUrl:(url:string)=>{const target=new URL(url);target.searchParams.set("launchToken","private");return target.href}}};
    await openDshSession(context,{id:"target"},open);
    expect(new URLSearchParams(new URL(open.mock.calls[0]![0]!).hash.slice(1)).get("companionSession")).toBe("target");
    expect(browserEnvironment({PATH:"safe",DEEPSEEK_API_KEY:"secret",NODE_OPTIONS:"unsafe",WSLENV:"secret/u"})).toEqual({PATH:"safe"});
    await expect(openDshSession({get:()=>({host:"evil.invalid",port:4194})},{id:"target"},open)).rejects.toThrow();
    expect(open).toHaveBeenCalledOnce();
  });
  it("waits for the listed target, selects once and removes only its hint",async()=>{
    let list={ids:[] as string[],phase:"pending"};let changed:()=>void=()=>undefined;
    const sessions:Sessions={list:{getSnapshot:()=>list,subscribe:fn=>{changed=fn;return vi.fn()}},open:vi.fn(()=>changed()),openSubagent:vi.fn(),refresh:async()=>undefined,refreshSubagents:async()=>undefined};
    const history={state:{keep:true},replaceState:vi.fn()};
    const stop=followCompanionSession(sessions,{href:"http://127.0.0.1:4194/?launchToken=private#companionSession=target"},history);
    expect(sessions.open).not.toHaveBeenCalled();list={ids:["other","target"],phase:"ready"};changed();changed();
    expect(sessions.open).toHaveBeenCalledExactlyOnceWith("target");
    expect(history.replaceState).toHaveBeenCalledWith(history.state,"","http://127.0.0.1:4194/?launchToken=private");stop();
  });
  it("opens only an exact catalog child, and unknown sessions never select another",async()=>{
    const open=vi.fn(),child=vi.fn();const sessions:Sessions={list:{getSnapshot:()=>({ids:["root"],phase:"ready",subagentsByParent:{root:{entries:[{kind:"child",id:"child",mode:"continuable"}]}}}),subscribe:()=>()=>undefined},open,openSubagent:child,refresh:async()=>undefined,refreshSubagents:async()=>undefined};
    const history={state:null,replaceState:vi.fn()};
    const stop=followCompanionSession(sessions,{href:"http://127.0.0.1/#companionSession=child"},history);stop();
    expect(child).toHaveBeenCalledExactlyOnceWith({parentSessionId:"root",childSessionId:"child",mode:"continuable"});expect(open).not.toHaveBeenCalled();
    const unknown=followCompanionSession(sessions,{href:"http://127.0.0.1/#companionSession=missing"},history);await Promise.resolve();unknown();expect(child).toHaveBeenCalledOnce();
  });
});
