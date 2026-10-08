import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// Include source and locked build inputs, not only generated runtime metadata.
// Tests and documentation do not change the installed application.
export const INSTALLER_INPUTS = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "packages/protocol/package.json", "packages/protocol/tsconfig.json", "packages/protocol/src",
  "apps/desktop/package.json", "apps/desktop/tsconfig.json", "apps/desktop/vite.config.ts",
  "apps/desktop/index.html", "apps/desktop/src", "apps/desktop/public/runtime",
  "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/build.rs", "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/src", "apps/desktop/src-tauri/capabilities",
  "apps/desktop/src-tauri/resources",
  "apps/desktop/src-tauri/icons/32x32.png", "apps/desktop/src-tauri/icons/128x128.png",
  "apps/desktop/src-tauri/icons/128x128@2x.png", "apps/desktop/src-tauri/icons/icon.ico",
];

/** Timestamp freshness is a necessary check, not proof of reproducible contents. */
export async function checkReleaseInstaller(root, productName, version, inputs = INSTALLER_INPUTS) {
  const relativePath = `apps/desktop/src-tauri/target/release/bundle/nsis/${productName}_${version}_x64-setup.exe`;
  const installer = await lstat(resolve(root, relativePath)).catch(() => undefined);
  if (!installer?.isFile() || installer.size === 0) {
    return [`the current unsigned NSIS release installer is missing: ${relativePath}`];
  }
  const failures = [];
  async function inspect(relativePath) {
    const path = resolve(root, relativePath);
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      failures.push(`release build input is missing or unsafe: ${relativePath}`);
      return;
    }
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await inspect(`${relativePath}/${entry}`);
    } else if (info.mtimeMs > installer.mtimeMs) {
      failures.push(`the NSIS installer is older than release input: ${relativePath}`);
    }
  }
  for (const input of inputs) await inspect(input);
  return failures;
}
