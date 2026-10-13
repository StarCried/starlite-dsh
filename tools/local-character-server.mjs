import { createServer } from "node:http";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStarterCharacter, MAX_DESKTOP_BYTES, sha256 } from "./plugin-desktop-assets.mjs";

/** Local acceptance only: keep the private ZIP in memory and expose no directory. */
export async function serveLocalCharacter({ archivePath, modelSha256, descriptorPath }) {
  const archiveInfo = await lstat(archivePath).catch(() => undefined);
  if (!archiveInfo?.isFile() || archiveInfo.isSymbolicLink() || extname(archivePath).toLowerCase() !== ".zip"
    || archiveInfo.size < 1 || archiveInfo.size > MAX_DESKTOP_BYTES || !/^[0-9a-f]{64}$/u.test(modelSha256)) {
    throw Error("local character requires an ordinary bounded ZIP and its desktop model SHA-256");
  }
  const bytes = await readFile(archivePath), digest = sha256(bytes);
  const resource = `/weiguang-${digest}.zip`;
  const server = createServer((request, response) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== expectedHost || request.headers.origin || request.url !== resource || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" }); response.end(); return;
    }
    response.writeHead(200, {
      "Content-Type": "application/zip", "Content-Length": String(bytes.length),
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
    const descriptor = assertStarterCharacter({
      title: "微光 v3.0", url: `http://127.0.0.1:${server.address().port}${resource}`,
      sha256: digest, bytes: bytes.length, modelSha256, localTest: true,
    });
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2).filter(argument => argument !== "--");
  if (arguments_.length !== 3) throw Error("usage: pnpm serve:character -- /path/Weiguang.zip <desktop-model-sha256> /path/release-output/local-character.json");
  const { server } = await serveLocalCharacter({ archivePath: resolve(arguments_[0]), modelSha256: arguments_[1], descriptorPath: resolve(arguments_[2]) });
  console.log(`LOCAL TEST ONLY: character source ready; descriptor ${resolve(arguments_[2])}. Keep this process running during first startup. No public upload occurred.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
}
