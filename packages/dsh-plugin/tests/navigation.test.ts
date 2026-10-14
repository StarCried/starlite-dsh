import {describe,it,expect,vi} from "vitest";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {browserEnvironment,browserWorkerScript,openDshSession} from "../src/navigation.js";
import {apply,followCompanionSession,type Sessions} from "../src/client.js";
describe("exact companion navigation",()=>{
  it("mounts Web navigation without reading an uninjected sibling Connection service",()=>{
    const openSession = vi.fn(), replaceState = vi.fn();
    vi.stubGlobal("window", {location: {href: "http://127.0.0.1/#companionSession=target"}, history: {state: null, replaceState}});
    const sessions: Sessions = {list: {getSnapshot: () => ({ids: ["target"], phase: "ready"}), subscribe: () => () => undefined}, refresh: async () => undefined, refreshProjections: async () => undefined};
    const scope = {sessions, uiWorkspace: {openSession}, get connection(): never {throw Error("cannot get property connection without inject");}};
    try {
      const stop = apply({sessions, inject: (names, callback) => {expect(names).toEqual(["uiWorkspace"]); callback(scope);}});
      expect(openSession).toHaveBeenCalledExactlyOnceWith("target");
      expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "http://127.0.0.1/");
      stop();
    } finally {vi.unstubAllGlobals();}
  });

  it("uses Node mode to enter an opener worker but removes it before the launcher and its child",async()=>{
    const directory = await mkdtemp(join(tmpdir(), "starlite-opener-"));
    try {
      const fixture = join(directory, "open fixture.mjs");
      // The real open package starts PowerShell without an env override, which
      // propagates Electron's Node flag to the associated GUI unless removed.
      await writeFile(fixture, `import {execFileSync,spawn} from "node:child_process";
        const atImport = process.env.ELECTRON_RUN_AS_NODE ?? null;
        export default async (target, options) => {
          const child = JSON.parse(execFileSync(${JSON.stringify(process.execPath)}, ["--input-type=module", "--eval",
            "process.stdout.write(JSON.stringify({nodeFlag:process.env.ELECTRON_RUN_AS_NODE??null,apiKey:process.env.DEEPSEEK_API_KEY??null}))"], {encoding:"utf8"}));
          process.stdout.write(JSON.stringify({target,wait:options.wait,atImport,child}));
          const launcher=spawn(process.execPath,["--eval","setTimeout(()=>{},30)"],{stdio:"ignore",windowsHide:true});
          launcher.unref();await new Promise((resolve,reject)=>{launcher.once("spawn",resolve);launcher.once("error",reject)});return launcher;
        };`);
      const target = "dsh://open";
      const env = {...browserEnvironment({...process.env, DEEPSEEK_API_KEY: "must-not-leave-host"}), ELECTRON_RUN_AS_NODE: "1"};
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", browserWorkerScript(pathToFileURL(fixture).href), target], {env, windowsHide: true, timeout: 5_000});
      expect(JSON.parse(result.stdout)).toEqual({target, wait: false, atImport: null, child: {nodeFlag: null, apiKey: null}});
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1"); // The parent/worker startup contract remains intact.
    } finally {await rm(directory, {recursive: true, force: true});}
  });

  it("waits for the real launcher to finish without waiting for its long-lived GUI child",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"starlite-opener-"));let guiPid:number|undefined;
    try{
      const fixture=join(directory,"cold browser fixture.mjs");
      const launcherProgram=`const {spawn}=require("node:child_process");
        const gui=spawn(process.execPath,["--eval","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});
        gui.unref();gui.once("spawn",()=>{process.stdout.write(JSON.stringify({guiPid:gui.pid}));setTimeout(()=>process.exit(0),150);});`;
      await writeFile(fixture,`import {spawn} from "node:child_process";
        export default async(_target,options)=>{
          if(options.wait!==false)throw Error("must not wait for the GUI");
          const launcher=spawn(process.execPath,["--eval",${JSON.stringify(launcherProgram)}],{stdio:["ignore","pipe","ignore"],windowsHide:true});
          launcher.stdout.on("data",chunk=>process.stdout.write(chunk));
          launcher.unref();await new Promise((resolve,reject)=>{launcher.once("spawn",resolve);launcher.once("error",reject)});return launcher;
        };`);
      let output="";
      try{output=(await promisify(execFile)(process.execPath,["--input-type=module","--eval",browserWorkerScript(pathToFileURL(fixture).href),"http://127.0.0.1:4194/"],{env:browserEnvironment(process.env),windowsHide:true,timeout:3_000})).stdout;}
      catch(error){output=(error as {stdout?:string}).stdout??"";throw error;}
      finally{if(output)guiPid=(JSON.parse(output) as {guiPid:number}).guiPid;}
      expect(guiPid).toBeTypeOf("number");expect(()=>process.kill(guiPid!,0)).not.toThrow();
    }finally{if(guiPid)try{process.kill(guiPid)}catch{}await rm(directory,{recursive:true,force:true});}
  });

  it.each(["nonzero","spawn-error","already-exited"] as const)("observes launcher completion and failure (%s)",async mode=>{
    const directory=await mkdtemp(join(tmpdir(),"starlite-opener-"));
    try{
      const fixture=join(directory,"launcher result fixture.mjs");
      await writeFile(fixture,`import {spawn} from "node:child_process";
        export default async()=>{
          const launcher=${mode==="spawn-error"?`spawn(${JSON.stringify(join(directory,"missing-launcher.exe"))},[],{stdio:"ignore",windowsHide:true})`:`spawn(process.execPath,["--eval",${JSON.stringify(mode==="nonzero"?"setTimeout(()=>process.exit(7),30)":"process.exit(0)")}],{stdio:"ignore",windowsHide:true})`};
          ${mode==="already-exited"?`await new Promise((resolve,reject)=>{launcher.once("exit",resolve);launcher.once("error",reject)});`:`launcher.unref();`}
          return launcher;
        };`);
      const running=promisify(execFile)(process.execPath,["--input-type=module","--eval",browserWorkerScript(pathToFileURL(fixture).href),"dsh://open"],{env:browserEnvironment(process.env),windowsHide:true,timeout:3_000});
      if(mode==="already-exited")await expect(running).resolves.toMatchObject({stdout:""});
      else await expect(running).rejects.toMatchObject({code:1});
    }finally{await rm(directory,{recursive:true,force:true});}
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
