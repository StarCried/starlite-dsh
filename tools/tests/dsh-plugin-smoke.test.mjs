import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
import {afterEach, expect, it} from "vitest";
import {smokeEnvironment} from "../smoke-dsh-plugin.mjs";
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
