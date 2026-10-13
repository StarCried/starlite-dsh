import {build} from "esbuild";
import {writeFile} from "node:fs/promises";
await build({entryPoints:["src/index.ts"],bundle:true,platform:"node",target:"node22",format:"esm",outfile:"dist/index.js",sourcemap:true,external:["open"]});
const client=await build({entryPoints:["src/client.ts"],bundle:true,platform:"browser",target:"es2022",format:"cjs",write:false});
await writeFile("dist/client.js",`window.__ModuleLoader__.load({id:"dsh-starlite",factory:(require)=>{var module={exports:{}},exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
