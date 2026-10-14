import {spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {release, tmpdir} from "node:os";
import {basename, dirname, join, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const self=fileURLToPath(import.meta.url);
const root=resolve(dirname(self),"..");
const PROFILE="starlite-ci-smoke";

/** A fresh Harness home and cwd, without inherited accounts, proxy settings or Node hooks. */
export function smokeEnvironment(source, directory, platform=process.platform) {
  const result={};
  for(const name of ["PATH","Path","SYSTEMROOT","SystemRoot","WINDIR","LANG","LC_ALL"]) {
    if(source[name]!==undefined)result[name]=source[name];
  }
  return {...result,HOME:join(directory,"user"),USERPROFILE:join(directory,"user"),TEMP:join(directory,"tmp"),TMP:join(directory,"tmp"),
    APPDATA:join(directory,"user","Roaming"),LOCALAPPDATA:join(directory,"user","Local"),
    DSH_HOME:join(directory,"harness"),DSH_TELEMETRY_DISABLED:"1",
    DSH_INOCHI2D_PET_EXE:platform==="win32"?join(directory,"unavailable","dsh-inochi2d-pet.exe"):"C:\\StarLite-ci-unavailable\\dsh-inochi2d-pet.exe",
    npm_config_userconfig:join(directory,"empty-npmrc"),npm_config_cache:join(directory,"npm-cache"),
  };
}

function fail(step){const error=Error(step);error.smokeStep=step;throw error;}
function ensure(value,step){if(!value)fail(step);}
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function until(test,step,milliseconds=5000){const end=Date.now()+milliseconds;while(!test()){if(Date.now()>=end)fail(step);await delay(25);}}

function runQuiet(file,args,options,step,ipc=false) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{...options,windowsHide:true,shell:false,stdio:ipc?["ignore","pipe","pipe","ipc"]:["ignore","pipe","pipe"]});
    // Boot logs can contain authentication URLs. Drain without printing or persisting them.
    child.stdout.on("data",()=>{});child.stderr.on("data",()=>{});
    let result;let failure;
    if(ipc)child.on("message",message=>{if(message?.kind==="complete")result=message.result;else if(message?.kind==="failure")failure=message.step;});
    const timer=setTimeout(()=>{child.kill();reject(Error(`${step}: timed out`));},120_000);
    child.once("error",()=>{clearTimeout(timer);reject(Error(`${step}: process failed`));});
    child.once("exit",code=>{clearTimeout(timer);if(code===0&&(!ipc||result))resolve(result);else reject(Error(`${step}: ${failure??"process failed"}`));});
  });
}

