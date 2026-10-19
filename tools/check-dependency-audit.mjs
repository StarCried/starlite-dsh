import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const label = value => [...String(value)].filter(character => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127).join('').slice(0, 128);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export function checkPolicy(policy, today = new Date().toISOString().slice(0, 10)) {
  requireValue(policy?.schemaVersion === 1 && ['npm', 'pnpm'].includes(policy.packageManager), 'Invalid dependency audit policy');
  requireValue(record(policy.javascript?.advisories) && record(policy.javascript?.affectedPackages) && Array.isArray(policy.rust?.warnings), 'Invalid dependency audit exception lists');
  for (const exception of [...Object.values(policy.javascript.advisories), ...policy.rust.warnings]) {
    requireValue(/^\d{4}-\d{2}-\d{2}$/.test(exception.reviewBy) && exception.reviewBy >= today && typeof exception.reason === 'string' && exception.reason.length > 20, 'Dependency audit exception is expired or lacks a documented reason; review the policy');
  }
}

export function evaluateJavascript(report, policy, lock = {}) {
  requireValue(record(report) && !report.error && record(report.metadata?.vulnerabilities), 'JavaScript audit did not return a complete report');
  const counts = report.metadata.vulnerabilities;
  for (const key of ['info', 'low', 'moderate', 'high', 'critical']) requireValue(Number.isSafeInteger(counts[key]) && counts[key] >= 0, 'JavaScript audit severity counts are invalid');
  if (policy.packageManager === 'pnpm') {
    requireValue(record(report.advisories), 'pnpm audit advisory list is missing');
    requireValue(Object.keys(report.advisories).length === 0 && Object.values(counts).every(value => value === 0), 'New pnpm dependency advisory; inspect the audit artifact and fix or explicitly review it');
    return { affectedPackages: 0, acceptedAdvisories: [] };
  }
  requireValue(record(report.vulnerabilities) && record(lock.packages), 'npm audit or package-lock.json is incomplete');
  const findings = report.vulnerabilities, accepted = new Set();
  requireValue(counts.total === Object.keys(findings).length && ['info', 'low', 'moderate', 'high', 'critical'].reduce((total, key) => total + counts[key], 0) === counts.total, 'npm audit total does not match the returned findings');
  const advisoryIds = (name, active = new Set()) => {
    requireValue(!active.has(name) && record(findings[name]) && Array.isArray(findings[name].via) && findings[name].via.length > 0, 'npm advisory dependency graph is incomplete or cyclic');
    const next = new Set(active).add(name), ids = new Set();
    for (const via of findings[name].via) {
      if (typeof via === 'string') { for (const id of advisoryIds(via, next)) ids.add(id); continue; }
      requireValue(record(via), 'npm advisory entry is malformed');
      const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(via.url)?.[1];
      const exception = policy.javascript.advisories[id];
      requireValue(exception && exception.package === via.name && exception.range === via.range && exception.severity === via.severity, `New or changed npm advisory for ${label(name)}; inspect the audit artifact`);
      ids.add(id); accepted.add(id);
    }
    return ids;
  };
  for (const [name, finding] of Object.entries(findings)) {
    const exception = policy.javascript.affectedPackages[name];
    requireValue(exception && finding.name === name && finding.severity === exception.severity && Array.isArray(finding.nodes) && finding.nodes.length > 0, `New or changed affected npm package: ${label(name)}`);
    requireValue(same(finding.nodes, exception.nodes), `npm dependency path changed for ${label(name)}; review its exposure`);
    for (const node of finding.nodes) requireValue(lock.packages[node]?.version === exception.version, `npm dependency version changed for ${label(name)}; review its exception`);
    requireValue(same(advisoryIds(name), exception.advisories), `npm advisory scope changed for ${label(name)}`);
  }
  return { affectedPackages: Object.keys(findings).length, acceptedAdvisories: [...accepted].sort() };
}

