import { createServer } from "node:http";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDefaultModel, assertDefaultModelCatalog, MAX_DESKTOP_BYTES, sha256 } from "./plugin-desktop-assets.mjs";

/** Local acceptance only: keep the private VRM in memory and expose no directory. */
export async function serveLocalCharacter({ modelPath, descriptorPath, bluefish }) {
  const base = bluefish ? assertDefaultModel(JSON.parse(await metadataFile(bluefish.weiguangDescriptorPath, 16 * 1024))) : undefined;
  const fishTerms = bluefish ? await metadataFile(bluefish.licensePath, 100 * 1024) : undefined;
  const weiguangTerms = bluefish ? await readFile(new URL("../docs/weiguang-license.md", import.meta.url), "utf8") : undefined;
  const modelInfo = await lstat(modelPath).catch(() => undefined);
  if (!modelInfo?.isFile() || modelInfo.isSymbolicLink() || extname(modelPath).toLowerCase() !== ".vrm"
    || modelInfo.size < 1 || modelInfo.size > MAX_DESKTOP_BYTES) {
    throw Error("local character requires an ordinary bounded .vrm model");
  }
  const bytes = await readFile(modelPath), digest = sha256(bytes);
  const resource = `/${bluefish ? "bluefish" : "weiguang"}-${digest}.vrm`;
  const server = createServer((request, response) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== expectedHost || request.headers.origin || request.url !== resource || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" }); response.end(); return;
    }
    response.writeHead(200, {
      "Content-Type": "model/gltf-binary", "Content-Length": String(bytes.length),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  server.requestTimeout = 30_000;
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); accept(); });
  });
  try {
    const source = assertDefaultModel({
      title: bluefish ? "蓝色大肥鱼" : "微光 v3.0", url: `http://127.0.0.1:${server.address().port}${resource}`,
      sha256: digest, bytes: bytes.length, localTest: true,
    });
    const descriptor = bluefish ? assertDefaultModelCatalog({schemaVersion:3,defaultModels:[
      {...base,id:"weiguang-default",license:{title:"微光 v3.0",text:weiguangTerms}},
      {...source,id:"bluefish-default",license:{title:"蓝色大肥鱼",text:fishTerms}},
    ]}) : source;
    await mkdir(dirname(descriptorPath), { recursive: true });
    const outputParent = await realpath(dirname(descriptorPath));
    if (outputParent !== resolve(dirname(descriptorPath))) throw Error("local descriptor directory must not be redirected");
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
    return { server, descriptor };
  } catch (error) {
    await new Promise(accept => server.close(accept));
    throw error;
  }
}

async function metadataFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw Error("model metadata must be an ordinary bounded file");
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > limit) throw Error("model metadata exceeds size limit");
  return text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2).filter(argument => argument !== "--");
  const bluefish = arguments_[0] === "--bluefish";
  if (arguments_.length !== (bluefish ? 5 : 2)) throw Error("usage: pnpm serve:character -- <Weiguang.vrm> <output.json> OR --bluefish <Bluefish.vrm> <license.md> <weiguang-source.json> <output-catalog.json>");
  const output = resolve(arguments_[bluefish ? 4 : 1]);
  const { server } = await serveLocalCharacter({ modelPath: resolve(arguments_[bluefish ? 1 : 0]), descriptorPath: output,
    ...(bluefish ? {bluefish:{licensePath:resolve(arguments_[2]),weiguangDescriptorPath:resolve(arguments_[3])}} : {}),
  });
  console.log(`LOCAL TEST ONLY: character source ready; descriptor ${output}. Keep this process running during first startup. No public upload occurred.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
}
