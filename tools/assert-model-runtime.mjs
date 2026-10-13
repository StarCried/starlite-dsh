import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIMES, assertRuntime, assertRuntimeLayout } from "./model-runtime.mjs";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
await assertRuntimeLayout(resolve(root,"apps/desktop/public/runtime"));
for(const name of RUNTIMES)await assertRuntime(name,resolve(root,"apps/desktop/public/runtime",name));
