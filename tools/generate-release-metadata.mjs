import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIMES, assertRuntime } from "./model-runtime.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inputs = process.argv.slice(2).filter((argument) => argument !== "--");
if (inputs.length === 0) {
  throw new Error("pass the npm tarball and NSIS installer paths");
}
const artifacts = inputs.map((path) => resolve(root, path));
for (const artifact of artifacts) {
  if (!(await stat(artifact).catch(() => undefined))?.isFile()) {
    throw new Error(`release artifact is missing: ${artifact}`);
  }
}

const output = resolve(root, "release-output");
await mkdir(output, { recursive: true });
const hashes = [];
for (const artifact of artifacts) {
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  hashes.push(`${digest}  ${basename(artifact)}`);
}
await writeFile(resolve(output, "SHA256SUMS"), `${hashes.sort().join("\n")}\n`, "utf8");

const nodeLicenses = JSON.parse(runPnpm(["licenses", "list", "--json", "--prod"]));
const cargoMetadata = JSON.parse(run("cargo", [
  "metadata",
  "--locked",
  "--format-version",
  "1",
  "--manifest-path",
  "apps/desktop/src-tauri/Cargo.toml",
]));
const components = collectComponents(nodeLicenses, cargoMetadata.packages);
const runtimeProvenance = JSON.parse(await readFile(
  resolve(root, "apps/desktop/public/runtime/inochi2d-web/runtime-provenance.json"),
  "utf8",
));
components.push(...runtimeComponents(runtimeProvenance));
for (const name of RUNTIMES) {
  const directory = resolve(root, "apps/desktop/public/runtime", name);
  await assertRuntime(name, directory);
  if (name === "inochi2d-web") continue;
  const metadata = JSON.parse(await readFile(resolve(directory, "runtime-provenance.json"), "utf8"));
  components.push({ type: "library", name, version: metadata.version, licenses: licenseEntry("BSD-2-Clause"), properties: [{name: "git:revision", value: metadata.revision}] });
  for (const [dependency, version] of Object.entries(metadata.dependencies)) {
    if (RUNTIMES.includes(dependency)) continue;
    components.push({ type: "library", name: dependency, version, purl: `pkg:npm/${npmPurlName(dependency)}@${encodeURIComponent(version)}`, licenses: licenseEntry(metadata.dependencyLicenses?.[dependency]) });
  }
}
components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const workspacePackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: "DSH Companion",
      version: workspacePackage.version,
      licenses: [{ license: { id: "BSD-2-Clause" } }],
    },
  },
  components,
};
await writeFile(resolve(output, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const licenses = await collectLicenseTexts(nodeLicenses, cargoMetadata.packages);
const runtimeLicenses = (await Promise.all(RUNTIMES.map(async name => {
  const directory = resolve(root, "apps/desktop/public/runtime", name);
  return `${name} embedded runtime\n${await readFile(resolve(directory, "LICENSE"), "utf8")}\n${name === "model-widget-core" ? "" : await readFile(resolve(directory, "THIRD_PARTY_LICENSES.txt"), "utf8")}`;
}))).join("\n");
await writeFile(
  resolve(output, "THIRD_PARTY_LICENSES.txt"),
  `${licenses}\n${"=".repeat(78)}\ninochi2d-web embedded runtime\n${"=".repeat(78)}\n${runtimeLicenses.trim()}\n`,
  "utf8",
);
console.log(`Generated checksums, CycloneDX SBOM, and license texts in ${output}`);

function collectComponents(nodeGroups, cargoPackages) {
  const result = new Map();
  for (const packages of Object.values(nodeGroups)) {
    for (const package_ of packages) {
      for (const version of package_.versions) {
        const key = `npm:${package_.name}@${version}`;
        result.set(key, {
          type: "library",
          name: package_.name,
          version,
          purl: `pkg:npm/${npmPurlName(package_.name)}@${encodeURIComponent(version)}`,
          licenses: licenseEntry(package_.license),
          ...(package_.homepage ? { externalReferences: [{ type: "website", url: package_.homepage }] } : {}),
        });
      }
    }
  }
  for (const package_ of cargoPackages) {
    if (package_.name === "dsh-inochi2d-pet") continue;
    const key = `cargo:${package_.name}@${package_.version}`;
    result.set(key, {
      type: "library",
      name: package_.name,
      version: package_.version,
      purl: `pkg:cargo/${encodeURIComponent(package_.name)}@${encodeURIComponent(package_.version)}`,
      licenses: licenseEntry(package_.license),
      ...(package_.homepage ? { externalReferences: [{ type: "website", url: package_.homepage }] } : {}),
    });
  }
  return [...result.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function runtimeComponents(provenance) {
  const sdk = provenance.officialSdk;
  if (
    provenance.package !== "inochi2d-web"
    || typeof provenance.version !== "string"
    || typeof provenance.revision !== "string"
    || !sdk
    || typeof sdk.revision !== "string"
    || typeof sdk.packages !== "object"
    || sdk.packages === null
    || Array.isArray(sdk.packages)
  ) {
    throw new Error("inochi2d-web runtime provenance is incomplete");
  }
  const components = [{
    type: "library",
    name: "inochi2d-web",
    version: provenance.version,
    licenses: [{ license: { id: "BSD-2-Clause" } }],
    externalReferences: [{
      type: "vcs",
      url: `${provenance.repository ?? "https://github.com/StarCried/inochi2d-web"}#${provenance.revision}`,
    }],
    properties: [{ name: "git:revision", value: provenance.revision }],
  }, {
    type: "library",
    name: "inochi2d",
    version: sdk.revision,
    purl: `pkg:github/Inochi2D/inochi2d@${sdk.revision}`,
    licenses: [{ license: { id: "BSD-2-Clause" } }],
    hashes: [{ alg: "SHA-256", content: sdk.wasmSha256 }],
  }];
  for (const [name, version] of Object.entries(sdk.packages)) {
    components.push({
      type: "library",
      name,
      version: String(version),
      purl: `pkg:dub/${encodeURIComponent(name)}@${encodeURIComponent(String(version))}`,
      licenses: [{ license: { name: "See bundled inochi2d-web license texts" } }],
    });
  }
  return components;
}

async function collectLicenseTexts(nodeGroups, cargoPackages) {
  const packages = [];
  for (const group of Object.values(nodeGroups)) {
    for (const package_ of group) {
      for (const path of package_.paths ?? []) {
        packages.push({ label: `${package_.name}@${package_.versions.join(",")}`, path });
      }
    }
  }
  for (const package_ of cargoPackages) {
    if (package_.name === "dsh-inochi2d-pet") continue;
    packages.push({ label: `${package_.name}@${package_.version}`, path: dirname(package_.manifest_path) });
  }
  const seen = new Set();
  const sections = [
    "THIRD-PARTY LICENSE TEXTS",
    "Generated from the locked production dependency trees.\n",
  ];
  for (const package_ of packages.sort((left, right) => left.label.localeCompare(right.label))) {
    const names = await readdir(package_.path).catch(() => []);
    for (const name of names.filter((value) => /^(licen[cs]e|copying|notice)(\.|-|$)/iu.test(value)).sort()) {
      const path = resolve(package_.path, name);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || info.size > 1_000_000) continue;
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (!text) continue;
      const key = createHash("sha256").update(text).digest("hex");
      if (seen.has(`${package_.label}:${key}`)) continue;
      seen.add(`${package_.label}:${key}`);
      sections.push(`${"=".repeat(78)}\n${package_.label} — ${name}\n${"=".repeat(78)}\n${text.trim()}\n`);
    }
  }
  return `${sections.join("\n")}\n`;
}

function licenseEntry(expression) {
  return typeof expression === "string" && expression.trim()
    ? [{ expression: expression.trim() }]
    : [{ license: { name: "NOASSERTION" } }];
}

function npmPurlName(name) {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const slash = name.indexOf("/");
  return `${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
}

function run(command, arguments_) {
  return execFileSync(command, arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function runPnpm(arguments_) {
  if (process.platform !== "win32") return run("pnpm", arguments_);
  // Node cannot spawn a .cmd shim directly on Windows. Every argument here is
  // a fixed internal token, never release metadata or user input.
  return run("cmd.exe", ["/d", "/s", "/c", `pnpm ${arguments_.join(" ")}`]);
}
