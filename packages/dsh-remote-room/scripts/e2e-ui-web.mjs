#!/usr/bin/env node
/** Real Web UI installation: CLI launches only; an owned visible Chromium clicks Install and Enable now. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { OwnedProcesses, bounded, isolatedEnvironment, ownLaunchURL, prepareBase, removeStoppedData, until } from './e2e-ui/web-fixture.mjs';
import { dismissFreshWebWelcome, installAndEnable, openRemoteSettings, businessJourney, maskedScreenshot } from './e2e-ui/web-journey.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const options = { cli: 'D:\\J\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd', package: path.join(repo, 'artifacts/local-dsh-remote-room-0.1.2.tgz'), sha256: '36a24181a7378670a9340794b6ccca88f36858ad0e0eb415a3cf59aaf806d5fe', mode: 'install', deadline: '360000', headless: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('node scripts/e2e-ui-web.mjs [--cli <supported dsh.cmd|dsh>] [--package <absolute.tgz>] [--sha256 <expected digest>] [--mode install|journey|full] [--deadline <milliseconds>] [--headless] [--visual] [--processes]\nNode >=24.9. Visible isolated Chromium by default. Clean owned DSH_HOME; CLI launches only. No live-browser attach, trace, HAR, credentials, or private runtime mutations.\n  install  one clean endpoint, installed and enabled through the real Plugins UI\n  journey  two endpoints whose profiles are preseeded through the plugin CLI; only product UI is exercised, so packaging timeouts cannot fail a behaviour run\n  full     both endpoints installed through the Plugins UI, then the same journey\njourney/full use the official in-page-picker overlay as a labeled test fixture; --visual also captures real dark/light/narrow; --processes adds a second full-access room with real exec/PTY and revoke.');
    process.exit(0);
  }
  if (arg === '--headless') options.headless = true;
  else if (arg === '--visual') options.visual = true;
  else if (arg === '--processes') options.processes = true;
  else if (['--cli', '--package', '--sha256', '--mode', '--deadline'].includes(arg) && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
assert(['install', 'journey', 'full'].includes(options.mode));
assert(/^\d+$/u.test(options.deadline) && Number(options.deadline) >= 30_000 && Number(options.deadline) <= 900_000);
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 24 || (major === 24 && minor >= 9), 'Use ordinary Node >=24.9');
assert.equal(process.platform, 'win32', 'This carrier runner currently verifies Windows owned PID birth times');
const root = await mkdtemp(path.join(tmpdir(), 'dsh-room-ui-web-'));
const ownedRoot = await realpath(root);
const evidence = path.join(root, 'evidence'); await mkdir(evidence);
const secrets = new Set();
const redact = value => {
  let text = String(value).replace(/([?&#](?:token|key|hostToken|createToken)=)[^\s&#)]+/giu, '$1<redacted>');
  for (const secret of secrets) text = text.split(secret).join('<redacted>');
  return text;
};
const events = [];
const report = message => { const clean = redact(message); events.push(clean); console.log(`[ui-web] ${clean}`); };
const processes = new OwnedProcesses(report, redact);
const results = { mode: options.mode, node: process.version, carrier: options.cli, artifact: options.package, expectedSha256: options.sha256, visible: !options.headless,
  launch: 'not-reached', installEnable: 'not-reached', journey: 'not-reached', teardown: 'not-reached', evidence, stages: [], pickerFixture: options.mode === 'journey' };
let browserServer, browser, snapshotTimer, totalTimer, currentPage, cleaning, failed = false;
const bases = [];
const endpoints = [];
const resources = [];
async function cleanup() {
  return cleaning ??= (async () => {
    clearTimeout(totalTimer); clearInterval(snapshotTimer);
    const errors = [];
    for (const close of resources.reverse()) { try { await close(); } catch (error) { errors.push(redact(error.message)); } }
    // Browser close is teardown, not a user-facing Quit scenario.
    try { if (browserServer) await bounded(browserServer.close(), 'owned Chromium close', 15_000); } catch (error) { errors.push(redact(error.message)); }
    try { await processes.stopAll(); } catch (error) { errors.push(redact(error.message)); }
    if (errors.length) { failed = true; results.teardown = 'incomplete; fixture data retained'; results.cleanupErrors = errors; }
    else {
      results.teardown = 'all owned trees stopped; PID birth times verified';
      if (!failed) for (const base of bases) await removeStoppedData(base, ownedRoot);
      report(failed ? 'failed-run fixture data retained after verified process stop' : 'stopped fixture homes removed; evidence retained');
    }
    results.events = events;
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(results, null, 2) + '\n');
    report(`result ${path.join(evidence, 'result.json')}`);
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { failed = true; void cleanup().then(() => process.exit(130), error => { console.error(redact(error.message)); process.exit(1); }); });
totalTimer = setTimeout(() => { failed = true; results.error = 'overall deadline exceeded'; report(results.error); void cleanup().finally(() => process.exit(1)); }, Number(options.deadline));
try {
  const artifact = path.resolve(options.package);
  assert(artifact.endsWith('.tgz'), 'Use an immutable packed artifact');
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
  assert.equal(digest, options.sha256, 'Artifact SHA-256 mismatch'); results.actualSha256 = digest;
  report(`artifact SHA-256 ${digest}; Node ${process.version}; ${options.mode}`);
  const hostBase = path.join(root, 'host'); bases.push(hostBase); await prepareBase(hostBase);
  const env = isolatedEnvironment(hostBase);
  const help = await processes.completed(processes.start(options.cli, ['--help'], env, hostBase, 'supported CLI help'));
  assert(help.includes('--profile') && help.includes('--patch'), 'Unsupported CLI profile/patch interface');
  const webHelp = await processes.completed(processes.start(options.cli, ['--profile', 'web', '--help'], env, hostBase, 'supported Web help'), 90_000);
  assert(webHelp.includes('--port') && webHelp.includes('--no-open'), 'Unsupported Web lifecycle flags');
  // No `plugin add`, observer plugin, private API, or handmade profile files are used.
  const patch = path.join(root, 'in-page-picker.test-fixture.yml');
  if (options.mode !== 'install') await writeFile(patch, '# TEST FIXTURE: official in-page picker override; not native picker coverage.\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: directory-picker-browse\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n    - id: ui-directory-picker-browse\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"\n');
  const browserBase = path.join(root, 'browser'); bases.push(browserBase); await prepareBase(browserBase);
  browserServer = await chromium.launchServer({ headless: options.headless, env: isolatedEnvironment(browserBase), timeout: 30_000 });
  processes.adopt(browserServer.process(), 'owned Chromium');
  browser = await chromium.connect(browserServer.wsEndpoint());
  snapshotTimer = setInterval(() => { void processes.snapshot().catch(error => { results.snapshotError = redact(error.message); }); }, 3_000);
  await processes.snapshot();
  const count = options.mode === 'install' ? 1 : 2;
  // `journey`/`full` both need the plugin; only `full` proves the click-install path.
  const uiInstall = options.mode !== 'journey';
  for (let i = 0; i < count; i++) {
    const base = i === 0 ? hostBase : path.join(root, 'guest');
    if (i) { bases.push(base); await prepareBase(base); }
    const ownedPackage = path.join(base, 'remote-room.tgz'); await copyFile(artifact, ownedPackage);
    assert.equal(createHash('sha256').update(await readFile(ownedPackage)).digest('hex'), digest);
    if (!uiInstall) {
      // Behaviour runs must not re-prove packaging: install once through the CLI,
      // then exercise only product UI. The click-install path has its own mode.
      await processes.completed(processes.start(options.cli, ['plugin', '--profile', 'web', 'add', ownedPackage], isolatedEnvironment(base), base, `${path.basename(base)} profile plugin add`), 180_000);
      results.preseeded = 'plugin installed into the isolated profile through the CLI';
    }
    const args = ['--profile', 'web', ...(options.mode === 'install' ? [] : ['--patch', patch]), '--host', '127.0.0.1', '--port', '0', '--no-open'];
    const child = processes.start(options.cli, args, isolatedEnvironment(base), path.join(base, 'workspace'), `${path.basename(base)} Web`);
    await processes.snapshot();
    const launch = await ownLaunchURL(child, secrets);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    const page = await context.newPage(); currentPage = page;
    page.on('response', response => {
      const url = new URL(response.url());
      if (response.status() >= 400) (results.failedRequests ??= []).push({ endpoint: path.basename(base), path: url.pathname, method: response.request().method(), status: response.status() });
      if (url.pathname === '/api/remote-room/events') (results.eventStreamResponses ??= []).push({ endpoint: path.basename(base), status: response.status(), contentType: response.headers()['content-type'] });
    });
    page.on('pageerror', error => { (results.pageErrors ??= []).push(redact(error.message)); });
    // Record only failures, not ordinary console payloads that could contain invitation data.
    page.on('console', message => { if (message.type() === 'error') (results.consoleErrors ??= []).push(redact(message.text())); });
    page.setDefaultTimeout(25_000); page.setDefaultNavigationTimeout(30_000);
    await page.goto(launch.href);
    await page.waitForURL(url => url.origin === launch.origin && !url.searchParams.has('token'));
    report(`${path.basename(base)}: navigated own authenticated origin ${launch.origin}`);
    results.launch = `${i + 1} owned Web endpoint(s) loaded`;
    const endpoint = { page, context, base, label: path.basename(base), origin: launch.origin };
    endpoints.push(endpoint);
    await dismissFreshWebWelcome(page);
    if (uiInstall) await installAndEnable(endpoint, ownedPackage, { report, evidence, results });
    await openRemoteSettings(page);
    await page.getByRole('heading', { name: /^(共享你的工作区)$/u, exact: true }).waitFor();
    await page.getByText(/^(共享目录)$/u).waitFor();
    if (options.mode !== 'install') {
      await until(() => results.eventStreamResponses?.find(item => item.endpoint === endpoint.label && item.status === 200 && item.contentType?.startsWith('text/event-stream')), `${endpoint.label} real SSE HTTP 200`, 15_000);
      assert.equal(results.eventStreamResponses.filter(item => item.endpoint === endpoint.label && item.status >= 400).length, 0, 'Remote room event stream must not fail');
    }
    await maskedScreenshot(page, path.join(evidence, `${endpoint.label}-enabled-settings.png`));
    results.stages.push(`${endpoint.label}: ${uiInstall ? 'clean-home UI Install + Enable now' : 'profile preseeded through the plugin CLI'} + empty Remote room settings passed`);
  }
  results.installEnable = uiInstall ? `passed on ${count} clean owned endpoint(s)` : `preseeded on ${count} owned endpoint(s)`;
  if (options.mode !== 'install') {
    currentPage = endpoints[1].page;
    results.journey = 'in-progress';
    await businessJourney(endpoints, { root, evidence, report, results, secrets, resources, visual: options.visual, processes: options.processes });
    results.journey = `passed create/join/approve/preview/revoke${options.processes ? '/exec/pty' : ''}`;
  }
  report(`PASS ${results.installEnable}; journey ${results.journey}`);
} catch (error) {
  failed = true; process.exitCode = 1; results.error = redact(error.stack ?? error);
  if (results.journey === 'in-progress') results.journey = 'failed; later stages not-reached';
  report(`FAIL ${results.error}`);
  for (const endpoint of endpoints) {
    try {
      await maskedScreenshot(endpoint.page, path.join(evidence, `${endpoint.label}-failure.png`));
      await writeFile(path.join(evidence, `${endpoint.label}-failure-text.txt`), redact(await endpoint.page.locator('body').innerText()));
      // Read-only diagnostic only: does not create, join, approve, or replace UI assertions.
      const response = await endpoint.page.request.post(`${endpoint.origin}/api/remote-room`, { data: { action: 'state' }, timeout: 10_000 });
      const body = await response.json();
      if (body.ok && Array.isArray(body.value?.rooms)) await writeFile(path.join(evidence, `${endpoint.label}-state-diagnostic.json`), redact(JSON.stringify({ status: response.status(), revision: body.value.revision, rooms: body.value.rooms }, null, 2)));
    } catch (diagnosticError) { (results.diagnosticErrors ??= []).push(redact(diagnosticError.message)); }
  }
  if (currentPage && !currentPage.isClosed()) {
    try {
      await maskedScreenshot(currentPage, path.join(evidence, 'failure.png'));
      // innerText excludes form values; redact known secrets as a second safeguard.
      await writeFile(path.join(evidence, 'failure-visible-text.txt'), redact(await currentPage.locator('body').innerText()));
      await writeFile(path.join(evidence, 'failure-controls.json'), JSON.stringify(await currentPage.locator('button,input,textarea,[role="switch"]').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, role: element.getAttribute('role'), name: element.getAttribute('aria-label'), title: element.getAttribute('title'), text: element.tagName === 'BUTTON' ? element.textContent : undefined, placeholder: element.getAttribute('placeholder'), type: element.getAttribute('type') }))), null, 2));
    } catch (captureError) { results.captureError = redact(captureError.message); }
  }
} finally {
  try { await cleanup(); } catch (error) { console.error(redact(error.stack ?? error)); process.exitCode = 1; }
  if (failed) process.exitCode = 1;
}