export function evaluateRust(report, policy, activePackages = new Set()) {
  requireValue(record(report?.database) && /^[0-9a-f]{40}$/.test(report.database['last-commit'] ?? '') && record(report.lockfile) && Number.isSafeInteger(report.lockfile['dependency-count']), 'RustSec audit did not return a database and lockfile report');
  requireValue(record(report.vulnerabilities) && Array.isArray(report.vulnerabilities.list) && record(report.warnings), 'RustSec audit findings are incomplete');
  requireValue(report.vulnerabilities.found === false && report.vulnerabilities.count === 0 && report.vulnerabilities.list.length === 0, 'RustSec reported a vulnerability; inspect the audit artifact and resolve it');
  requireValue(Array.isArray(report.settings?.ignore) && report.settings.ignore.length === 0 && report.settings.target_arch?.length === 0 && report.settings.target_os?.length === 0 && report.settings.severity === null && Array.isArray(report.settings.informational_warnings) && same(report.settings.informational_warnings, ['unmaintained', 'unsound', 'notice']), 'RustSec audit must scan the full lockfile without ignores, severity thresholds, suppressed warnings or target filters');
  const accepted = [];
  for (const [kind, warnings] of Object.entries(report.warnings)) {
    requireValue(Array.isArray(warnings), 'RustSec warning list is malformed');
    for (const warning of warnings) {
      const exception = policy.rust.warnings.find(item => item.id === warning.advisory?.id && item.package === warning.package?.name && item.version === warning.package?.version && item.kind === kind);
      requireValue(exception && warning.kind === kind && warning.advisory.informational === kind, `New or changed RustSec warning: ${label(warning.advisory?.id)}`);
      if (exception.inactiveOnTarget) requireValue(policy.rust.target && !activePackages.has(`${exception.package}@${exception.version}`), `Previously inactive RustSec warning is now in the ${policy.rust.target} build: ${label(exception.package)}`);
      accepted.push({ id: exception.id, package: exception.package, version: exception.version, kind, inactiveOnTarget: Boolean(exception.inactiveOnTarget) });
    }
  }
  return { vulnerabilities: 0, acceptedWarnings: accepted, databaseCommit: report.database['last-commit'], dependencyCount: report.lockfile['dependency-count'] };
}

function scanner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
  // Never copy registry configuration, stderr or malformed response text to
  // logs/artifacts: these can contain local paths or authentication material.
  requireValue(!result.error && !result.signal && [0, 1].includes(result.status), 'Dependency scanner failed to execute or reach its service; no clean result is available');
  return result;
}
function jsonReport(result) {
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Dependency scanner returned invalid JSON; no clean result is available'); }
}
export function main(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const output = resolve(root, 'target/dependency-audit'); mkdirSync(output, { recursive: true });
  const summary = { checkedAt: new Date().toISOString(), passed: false };
  const save = (name, value) => writeFileSync(resolve(output, name), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const policy = JSON.parse(readFileSync(resolve(root, 'tools/dependency-audit-policy.json'), 'utf8'));
    checkPolicy(policy);
    const packageCli = process.env.npm_execpath;
    requireValue(packageCli && existsSync(packageCli), 'Run this check through npm run check:dependencies or pnpm check:dependencies');
    const jsResult = scanner(process.execPath, [packageCli, 'audit', '--json', ...(policy.packageManager === 'npm' ? ['--include=dev', '--include=optional', '--include=peer'] : [])], { cwd: root, env: { ...process.env, NODE_ENV: 'development', npm_config_omit: '', npm_config_production: 'false' } });
    const javascript = jsonReport(jsResult);
    requireValue(!javascript.error, 'JavaScript registry audit failed; no clean result is available');
    save('javascript.json', javascript);
    const lock = policy.packageManager === 'npm' ? JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) : {};
    summary.javascript = evaluateJavascript(javascript, policy, lock);
    requireValue(jsResult.status === 0 || summary.javascript.affectedPackages > 0, 'JavaScript audit failed without a matching advisory report');
    const rustResult = scanner(process.env.CARGO_AUDIT_BIN || 'cargo', ['audit', '--file', policy.cargoLockfile, '--json'], { cwd: root });
    const rust = jsonReport(rustResult); save('rust.json', rust);
    const activePackages = new Set();
    if (policy.rust.target) {
      const tree = scanner('cargo', ['tree', '--locked', '--manifest-path', policy.cargoManifest, '--target', policy.rust.target, '--prefix', 'none', '--format', '{p}'], { cwd: root });
      requireValue(tree.status === 0, 'Cannot verify the target dependency graph');
      for (const line of tree.stdout.split(/\r?\n/)) {
        const match = /^([a-zA-Z0-9_-]+) v([0-9][^\s]*)/.exec(line); if (match) activePackages.add(`${match[1]}@${match[2]}`);
      }
      requireValue(activePackages.size > 0, 'Target dependency graph is empty');
      save('target-packages.json', { target: policy.rust.target, packages: [...activePackages].sort() });
    }
    summary.rust = evaluateRust(rust, policy, activePackages);
    requireValue(rustResult.status === 0, 'RustSec exited unsuccessfully; no clean result is available');
    summary.passed = true;
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (error) {
    summary.error = error.message;
    throw error;
  } finally { save('summary.json', summary); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
