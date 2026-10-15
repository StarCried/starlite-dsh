import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, expect, it} from "vitest";
import {smokeDshPlugin,smokeEnvironment,smokeHost,processDiagnostic,runQuiet} from "../smoke-dsh-plugin.mjs";
import {contractExecutable,stageContractFixture} from "../stage-dsh-contract-fixture.mjs";
import {assertDesktopExecutable} from "../plugin-desktop-assets.mjs";

const directories=[];
afterEach(async()=>{
  for(const directory of directories.splice(0)){
    const actual=await realpath(directory);
    if(dirname(actual)!==await realpath(tmpdir())||!basename(actual).startsWith("starlite-smoke-test-"))throw Error("unsafe fixture cleanup");
    await rm(actual,{recursive:true,force:true});
  }
});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),"starlite-smoke-test-"));directories.push(directory);return directory;
}

it.each([
  ["win32","x64","10.0.26200","windows"],
  ["linux","x64","6.6.87.2-microsoft-standard-WSL2","wsl"],
  ["win32","arm64","10.0.26200","unsupported"],
  ["linux","arm64","6.6.87.2-microsoft-standard-WSL2","unsupported"],
  ["linux","x64","6.8.0-generic","unsupported"],
  ["darwin","x64","25.0.0","unsupported"],
])("matches the supported Host policy for %s %s",(platform,architecture,kernel,expected)=>{
  expect(smokeHost(platform,architecture,kernel)).toBe(expected);
});

it.each([
  ["npm ERR! code EAI_AGAIN","network-dns"],
  ["npm ERR! code E401","registry-authentication"],
  ["npm ERR! code E404","registry-package-not-found"],
  ["CERT_HAS_EXPIRED","tls-certificate"],
  ["ECONNREFUSED","network-connection"],
  ["ENOSPC","disk-space"],
  ["EPERM","filesystem-permission"],
  ["ERR_MODULE_NOT_FOUND","missing-runtime-dependency"],
  ["npm WARN EBADENGINE","unsupported-node-version"],
  ["SyntaxError","runtime-module-incompatible"],
])("classifies %s without revealing child output",(code,category)=>{
  const result=processDiagnostic(`${code} https://user:PRIVATE@example.invalid/?token=PRIVATE C:\\PRIVATE\\session`);
  expect(result).toContain(category);expect(result).not.toContain("PRIVATE");expect(result).not.toContain("example.invalid");
});

it("reports actual spawn, child-exit and IPC-result failures without raw child logs",async()=>{
  const directory=await fixture();
  await expect(runQuiet(join(directory,"absent.exe"),[],{cwd:directory},"initialize-profile")).rejects.toThrow("executable-or-working-directory-not-found");
  await expect(runQuiet(process.execPath,["-e","console.error('npm ERR! code EAI_AGAIN PRIVATE');process.exit(7)"],{cwd:directory},"install-packed-plugin")).rejects.toThrow("install-packed-plugin: network-dns: check DNS and npm registry connectivity (exit 7)");
  await expect(runQuiet(process.execPath,["-e","process.exit(2)"],{cwd:directory},"initialize-profile")).rejects.toThrow("nonzero-exit (exit 2)");
  await expect(runQuiet(process.execPath,["-e","process.exit(0)"],{cwd:directory},"boot-lifecycle",true)).rejects.toThrow("missing-worker-result (exit 0)");
  await expect(runQuiet(process.execPath,["-e","process.send({kind:'failure',step:'https://PRIVATE.invalid/?token=PRIVATE'});process.exit(1)"],{cwd:directory},"boot-lifecycle",true)).rejects.toThrow("unknown-worker-failure (exit 1)");
});

it("reports the later fatal error instead of an earlier engine warning",async()=>{
  const directory=await fixture();
  const script="console.error('npm WARN EBADENGINE PRIVATE');setTimeout(()=>{console.error('npm ERR! code ENOSPC PRIVATE');process.exit(9)},100)";
  await expect(runQuiet(process.execPath,["-e",script],{cwd:directory},"install-packed-plugin"))
    .rejects.toThrow("install-packed-plugin: disk-space: free space in the temporary/cache directory (exit 9)");
  expect(processDiagnostic("npm WARN EBADENGINE\nnpm ERR! code E401\nnpm ERR! code ENOSPC PRIVATE")).toBe("disk-space: free space in the temporary/cache directory");
});

