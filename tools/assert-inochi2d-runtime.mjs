import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = resolve(
  workspaceRoot,
  "apps/desktop/public/runtime/inochi2d-web",
);

for (const relative of [
  "index.js",
  "widget.css",
  "generated/inochi2d.wasm",
]) {
  const file = resolve(runtimeRoot, relative);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(
      `Missing local Inochi2D runtime (${relative}). Run "pnpm sync:runtime" first.`,
    );
  }
}
