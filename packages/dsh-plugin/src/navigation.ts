import {spawn} from "node:child_process";

interface Services {get?(name:string):unknown}
/** Authenticated URL and real session identity never leave the DSH process boundary. */
export async function openDshSession(context:Services,key:unknown,openUrl=openLocalBrowser):Promise<void>{
  const session=record(key), web=record(context.get?.("webServer")), connection=record(context.get?.("connection"));
  if(typeof session?.id!=="string"||!session.id||session.id.length>256||Array.from(session.id).some(c=>c.charCodeAt(0)<32)
    ||web?.host!=="127.0.0.1"||!Number.isInteger(web.port)||Number(web.port)<1||Number(web.port)>65535
    ||typeof connection?.authenticatedUrl!=="function")throw Error("DSH Web UI unavailable");
  const url=new URL(`http://127.0.0.1:${web.port}/`);
  const authenticated=(connection.authenticatedUrl as (base:string)=>unknown).call(connection,url.href);
  if(typeof authenticated!=="string")throw Error("DSH Web UI unavailable");
  const target=new URL(authenticated);
  if(target.origin!==url.origin||target.pathname!=="/")throw Error("DSH Web UI unavailable");
  // DSH's authentication redirect drops query parameters. A browser-owned
  // fragment survives that redirect and never enters an HTTP request/log.
  target.hash=new URLSearchParams({companionSession:session.id}).toString();
  await openUrl(target.href);
}
// The opener needs OS launcher variables, never DSH/provider credentials.
export function browserEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const result:NodeJS.ProcessEnv={};
  for(const name of ["PATH","HOME","LANG","LC_ALL","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR","XDG_CURRENT_DESKTOP","DBUS_SESSION_BUS_ADDRESS","WSL_INTEROP","WSL_DISTRO_NAME","SYSTEMROOT","SystemRoot","TEMP","TMP"]){
    if(source[name]!==undefined)result[name]=source[name];
  }
  return result;
}
async function openLocalBrowser(url:string):Promise<void>{
  const script=`const {default:open}=await import(${JSON.stringify(import.meta.resolve("open"))});await open(process.argv[1],{wait:true});`;
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,["--input-type=module","--eval",script,url],{env:browserEnvironment(process.env),stdio:"ignore",windowsHide:true,shell:false});
    const timer=setTimeout(()=>{child.kill();reject(Error("DSH Web UI could not open"))},10000);timer.unref();
    child.once("error",()=>{clearTimeout(timer);reject(Error("DSH Web UI could not open"))});
    child.once("exit",code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error("DSH Web UI could not open"))});
  });
}
function record(value:unknown):Record<string,unknown>|undefined{return value&&typeof value==="object"?value as Record<string,unknown>:undefined}
