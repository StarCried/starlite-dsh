import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIMES, assertRuntime } from "./model-runtime.mjs";
const execFile=promisify(execFileCallback);
const workspaceRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const argument=process.argv[2]??process.env.INOCHI2D_WEB_DIST;
if(!argument)throw new Error("runtime source is required: pnpm sync:runtime -- <inochi2d-web dist directory>");
const inochiDist=resolve(argument);
const sourceRoot=await git(inochiDist,["rev-parse","--show-toplevel"]);
const revision=await git(sourceRoot,["rev-parse","HEAD"]);
const dirty=Boolean(await git(sourceRoot,["status","--porcelain"]));
const repository=await git(sourceRoot,["remote","get-url","origin"]);
const sources=new Map(RUNTIMES.map(name=>[name,name==="inochi2d-web"?inochiDist:resolve(sourceRoot,"packages",name,"dist")]));
// Validate all components before replacing generated local runtime artifacts.
for(const [name,source]of sources)await assertRuntime(name,source,false);
for(const [name,source]of sources){
 const output=resolve(workspaceRoot,"apps/desktop/public/runtime",name),part=relative(workspaceRoot,output);
 if(isAbsolute(part)||part.startsWith(".."))throw new Error("runtime destination leaves workspace");
 const packageRoot=dirname(source),pkg=JSON.parse(await readFile(resolve(packageRoot,"package.json"),"utf8"));
 const notices=name==="model-widget-core"?["LICENSE"]:["LICENSE","THIRD_PARTY_NOTICES.md","THIRD_PARTY_LICENSES.txt"];
 for(const notice of notices)if(!(await stat(resolve(packageRoot,notice))).isFile())throw new Error("missing runtime license");
 await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
 const files={};
 async function copy(sourceDirectory,destinationDirectory){
  for(const entry of await readdir(sourceDirectory,{withFileTypes:true})){
   const input=resolve(sourceDirectory,entry.name),destination=resolve(destinationDirectory,entry.name);
   if(entry.isSymbolicLink())throw new Error("runtime artifact must not be a symlink");
   if(entry.isDirectory()){await mkdir(destination,{recursive:true});await copy(input,destination);continue;}
   const allowed=name==="vrm-web"?["index.js","widget.css"].includes(entry.name):/\.(css|js|wasm)$|\.d\.ts$/u.test(entry.name);
   if(entry.isFile()&&allowed){await copyFile(input,destination);files[relative(output,destination).replaceAll("\\","/")]=createHash("sha256").update(await readFile(destination)).digest("hex");}
  }
 }
 await copy(source,output);
 for(const notice of notices){await copyFile(resolve(packageRoot,notice),resolve(output,notice));files[notice]=createHash("sha256").update(await readFile(resolve(output,notice))).digest("hex");}
 const dependencies={}, dependencyLicenses={};
 async function collectDependencies(manifest,base){
  for(const dependency of Object.keys(manifest.dependencies??{})){
   if(RUNTIMES.includes(dependency)||dependencies[dependency])continue;
   let current=base, data;
   for(;;){
    const path=resolve(current,"node_modules",dependency,"package.json");
    try{data=JSON.parse(await readFile(path,"utf8"));break}catch(error){if(error.code!=="ENOENT")throw error}
    const parent=dirname(current);if(parent===current)throw new Error(`missing production dependency ${dependency}`);current=parent;
   }
   dependencies[dependency]=data.version;dependencyLicenses[dependency]=data.license??"NOASSERTION";
   await collectDependencies(data,resolve(current,"node_modules",dependency));
  }
 }
 await collectDependencies(pkg,packageRoot);
 const provenance={schemaVersion:2,package:name,version:pkg.version,repository,revision,dirty,files,dependencies,dependencyLicenses};
 if(name==="inochi2d-web"){
  const pin=JSON.parse(await readFile(resolve(sourceRoot,"tools/official-sdk/pin.json"),"utf8"));
  const selections=JSON.parse(await readFile(resolve(sourceRoot,"tools/official-sdk/dub.selections.json"),"utf8"));
  const wasmSha256=files["generated/inochi2d.wasm"];
  if(wasmSha256!==pin.optimizedWasmSha256)throw new Error("runtime WASM does not match pinned SDK");
  provenance.officialSdk={repository:"https://github.com/Inochi2D/inochi2d",revision:pin.sdkCommit,wasmSha256,packages:selections.versions};
 }
 await writeFile(resolve(output,"runtime-provenance.json"),JSON.stringify(provenance,null,2)+"\n");
 await assertRuntime(name,output,true);console.log(`Staged ${name} from ${revision}`);
}
async function git(directory,args){const {stdout}=await execFile("git",["-c","safe.directory=*","-C",directory,...args],{encoding:"utf8",windowsHide:true});return stdout.trim()}
