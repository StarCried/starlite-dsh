// Post-publication only: install the canonical public version in a fresh isolated DSH profile.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {runQuiet,smokeEnvironment,smokeHost} from './smoke-dsh-plugin.mjs';
const manifestPath=resolve(process.argv[2]),output=dirname(manifestPath),root=resolve(import.meta.dirname,'..');
const release=JSON.parse(await readFile(manifestPath,'utf8')),version=release.version;
const runtime=await realpath(process.argv[3]);
const metadata=JSON.parse(await readFile(join(runtime,'package.json'),'utf8'));
assert.equal(metadata.name,'@deepseek-ai/dsh');
const [major,minor]=process.versions.node.split('.').map(Number);assert.ok(major>24||major===24&&minor>=9,'official DSH requires Node >=24.9');
assert.ok(['windows','wsl'].includes(smokeHost()));
const cli=await realpath(join(runtime,metadata.bin.dsh));assert.ok(cli.startsWith(`${runtime}${sep}`));
const canonical=join(root,'tools/smoke-dsh-plugin.mjs');
const archive=await readFile(join(output,`dsh-starlite-${version}.tgz`));
const integrity=`sha512-${createHash('sha512').update(archive).digest('base64')}`;
const request=async path=>{
  const response=await fetch(`https://registry.npmjs.org/${path}`,{redirect:'error',credentials:'omit',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200,'canonical registry version not ready');return response.json();
};
const publicPackage=await request(`dsh-starlite/${version}`),tags=await request(`dsh-starlite/${release.channel}`);
assert.equal(publicPackage.name,'dsh-starlite');assert.equal(publicPackage.version,version);assert.equal(tags.version,version);assert.equal(publicPackage.dist.integrity,integrity,'public archive differs from candidate');
const temporary=await mkdtemp(join(tmpdir(),'starlite-registry-smoke-'));
try{
  const env=smokeEnvironment(process.env,temporary);
  Object.assign(env,{npm_config_globalconfig:join(temporary,'empty-global.npmrc'),npm_config_registry:'https://registry.npmjs.org',npm_config_update_notifier:'false'});
  await Promise.all([env.HOME,env.APPDATA,env.LOCALAPPDATA,env.TEMP].map(path=>mkdir(path,{recursive:true})));
  await Promise.all([env.npm_config_userconfig,env.npm_config_globalconfig].map(path=>writeFile(path,'')));
  await runQuiet(process.execPath,[canonical,'--initialize',runtime],{cwd:temporary,env},'initialize-registry-profile');
  await runQuiet(process.execPath,[cli,'plugin','--profile','starlite-ci-smoke','add',`dsh-starlite@${version}`],{cwd:temporary,env},'install-registry-plugin');
  const profile=join(env.DSH_HOME,'profiles','starlite-ci-smoke');
  const installed=JSON.parse(await readFile(join(profile,'node_modules/dsh-starlite/package.json'),'utf8'));
  assert.equal(installed.name,'dsh-starlite');assert.equal(installed.version,version);
  const lock=await readFile(join(profile,'pnpm-lock.yaml'),'utf8');assert.ok(lock.includes(integrity));assert.ok(lock.includes(`dsh-starlite@${version}`));
  const manifest=JSON.parse(await readFile(join(profile,'node_modules/dsh-starlite/assets/windows-x64/manifest.json'),'utf8'));
  assert.equal(manifest.version,version);assert.equal(manifest.schemaVersion,3);assert.ok(manifest.defaultModels.every(model=>!model.localTest));
  const result=await runQuiet(process.execPath,[canonical,'--worker',runtime,profile],{cwd:temporary,env},'registry-boot-lifecycle',true);
  const {packedInstall,...behavior}=result;assert.equal(packedInstall,true);
  const proof={checkedAt:new Date().toISOString(),dshVersion:metadata.version,nodeVersion:process.version,registrySpec:`dsh-starlite@${version}`,anonymous:true,freshProfile:true,freshCache:true,registryInstall:true,integrity,modelIds:manifest.defaultModels.map(model=>model.id),...behavior};
  await writeFile(join(output,`dsh-registry-${process.platform==='win32'?'windows':'wsl'}.json`),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}finally{
  const actual=await realpath(temporary);assert.equal(dirname(actual),await realpath(tmpdir()));assert.ok(basename(actual).startsWith('starlite-registry-smoke-'));
  await rm(actual,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
