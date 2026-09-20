import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
export const RUNTIMES=["model-widget-core","inochi2d-web","vrm-web"];
const REQUIRED={"model-widget-core":["index.js","index.d.ts","dialogue.js","dialogue.d.ts","bubble.js","bubble.d.ts"],"inochi2d-web":["index.js","widget.css","generated/inochi2d.wasm"],"vrm-web":["index.js","widget.css"]};
export async function assertRuntime(name,directory,provenance=true){
 for(const file of REQUIRED[name])if(!(await stat(resolve(directory,file)).catch(()=>undefined))?.isFile())throw new Error(`Missing ${name} runtime (${file}). Run pnpm sync:runtime first.`);
 if(!provenance)return;
 const metadata=JSON.parse(await readFile(resolve(directory,"runtime-provenance.json"),"utf8"));
 if(metadata.schemaVersion!==2||metadata.package!==name||!metadata.files||!Object.keys(metadata.files).length)throw new Error(`invalid ${name} provenance`);
 for(const file of REQUIRED[name])if(!metadata.files[file])throw new Error(`unhashed ${name} artifact`);
 for(const [file,expected]of Object.entries(metadata.files)){
  const path=resolve(directory,file),part=relative(directory,path);
  if(isAbsolute(part)||part.startsWith("..")||isAbsolute(file)||file.includes("\\")||!/^([a-f0-9]{64})$/u.test(expected))throw new Error("invalid provenance path or hash");
  const actual=createHash("sha256").update(await readFile(path)).digest("hex");if(actual!==expected)throw new Error(`${name} artifact hash mismatch: ${file}`);
 }
}