it("classifies an actual worker import failure without exposing its private path",async()=>{
  const directory=await fixture();
  const script=fileURLToPath(new URL("../smoke-dsh-plugin.mjs",import.meta.url));
  await expect(runQuiet(process.execPath,[script,"--worker",join(directory,"PRIVATE-runtime"),join(directory,"PRIVATE-profile")],{cwd:directory},"boot-lifecycle",true))
    .rejects.toThrow("boot-lifecycle: missing-runtime-dependency: reinstall the official DSH runtime and verify its dependencies (exit 1)");
  await expect(runQuiet(process.execPath,["-e","process.send({kind:'failure',category:'missing-runtime-dependency',hint:'PRIVATE URL/token/path'});process.exit(3)"],{cwd:directory},"boot-lifecycle",true))
    .rejects.toThrow("boot-lifecycle: missing-runtime-dependency: reinstall the official DSH runtime and verify its dependencies (exit 3)");
  await expect(runQuiet(process.execPath,["-e","process.send({kind:'failure',category:'PRIVATE URL/token/path'});process.exit(4)"],{cwd:directory},"boot-lifecycle",true))
    .rejects.toThrow("unknown-worker-failure (exit 4)");
});

it("identifies missing input paths and invalid runtime metadata before installing",async()=>{
  const directory=await fixture();
  await expect(smokeDshPlugin(join(directory,"PRIVATE-runtime"),join(directory,"PRIVATE-package.tgz")))
    .rejects.toThrow("runtime-directory: not-found; check the supplied path");
  await expect(smokeDshPlugin(directory,join(directory,"PRIVATE-package.tgz")))
    .rejects.toThrow("plugin-archive: not-found; check the supplied path");
  const archive=join(directory,"package.tgz");
  await writeFile(archive,"fixture");
  await writeFile(join(directory,"package.json"),"PRIVATE invalid metadata");
  await expect(smokeDshPlugin(directory,archive))
    .rejects.toThrow("runtime-metadata-invalid: provide an installed official DSH package directory containing package.json");
});

it("isolates Harness, user and npm state while excluding inherited credentials and launch hooks",async()=>{
  const directory=await fixture();
  const result=smokeEnvironment({PATH:"safe",SystemRoot:"C:\\Windows",HOME:"real-user",USERPROFILE:"real-user",DSH_HOME:"real-harness",DEEPSEEK_API_KEY:"PRIVATE",NPM_TOKEN:"PRIVATE",HTTP_PROXY:"PRIVATE",NODE_OPTIONS:"--import unsafe",ELECTRON_RUN_AS_NODE:"1",WSLENV:"DEEPSEEK_API_KEY/u",DSH_INOCHI2D_PET_EXE:"real-program.exe"},directory,"win32");
  expect(result.DSH_HOME).toBe(join(directory,"harness"));expect(result.HOME).toBe(join(directory,"user"));
  expect(result.USERPROFILE).toBe(result.HOME);expect(result.APPDATA).toBe(join(directory,"user","Roaming"));
  expect(result.LOCALAPPDATA).toBe(join(directory,"user","Local"));
  expect(result.TEMP).toBe(join(directory,"tmp"));expect(result.TMP).toBe(result.TEMP);
  expect(result.DSH_INOCHI2D_PET_EXE).toBe(join(directory,"unavailable","dsh-inochi2d-pet.exe"));
  expect(result.npm_config_userconfig).toBe(join(directory,"empty-npmrc"));
  expect(result.PATH).toBe("safe");expect(result.DSH_TELEMETRY_DISABLED).toBe("1");
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  for(const key of ["NPM_TOKEN","DEEPSEEK_API_KEY","HTTP_PROXY","NODE_OPTIONS","ELECTRON_RUN_AS_NODE","WSLENV"])expect(result).not.toHaveProperty(key);
});

it("stages a generated, externally licensed-model-free CI package with a non-downloadable model fixture",async()=>{
  const directory=await fixture();
  await mkdir(join(directory,"packages/dsh-plugin"),{recursive:true});
  await mkdir(join(directory,"apps/desktop/src-tauri"),{recursive:true});
  await writeFile(join(directory,"packages/dsh-plugin/package.json"),JSON.stringify({version:"0.1.0-alpha.0"}));
  await writeFile(join(directory,"apps/desktop/src-tauri/tauri.conf.json"),JSON.stringify({version:"0.1.0-alpha.0",productName:"StarLite for DSH"}));
  await writeFile(join(directory,"LICENSE"),"Artwork-free fixture notice");
  const manifest=await stageContractFixture(directory);
  const executable=await readFile(join(directory,"packages/dsh-plugin/assets/windows-x64/dsh-inochi2d-pet.exe"));
  expect(executable).toEqual(contractExecutable());assertDesktopExecutable(executable,manifest.executable);
  expect(manifest.defaultModel).toMatchObject({url:"http://127.0.0.1:1/fixture.vrm",bytes:1,localTest:true});
  await expect(stageContractFixture(directory)).rejects.toThrow();
  expect(await readFile(join(directory,"apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe"))).toEqual(executable);
});