/** Install the real packed bundle using DSH, then boot and dispose through its public profile API. */
export async function smokeDshPlugin(runtimeDirectory,archive) {
  const runtime=await realpath(runtimeDirectory),packageFile=await realpath(archive);
  const metadata=JSON.parse(await readFile(join(runtime,"package.json"),"utf8"));
  ensure(metadata.name==="@deepseek-ai/dsh","not-an-official-dsh-package");
  ensure(typeof metadata.bin?.dsh==="string","official-cli-entry-unavailable");
  const cli=await realpath(resolve(runtime,metadata.bin.dsh));
  ensure(cli.startsWith(`${runtime}${sep}`),"official-cli-entry-outside-package");
  const temporary=await mkdtemp(join(tmpdir(),"starlite-dsh-smoke-"));
  try {
    const env=smokeEnvironment(process.env,temporary);
    await Promise.all([mkdir(env.HOME,{recursive:true}),mkdir(env.APPDATA,{recursive:true}),mkdir(env.LOCALAPPDATA,{recursive:true}),mkdir(env.TEMP,{recursive:true})]);
    await runQuiet(process.execPath,[self,"--initialize",runtime],{cwd:temporary,env},"initialize-profile");
    await runQuiet(process.execPath,[cli,"plugin","--profile",PROFILE,"add",packageFile],{cwd:temporary,env},"install-packed-plugin");
    const profile=join(env.DSH_HOME,"profiles",PROFILE);
    const installed=JSON.parse(await readFile(join(profile,"package.json"),"utf8"));
    ensure(typeof installed.dependencies?.["dsh-starlite"]==="string","packed-plugin-dependency-missing");
    const result=await runQuiet(process.execPath,[self,"--worker",runtime,profile],{cwd:temporary,env},"boot-lifecycle",true);
    return {dshVersion:metadata.version,...result};
  } finally {
    const actual=await realpath(temporary);
    ensure(dirname(actual)===await realpath(tmpdir())&&basename(actual).startsWith("starlite-dsh-smoke-"),"unsafe-smoke-cleanup");
    await rm(actual,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}

async function initialize(runtime) {
  const require=createRequire(join(runtime,"package.json"));
  const {initializeProfileFromDefault}=await import(pathToFileURL(require.resolve("@deepseek-ai/dsh/profile-boot")));
  initializeProfileFromDefault(PROFILE,"web",process.env.DSH_HOME);
}

async function worker(runtime,profile) {
  const capture=(_chunk,encoding,callback)=>{
    if(typeof encoding==="function")encoding();else callback?.();return true;
  };
  process.stdout.write=capture;process.stderr.write=capture;
  const request=globalThis.fetch;
  globalThis.fetch=(input,options)=>{
    const target=new URL(typeof input==="string"||input instanceof URL?input:input.url);
    ensure(target.protocol==="http:"&&target.hostname==="127.0.0.1","unexpected-external-fetch");
    return request(input,options);
  };
  const require=createRequire(join(runtime,"package.json"));
  const {prepareProfile,runProfile}=await import(pathToFileURL(require.resolve("@deepseek-ai/dsh/profile-boot")));
  const {createLaunchEnvironmentSnapshot}=await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-launch-environment")));
  const environment=createLaunchEnvironmentSnapshot([{source:"process",values:process.env}]);
  const native=process.platform==="win32";
  const host=native?"windows":release().toLowerCase().includes("microsoft")?"wsl":"unsupported";
  const servers=()=>process.getActiveResourcesInfo().filter(type=>type.toLowerCase()==="tcpserverwrap").length;
  const before=servers();
  ensure(prepareProfile(PROFILE).layers.some(layer=>layer.packageName==="dsh-starlite"),"packed-plugin-bundle-not-composed");
  const running=await runProfile({environment,profile:PROFILE,patchFiles:[],args:["--host","127.0.0.1","--port","0","--no-open"]});
  try {
    const web=running.ctx.get("webServer"),connection=running.ctx.get("connection");
    ensure(web?.host==="127.0.0.1"&&Number.isInteger(web.port)&&web.port>0,"loopback-web-ui-unavailable");
    ensure(typeof connection?.authenticatedUrl==="function","web-ui-authentication-unavailable");
    const base=`http://127.0.0.1:${web.port}/`;
    const home=async()=>{
      const target=new URL(connection.authenticatedUrl(base));
      ensure(target.origin===new URL(base).origin,"unexpected-authentication-origin");
      let response=await fetch(target,{redirect:"manual",signal:AbortSignal.timeout(5000)});
      if(response.status>=300&&response.status<400){
        const location=new URL(response.headers.get("location"),base);
        ensure(location.origin===new URL(base).origin,"unexpected-login-redirect");
        const cookies=response.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; ");
        await response.body?.cancel();
        response=await fetch(location,{redirect:"manual",headers:{Cookie:cookies},signal:AbortSignal.timeout(5000)});
      }
      ensure(response.status===200&&response.headers.get("content-type")?.includes("text/html"),"authenticated-web-ui-failed");
      await response.body?.cancel();
    };
    await home();
    await until(()=>servers()>=before+(host==="unsupported"?1:2),"expected-http-servers-unavailable");
    const active=servers();
    const pluginRequire=createRequire(join(profile,"package.json"));
    const {apply}=await import(pathToFileURL(pluginRequire.resolve("dsh-starlite")));
    // A real Cordis logger can export independently of terminal logging. Its
    // default buffer threshold excludes WARN, so explicitly admit that level.
    const diagnostics={bridgeReady:false,disabled:false,launchFailed:false};
    const releaseLogger=running.ctx.logger.exporter({levels:{default:3},export(message){
      for(const argument of message.args){
        if(typeof argument!=="string")continue;
        diagnostics.bridgeReady ||= argument.includes("StarLite for DSH status bridge is ready.");
        diagnostics.disabled ||= argument.includes("StarLite for DSH is disabled because");
        diagnostics.launchFailed ||= argument.includes("StarLite for DSH could not start the Windows companion");
      }
    }});
    const releaseProbe=await apply({get:name=>running.ctx.get(name),on:(...args)=>running.ctx.on(...args),logger:running.ctx.logger});
    try {
      if(host==="unsupported")await until(()=>diagnostics.disabled&&!diagnostics.bridgeReady,"unsupported-host-not-disabled");
      else await until(()=>diagnostics.bridgeReady&&diagnostics.launchFailed,"native-bridge-or-fail-open-unavailable");
    }finally{await releaseProbe();await releaseLogger();}
    await until(()=>servers()===active,"launch-probe-server-leak");
    let warned=false;
    const dispose=await apply({on(){throw Error("generated incompatible event subscription");},logger:{warn(){warned=true;}}});
    ensure(typeof dispose==="function"&&warned,"incompatible-adapter-not-fail-open");
    await dispose();await home();
    await until(()=>servers()===active,"incompatible-adapter-server-leak");
    await running.shutdown.shutdown(0);
    await until(()=>servers()<=before,"host-disposal-server-leak");
    let closed=false;try{const response=await fetch(base,{signal:AbortSignal.timeout(500)});await response.body?.cancel();}catch{closed=true;}
    ensure(closed,"web-ui-still-running-after-disposal");
    return {host,packedInstall:true,authenticatedWebUi:true,failOpen:true,lifecycle:true,paidApiTest:false};
  } finally {await running.shutdown.shutdown(0);}
}

if(process.argv[1]&&resolve(process.argv[1])===self) {
  const [mode,...args]=process.argv.slice(2);
  if(mode==="--initialize")await initialize(resolve(args[0]));
  else if(mode==="--worker"){
    try{process.send?.({kind:"complete",result:await worker(resolve(args[0]),resolve(args[1]))});}
    catch(error){process.send?.({kind:"failure",step:error?.smokeStep??"public-profile-boot-failed"},()=>process.exit(1));process.exitCode=1;}
    finally{process.disconnect?.();}
  }else{
    const runtime=mode??process.env.DSH_PACKAGE_ROOT;
    ensure(runtime,"usage: node tools/smoke-dsh-plugin.mjs <official-dsh-package-directory> [packed-plugin.tgz]");
    const metadata=JSON.parse(await readFile(join(root,"packages/dsh-plugin/package.json"),"utf8"));
    const archive=args[0]??join(root,"packages/dsh-plugin/.pack",`dsh-starlite-${metadata.version}.tgz`);
    // No account data, log output, paths or authentication URLs enter the report.
    console.log(JSON.stringify(await smokeDshPlugin(resolve(runtime),resolve(archive))));
  }
}
