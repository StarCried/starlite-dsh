import {describe,it,expect,vi} from "vitest";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {browserEnvironment,browserWorkerScript,openDshSession} from "../src/navigation.js";
import {followCompanionSession,type Sessions} from "../src/client.js";
describe("exact companion navigation",()=>{
  it("uses Node mode to enter an opener worker but removes it before the launcher and its child",async()=>{
    const directory = await mkdtemp(join(tmpdir(), "starlite-opener-"));
    try {
      const fixture = join(directory, "open fixture.mjs");
      // The real open package starts PowerShell without an env override, which
      // propagates Electron's Node flag to the associated GUI unless removed.
      await writeFile(fixture, `import {execFileSync} from "node:child_process";
        const atImport = process.env.ELECTRON_RUN_AS_NODE ?? null;
        export default async (target, options) => {
          const child = JSON.parse(execFileSync(${JSON.stringify(process.execPath)}, ["--input-type=module", "--eval",
            "process.stdout.write(JSON.stringify({nodeFlag:process.env.ELECTRON_RUN_AS_NODE??null,apiKey:process.env.DEEPSEEK_API_KEY??null}))"], {encoding:"utf8"}));
          process.stdout.write(JSON.stringify({target,wait:options.wait,atImport,child}));
        };`);
      const target = "dsh://open";
      const env = {...browserEnvironment({...process.env, DEEPSEEK_API_KEY: "must-not-leave-host"}), ELECTRON_RUN_AS_NODE: "1"};
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", browserWorkerScript(pathToFileURL(fixture).href), target], {env, windowsHide: true, timeout: 5_000});
      expect(JSON.parse(result.stdout)).toEqual({target, wait: true, atImport: null, child: {nodeFlag: null, apiKey: null}});
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1"); // The parent/worker startup contract remains intact.
    } finally {await rm(directory, {recursive: true, force: true});}
  });

  it("opens the authenticated Web UI home only for an explicit absent session",async()=>{
    const open=vi.fn(async(_url:string)=>undefined);
    const context={get:(name:string)=>name==="webServer"?{host:"127.0.0.1",port:4194}:{authenticatedUrl:(url:string)=>`${url}?launchToken=private#stale-hint`}};
    await openDshSession(context,undefined,open);
    const target=new URL(open.mock.calls[0]![0]!);
    expect(target.origin).toBe("http://127.0.0.1:4194");expect(target.pathname).toBe("/");
    expect(target.searchParams.get("launchToken")).toBe("private");expect(target.hash).toBe("");
    for(const key of [null,{},"session",{id:""},{id:"bad\nidentity"}])await expect(openDshSession(context,key,open)).rejects.toThrow("session unavailable");
    expect(open).toHaveBeenCalledOnce();
    for(const authenticated of ["https://evil.invalid/","http://127.0.0.1:4194/other"]){
      await expect(openDshSession({get:(name:string)=>name==="webServer"?{host:"127.0.0.1",port:4194}:{authenticatedUrl:()=>authenticated}},undefined,open)).rejects.toThrow("Web UI unavailable");
    }
    expect(open).toHaveBeenCalledOnce();
  });
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
