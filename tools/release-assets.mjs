import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

// Program installers are BYOM. Separately licensed character packs never enter
// the frontend or native resources, including ignored local build inputs.
export async function checkProgramAssets(root) {
  const failures = [];
  async function visit(relativePath) {
    let entries;
    try { entries = await readdir(resolve(root, relativePath), {withFileTypes: true}); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = `${relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) failures.push(`program resource must not be a symlink: ${path}`);
      else if (/inochi2d/iu.test(entry.name) || /\.wasm$/iu.test(entry.name)) failures.push(`disabled Inochi2D runtime in program resources: ${path}`);
      else if (entry.isDirectory()) await visit(path);
      else if (/\.(inp|inx|vrm|vrma|blend)$/iu.test(entry.name)) failures.push(`separately licensed character asset in program resources: ${path}`);
    }
  }
  for (const path of ["apps/desktop/public", "apps/desktop/dist", "apps/desktop/src-tauri/resources"]) await visit(path);
  return failures;
}
