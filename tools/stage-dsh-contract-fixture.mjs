import {mkdir, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {stagePluginDesktop} from "./stage-plugin-desktop.mjs";

/** Header-only artwork-free bytes for package checks; never an executable test payload. */
export function contractExecutable() {
  const executable=Buffer.alloc(256),pe=64;
  executable.writeUInt16LE(0x5a4d);executable.writeUInt32LE(pe,0x3c);
  executable.writeUInt32LE(0x00004550,pe);executable.writeUInt16LE(0x8664,pe+4);
  executable.writeUInt16LE(112,pe+20);executable.writeUInt16LE(0x20b,pe+24);
  executable.writeUInt16LE(2,pe+24+68);
  return executable;
}

/** Only fresh CI checkouts may receive these generated inputs; existing builds are never overwritten. */
export async function stageContractFixture(root) {
  const descriptor=resolve(root,"release-output/ci-default-model.json");
  for(const [path,bytes] of [
    ["apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe",contractExecutable()],
    ["release-output/THIRD_PARTY_LICENSES.txt","Artwork-free contract-test fixture; not a public program build.\n"],
    ["release-output/ci-default-model.json",JSON.stringify({title:"CI artwork-free fixture",url:"http://127.0.0.1:1/fixture.vrm",sha256:"0".repeat(64),bytes:1,localTest:true})],
  ]) {
    const target=resolve(root,path);await mkdir(dirname(target),{recursive:true});
    await writeFile(target,bytes,{flag:"wx"});
  }
  return stagePluginDesktop(root,descriptor);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await stageContractFixture(resolve(dirname(fileURLToPath(import.meta.url)),".."));
  console.log("Staged artwork-free CI package inputs; not for publication or execution.");
}
