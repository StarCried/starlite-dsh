import {spawn} from "node:child_process";
import {DesktopNavigationBroker, DESKTOP_NAVIGATION_TIMEOUT_MS} from "./desktop-navigation.js";
import {NAVIGATION_CHANNEL, object, sessionIdentity, type HostNavigationRpc} from "./navigation-rpc.js";

interface Services {
  get?(name:string):unknown;
  inject?(dependencies: string[], callback: (scope: Services) => (() => Promise<void>) | undefined): {dispose(): Promise<void>};
}
export interface DshNavigator {open(key: unknown): Promise<void>; close(): Promise<void>}
/** Profile ownership, not Electron's executable identity, selects Desktop navigation. */
export function createDshNavigator(context: Services, openUrl = openLocalBrowser): DshNavigator {
  if (object(context.get?.("profileContext"))?.name !== "desktop") {
    return {open: key => openDshSession(context, key, openUrl), close: async () => undefined};
  }
  let closed = false;
  const active = new Set<AbortController>();
  let binding: {broker: DesktopNavigationBroker; remove(): void | Promise<void>} | undefined;
  const attach = (scope: Services) => {
    if (closed) return;
    const rpc = object(object(scope.get?.("connection"))?.rpc) as unknown as HostNavigationRpc | undefined;
    if (typeof rpc?.handle !== "function") throw Error("DSH Desktop navigation contract unavailable");
    const broker = new DesktopNavigationBroker();
    const remove = rpc.handle(NAVIGATION_CHANNEL, (endpoint, payload, signal, peer) => broker.handle(endpoint, payload, signal, peer));
    if (typeof remove !== "function") {broker.close(); throw Error("DSH Desktop navigation disposal unavailable");}
    const current = {broker, remove};
    binding = current;
    return async () => {
      if (binding === current) {
        binding = undefined;
        for (const abort of active) abort.abort();
      }
      broker.close();
      await remove();
    };
  };
  // Cordis mounts profile bundles in parallel. The Connection service is not
  // necessarily ready when this plugin starts; own the route through its public
  // dependency lifecycle so withdrawal/replacement also revokes pending targets.
  const injected = context.inject?.(["connection"], scope => {
    try {return attach(scope);} catch {return undefined;} // Navigation must not stop DSH boot.
  });
  const detach = context.inject ? undefined : attach(context);
  return {
    async open(key) {
      if (closed) throw Error("DSH Desktop unavailable");
      const id = record(key)?.id;
      if (key !== undefined && !sessionIdentity(id)) throw Error("DSH session unavailable");
      if (key !== undefined && !binding) throw Error("DSH Desktop session unavailable");
      const request = key === undefined ? undefined : binding!.broker.request(id as string);
      const abort = new AbortController();
      active.add(abort);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => {request?.cancel(); reject(Error("DSH Desktop session unavailable"));}, {once: true});
        timer = setTimeout(() => abort.abort(), DESKTOP_NAVIGATION_TIMEOUT_MS);
        timer.unref?.();
      });
      try {await Promise.race([Promise.all([openUrl("dsh://open", abort.signal), request?.result]), deadline]);}
      catch (error) {request?.cancel(); throw error;}
      finally {active.delete(abort); clearTimeout(timer); abort.abort();}
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const abort of active) abort.abort();
      await injected?.dispose();
      await detach?.();
    },
  };
}
/** An undefined key explicitly opens the Web UI home; supplied keys must identify a session. */
export async function openDshSession(context:Services,key:unknown,openUrl=openLocalBrowser):Promise<void>{
  const session=record(key), web=record(context.get?.("webServer")), connection=record(context.get?.("connection"));
  if(key!==undefined&&(typeof session?.id!=="string"||!session.id||session.id.length>256||Array.from(session.id).some(c=>c.charCodeAt(0)<32)))throw Error("DSH session unavailable");
  if(web?.host!=="127.0.0.1"||!Number.isInteger(web.port)||Number(web.port)<1||Number(web.port)>65535
    ||typeof connection?.authenticatedUrl!=="function")throw Error("DSH Web UI unavailable");
  const url=new URL(`http://127.0.0.1:${web.port}/`);
  const authenticated=(connection.authenticatedUrl as (base:string)=>unknown).call(connection,url.href);
  if(typeof authenticated!=="string")throw Error("DSH Web UI unavailable");
  const target=new URL(authenticated);
  if(target.origin!==url.origin||target.pathname!=="/")throw Error("DSH Web UI unavailable");
  // DSH's authentication redirect drops query parameters. A browser-owned
  // fragment survives that redirect and never enters an HTTP request/log.
  target.hash=key===undefined?"":new URLSearchParams({companionSession:session!.id as string}).toString();
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
async function openLocalBrowser(url:string, signal?: AbortSignal):Promise<void>{
  const script=`const {default:open}=await import(${JSON.stringify(import.meta.resolve("open"))});await open(process.argv[1],{wait:true});`;
  await new Promise<void>((resolve,reject)=>{
    const env = browserEnvironment(process.env);
    // Desktop's bundled CLI also uses Electron. Its child must remain in Node
    // mode even though provider credentials and arbitrary Node options are stripped.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    const child=spawn(process.execPath,["--input-type=module","--eval",script,url],{env,stdio:"ignore",windowsHide:true,shell:false,...signal === undefined ? {} : {signal}});
    const timer=setTimeout(()=>{child.kill();reject(Error("DSH Web UI could not open"))},10000);timer.unref();
    child.once("error",()=>{clearTimeout(timer);reject(Error("DSH Web UI could not open"))});
    child.once("exit",code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error("DSH Web UI could not open"))});
  });
}
function record(value:unknown):Record<string,unknown>|undefined{return value&&typeof value==="object"?value as Record<string,unknown>:undefined}
