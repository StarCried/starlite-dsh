import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
export const RUNTIMES=["core","vrm"];
export const RUNTIME_PACKAGES={core:"@starcried/starlite-core",vrm:"@starcried/starlite-vrm"};
const REQUIRED={core:["index.js","index.d.ts","dialogue.js","dialogue.d.ts","bubble.js","bubble.d.ts"],vrm:["index.js","widget.css"]};
export async function assertRuntimeLayout(directory){
 const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink())throw new Error("runtime staging directory must be an ordinary directory");
 const entries=await readdir(directory,{withFileTypes:true});
 for(const entry of entries)if(!entry.isDirectory()||entry.isSymbolicLink()||!RUNTIMES.includes(entry.name))throw new Error(`unsupported staged runtime: ${entry.name}`);
}
export async function assertRuntime(name,directory,provenance=true){
 if(!RUNTIMES.includes(name))throw new Error(`unsupported runtime: ${name}`);
 for(const file of REQUIRED[name])if(!(await stat(resolve(directory,file)).catch(()=>undefined))?.isFile())throw new Error(`Missing ${name} runtime (${file}). Run pnpm sync:runtime first.`);
 if(!provenance)return;
 const metadata=JSON.parse(await readFile(resolve(directory,"runtime-provenance.json"),"utf8"));
 if(metadata.schemaVersion!==2||metadata.package!==RUNTIME_PACKAGES[name]||!metadata.files||!Object.keys(metadata.files).length)throw new Error(`invalid ${name} provenance`);
 for(const file of REQUIRED[name])if(!metadata.files[file])throw new Error(`unhashed ${name} artifact`);
 for(const [file,expected]of Object.entries(metadata.files)){
  const path=resolve(directory,file),part=relative(directory,path);
  if(isAbsolute(part)||part.startsWith("..")||isAbsolute(file)||file.includes("\\")||!/^([a-f0-9]{64})$/u.test(expected))throw new Error("invalid provenance path or hash");
  const actual=createHash("sha256").update(await readFile(path)).digest("hex");if(actual!==expected)throw new Error(`${name} artifact hash mismatch: ${file}`);
 }
}
