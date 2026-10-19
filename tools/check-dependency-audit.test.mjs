import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPolicy, evaluateJavascript, evaluateRust, main } from './check-dependency-audit.mjs';

const id = 'GHSA-aaaa-bbbb-cccc';
const exception = { package: 'fixture', range: '<=1.0.0', severity: 'high', reviewBy: '2099-01-01', reason: 'Synthetic reviewed exception used only for audit gate tests.' };
const policy = () => ({ schemaVersion: 1, packageManager: 'npm', javascript: { advisories: { [id]: exception }, affectedPackages: {
  fixture: { version: '1.0.0', severity: 'high', nodes: ['node_modules/fixture'], advisories: [id] },
  host: { version: '2.0.0', severity: 'high', nodes: ['node_modules/host'], advisories: [id] },
} }, rust: { warnings: [] } });
const lock = () => ({ packages: { 'node_modules/fixture': { version: '1.0.0' }, 'node_modules/host': { version: '2.0.0' } } });
const npm = () => ({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } }, vulnerabilities: {
  fixture: { name: 'fixture', severity: 'high', nodes: ['node_modules/fixture'], via: [{ name: 'fixture', range: '<=1.0.0', severity: 'high', url: `https://github.com/advisories/${id}` }] },
  host: { name: 'host', severity: 'high', nodes: ['node_modules/host'], via: ['fixture'] },
} });
const rust = () => ({ database: { 'last-commit': 'a'.repeat(40) }, lockfile: { 'dependency-count': 5 }, settings: { ignore: [], target_arch: [], target_os: [], severity: null, informational_warnings: ['unmaintained', 'unsound', 'notice'] }, vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} });
const pnpm = () => ({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } });

