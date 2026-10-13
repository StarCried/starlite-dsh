import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIMES, RUNTIME_PACKAGES, assertRuntime, assertRuntimeLayout } from "./model-runtime.mjs";
const execFile=promisify(execFileCallback);
const workspaceRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const arguments_=process.argv.slice(2).filter(value=>value!=="--");
if(arguments_.length>1)throw new Error("pass one StarLite checkout directory");
const argument=arguments_[0]??process.env.STARLITE_SOURCE;
if(!argument)throw new Error("runtime source is required: pnpm sync:runtime -- <StarLite checkout directory>");
const sourceRoot=await git(resolve(argument),["rev-parse","--show-toplevel"]);
const revision=await git(sourceRoot,["rev-parse","HEAD"]);
const dirty=Boolean(await git(sourceRoot,["status","--porcelain"]));
const repository=await git(sourceRoot,["remote","get-url","origin"]);
const sources=new Map(RUNTIMES.map(name=>[name,resolve(sourceRoot,"packages",name,"dist")]));
// Validate all components before replacing generated local runtime artifacts.
for(const [name,source]of sources)await assertRuntime(name,source,false);
const stagingRoot=resolve(workspaceRoot,"apps/desktop/public/runtime");
const managedNames=[...RUNTIMES,"inochi2d","inochi2d-web","model-widget-core","vrm-web"];
// This directory contains generated runtime artifacts only. Check every target
// and its parents before removing obsolete outputs; never follow a link.
for(const name of managedNames){
 const target=resolve(stagingRoot,name),part=relative(stagingRoot,target);
 if(isAbsolute(part)||part.startsWith("..")||part!==name)throw new Error("runtime destination leaves staging directory");
 let current=workspaceRoot;
 for(const segment of relative(workspaceRoot,target).split(/[\\/]/u)){
  current=resolve(current,segment);
  const info=await lstat(current).catch(error=>{if(error.code!=="ENOENT")throw error;return undefined});
  if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw new Error("runtime destination must contain only ordinary directories");
 }
}
for(const name of managedNames)await rm(resolve(stagingRoot,name),{recursive:true,force:true});
for(const [name,source]of sources){
 const output=resolve(workspaceRoot,"apps/desktop/public/runtime",name),part=relative(workspaceRoot,output);
 if(isAbsolute(part)||part.startsWith(".."))throw new Error("runtime destination leaves workspace");
 const packageRoot=dirname(source),pkg=JSON.parse(await readFile(resolve(packageRoot,"package.json"),"utf8"));
 if(pkg.name!==RUNTIME_PACKAGES[name])throw new Error(`unexpected runtime package: ${pkg.name}`);
 const notices=name==="core"?["LICENSE"]:["LICENSE","THIRD_PARTY_NOTICES.md","THIRD_PARTY_LICENSES.txt"];
 for(const notice of notices)if(!(await stat(resolve(packageRoot,notice))).isFile())throw new Error("missing runtime license");
 await mkdir(output,{recursive:true});
 const files={};
 async function copy(sourceDirectory,destinationDirectory){
  for(const entry of await readdir(sourceDirectory,{withFileTypes:true})){
   const input=resolve(sourceDirectory,entry.name),destination=resolve(destinationDirectory,entry.name);
   if(entry.isSymbolicLink())throw new Error("runtime artifact must not be a symlink");
   if(entry.isDirectory()){await mkdir(destination,{recursive:true});await copy(input,destination);continue;}
   const allowed=name==="vrm"?["index.js","widget.css"].includes(entry.name):/\.(css|js)$|\.d\.ts$/u.test(entry.name);
   if(entry.isFile()&&allowed){await copyFile(input,destination);files[relative(output,destination).replaceAll("\\","/")]=createHash("sha256").update(await readFile(destination)).digest("hex");}
  }
 }
 await copy(source,output);
 for(const notice of notices){await copyFile(resolve(packageRoot,notice),resolve(output,notice));files[notice]=createHash("sha256").update(await readFile(resolve(output,notice))).digest("hex");}
 const dependencies={}, dependencyLicenses={};
 async function collectDependencies(manifest,base){
  for(const dependency of Object.keys(manifest.dependencies??{})){
   if(Object.values(RUNTIME_PACKAGES).includes(dependency)||dependencies[dependency])continue;
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
 const provenance={schemaVersion:2,package:pkg.name,version:pkg.version,repository,revision,dirty,files,dependencies,dependencyLicenses};
 await writeFile(resolve(output,"runtime-provenance.json"),JSON.stringify(provenance,null,2)+"\n");
 await assertRuntime(name,output,true);console.log(`Staged ${name} from ${revision}`);
}
await assertRuntimeLayout(stagingRoot);
async function git(directory,args){const {stdout}=await execFile("git",["-c","safe.directory=*","-C",directory,...args],{encoding:"utf8",windowsHide:true});return stdout.trim()}
