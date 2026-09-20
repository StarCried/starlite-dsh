import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIMES, assertRuntime } from "./model-runtime.mjs";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
for(const name of RUNTIMES)await assertRuntime(name,resolve(root,"apps/desktop/public/runtime",name));