test('reviewed advisory and its exact transitive scope are accepted, with findings visible', () => {
  assert.deepEqual(evaluateJavascript(npm(), policy(), lock()), { affectedPackages: 2, acceptedAdvisories: [id] });
});
test('a changed dependency version requires a new review', () => {
  const changed = lock(); changed.packages['node_modules/fixture'].version = '1.0.1';
  assert.throws(() => evaluateJavascript(npm(), policy(), changed), /version changed/);
});
test('an added nested copy cannot inherit an exception', () => {
  const changed = npm(); changed.vulnerabilities.fixture.nodes.push('node_modules/another/node_modules/fixture');
  assert.throws(() => evaluateJavascript(changed, policy(), lock()), /path changed/);
});
test('a new advisory on a previously reviewed package still fails', () => {
  const changed = npm(); changed.vulnerabilities.fixture.via[0].url = 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz';
  assert.throws(() => evaluateJavascript(changed, policy(), lock()), /New or changed npm advisory/);
});
test('a new affected dependant is not hidden by known root advisories', () => {
  const changed = npm(); changed.vulnerabilities.other = { name: 'other', severity: 'high', nodes: ['node_modules/other'], via: ['fixture'] }; changed.metadata.vulnerabilities.total = 3; changed.metadata.vulnerabilities.high = 3;
  assert.throws(() => evaluateJavascript(changed, policy(), lock()), /other/);
});
test('changed severity, malformed graphs, and scanner error objects fail closed', () => {
  const changed = npm(); changed.vulnerabilities.fixture.via[0].severity = 'critical';
  assert.throws(() => evaluateJavascript(changed, policy(), lock()), /advisory/);
  changed.vulnerabilities.fixture.via = ['host'];
  assert.throws(() => evaluateJavascript(changed, policy(), lock()), /cyclic/);
  assert.throws(() => evaluateJavascript({ error: { code: 'EAUDITNOLOCK' } }, policy()), /complete report/);
  assert.throws(() => evaluateJavascript({}, policy()), /complete report/);
});
test('an empty npm report requires consistent totals', () => {
  const clean = npm(); clean.vulnerabilities = {}; clean.metadata.vulnerabilities.total = 0; clean.metadata.vulnerabilities.high = 0;
  assert.equal(evaluateJavascript(clean, policy(), lock()).affectedPackages, 0);
  clean.metadata.vulnerabilities.total = 1;
  assert.throws(() => evaluateJavascript(clean, policy(), lock()), /total/);
});
test('pnpm has no blanket advisory exceptions', () => {
  const p = policy(); p.packageManager = 'pnpm';
  assert.equal(evaluateJavascript(pnpm(), p).affectedPackages, 0);
  const changed = pnpm(); changed.advisories.example = { severity: 'low' }; changed.metadata.vulnerabilities.low = 1;
  assert.throws(() => evaluateJavascript(changed, p), /New pnpm/);
});
test('expired exceptions and undocumented decisions cannot remain green', () => {
  const p = policy(); p.javascript.advisories = { [id]: { ...exception, reviewBy: '2026-10-18' } };
  assert.throws(() => checkPolicy(p, '2026-10-19'), /expired/);
  p.javascript.advisories[id].reviewBy = '2099-01-01'; p.javascript.advisories[id].reason = '';
  assert.throws(() => checkPolicy(p, '2026-10-19'), /reason/);
});
test('RustSec requires a real full-lockfile report without ignored advisories', () => {
  assert.equal(evaluateRust(rust(), policy()).vulnerabilities, 0);
  const missing = rust(); delete missing.database;
  assert.throws(() => evaluateRust(missing, policy()), /database/);
  const ignored = rust(); ignored.settings.ignore.push('RUSTSEC-2026-1234');
  assert.throws(() => evaluateRust(ignored, policy()), /without ignores/);
  ignored.settings.ignore = []; ignored.settings.target_os.push('windows');
  assert.throws(() => evaluateRust(ignored, policy()), /target filters/);
  ignored.settings.target_os = []; ignored.settings.severity = 'high';
  assert.throws(() => evaluateRust(ignored, policy()), /severity thresholds/);
  ignored.settings.severity = null; ignored.settings.informational_warnings = ['unmaintained'];
  assert.throws(() => evaluateRust(ignored, policy()), /suppressed warnings/);
});
test('a newly reported Rust vulnerability always fails', () => {
  const changed = rust(); changed.vulnerabilities = { found: true, count: 1, list: [{ advisory: { id: 'RUSTSEC-2026-1234' } }] };
  assert.throws(() => evaluateRust(changed, policy()), /reported a vulnerability/);
});
test('only exact reviewed Rust warning kind, id and package versions can pass', () => {
  const p = policy(), report = rust();
  p.rust.warnings = [{ id: 'RUSTSEC-2026-1234', package: 'fixture', version: '1.0.0', kind: 'unmaintained', ...exception }];
  report.warnings.unmaintained = [{ kind: 'unmaintained', package: { name: 'fixture', version: '1.0.0' }, advisory: { id: 'RUSTSEC-2026-1234', informational: 'unmaintained' } }];
  assert.equal(evaluateRust(report, p).acceptedWarnings.length, 1);
  report.warnings.unmaintained[0].package.version = '2.0.0';
  assert.throws(() => evaluateRust(report, p), /New or changed RustSec/);
});
test('an inactive-platform exception fails if it enters the supported target graph', () => {
  const p = policy(), report = rust(); p.rust.target = 'x86_64-pc-windows-msvc';
  p.rust.warnings = [{ ...exception, id: 'RUSTSEC-2026-1234', package: 'fixture', version: '1.0.0', kind: 'unsound', inactiveOnTarget: true }];
  report.warnings.unsound = [{ kind: 'unsound', package: { name: 'fixture', version: '1.0.0' }, advisory: { id: 'RUSTSEC-2026-1234', informational: 'unsound' } }];
  assert.equal(evaluateRust(report, p, new Set(['other@1.0.0'])).acceptedWarnings.length, 1);
  assert.throws(() => evaluateRust(report, p, new Set(['fixture@1.0.0'])), /now in the/);
});
test('transport, process and invalid JSON failures cannot produce a clean or credential-bearing artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'starlite-audit-test-')), previous = process.env.npm_execpath;
  try {
    mkdirSync(join(root, 'tools'));
    const p = policy(); p.packageManager = 'pnpm'; p.javascript.advisories = {};
    writeFileSync(join(root, 'tools/dependency-audit-policy.json'), JSON.stringify(p));
    const cli = join(root, 'fake-cli.cjs'); process.env.npm_execpath = cli;
    for (const body of [
      'process.stderr.write("https://user:password@private.invalid/token=secret");process.stdout.write("not-json");process.exitCode=1;',
      'process.stdout.write(JSON.stringify({error:{message:"token=secret"}}));process.exitCode=1;',
      'process.stderr.write("token=secret");process.exitCode=2;',
    ]) {
      writeFileSync(cli, body); assert.throws(() => main(root), /scanner|registry audit failed/);
      const summary = readFileSync(join(root, 'target/dependency-audit/summary.json'), 'utf8');
      assert.equal(JSON.parse(summary).passed, false); assert.doesNotMatch(summary, /password|secret|private\.invalid/);
    }
  } finally {
    if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
