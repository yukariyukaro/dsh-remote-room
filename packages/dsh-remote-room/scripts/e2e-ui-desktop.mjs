#!/usr/bin/env node
/** One fresh packaged Desktop fixture. Never discovers or attaches to an existing app. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';

const options = { exe: 'D:\\J\\dsh\\DeepSeek Harness.exe', dryRun: false, mode: 'discovery', cli: 'D:\\J\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd' };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('node scripts/e2e-ui-desktop.mjs [--exe <packaged.exe>] [--dry-run] [--package <built.tgz> --sha256 <expected-digest>] [--mode discovery|mixed|mixed-guest] [--cli <supported dsh.cmd>]\nWindows + Node >=24.9 + root playwright dependency required. Runs ONE fresh native window, discovers only its ephemeral CDP, uses visible UI without credentials, then Browser.close teardown (not a Quit click). Forced cleanup is a failure. `--mode mixed` pairs this native window as Host with an isolated owned Web profile as Guest; `--mode mixed-guest` pairs a Web Host with this native window as Guest. Both run the real create/join/approve/preview/revoke UI journey across carriers. Reports and safe screenshots remain in a unique temp report directory. Does not use the live GUI, existing profile, Electron Node-mode launcher, or installed runtime writes.');
    process.exit(0);
  }
  if (arg === '--dry-run') options.dryRun = true;
  else if (['--exe', '--package', '--sha256', '--cli', '--mode'].includes(arg) && process.argv[i + 1]) options[arg.slice(2)] = arg === '--sha256' ? process.argv[++i] : arg === '--mode' ? process.argv[++i] : path.resolve(process.argv[++i]);
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
assert.equal(process.platform, 'win32', 'Packaged fixture currently requires Windows');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 24 || (major === 24 && minor >= 9), 'Use ordinary Node >=24.9');
assert(path.isAbsolute(options.exe) && /\.exe$/iu.test(options.exe));
if (options.dryRun) {
  console.log(JSON.stringify({ mode: 'dry-run', executable: options.exe, arguments: ['--user-data-dir=<fresh-owned>', '--remote-debugging-port=0'], environment: 'OS allowlist + fresh owned home/agents/userData/cwd/cache', target: 'dsh-app://app/', teardown: 'Browser.close + 30s grace + PID/createTime verification; owned force = failure', launched: false }, null, 2));
  process.exit(0);
}
const { chromium } = await import('playwright');
await stat(options.exe);
const reportRoot = await mkdtemp(path.join(tmpdir(), 'dsh-room-desktop-report-'));
const base = path.join(reportRoot, 'fixture');
await mkdir(base);
const ownedBase = await realpath(base);
const paths = Object.fromEntries(['home', 'agents', 'user', 'appdata', 'localappdata', 'tmp', 'workspace', 'electron-user-data'].map(name => [name, path.join(base, name)]));
for (const directory of Object.values(paths)) await mkdir(directory);
for (const name of ['empty.npmrc', 'empty-global.npmrc']) await writeFile(path.join(base, name), '');
const env = {};
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (process.env[name] !== undefined) env[name] = process.env[name];
Object.assign(env, { PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`, HOME: paths.user, USERPROFILE: paths.user, APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata, TEMP: paths.tmp, TMP: paths.tmp, DSH_HOME: paths.home, DSH_AGENTS_HOME: paths.agents, DSH_TELEMETRY_DISABLED: '1', npm_config_userconfig: path.join(base, 'empty.npmrc'), npm_config_globalconfig: path.join(base, 'empty-global.npmrc'), npm_config_cache: path.join(base, 'npm-cache') });
assert(!('ELECTRON_RUN_AS_NODE' in env) && !('NODE_OPTIONS' in env) && !('DSH_PROFILE_DIR' in env));
const report = { started: new Date().toISOString(), node: process.version, executable: options.exe, exeSha256: createHash('sha256').update(await readFile(options.exe)).digest('hex'), reportRoot, isolation: { base, home: paths.home, agents: paths.agents, userData: paths['electron-user-data'], cwd: paths.workspace, environmentKeys: Object.keys(env).sort() }, launchAttach: 'not-reached', onboarding: 'not-reached', pluginsEntry: 'not-reached', settingsEntry: 'not-reached', installEnable: 'not-run', uiJourney: 'not-run', teardown: 'not-reached', webEvents: [], webStages: [], mixedJourney: 'not-run', screenshots: [], actions: [], processes: [] };
const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function powershell(script, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, cwd: paths.workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned process snapshot command timed out')); }, timeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`Process inspection failed (${code}): ${stderr.slice(0, 500)}`)); });
  });
}
// No CommandLine or environment is scanned by this global PID/parent/createTime snapshot.
async function snapshot() {
  const text = await powershell("$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parent';e={[int]$_.ParentProcessId}},@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}},@{n='exe';e={$_.ExecutablePath}}) | ConvertTo-Json -Compress");
  const result = JSON.parse(text);
  return Array.isArray(result) ? result : [result];
}
const known = new Map();
let child, rootExit = false, rootCode, stderr = '', endpoint, browser, monitor, monitorBusy, monitorError, cleanupPromise, deadline;
let latest = [];
const bornAfter = Date.now() - 2000;
async function observe() {
  const rows = await snapshot();
  const root = rows.find(row => row.pid === child?.pid);
  if (!known.size && root) {
    assert(Date.parse(root.created) >= bornAfter && path.resolve(root.exe).toLowerCase() === path.resolve(options.exe).toLowerCase(), 'Spawned PID identity mismatch');
    known.set(root.pid, { ...root, root: true, host: false });
  }
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (known.has(row.pid)) continue;
      const parent = known.get(row.parent);
      if (parent && rows.some(candidate => candidate.pid === parent.pid && candidate.created === parent.created) && Date.parse(row.created) >= Date.parse(parent.created)) {
        known.set(row.pid, { ...row, root: false, host: false });
        changed = true;
      }
    }
  } while (changed);
  latest = rows.filter(row => known.get(row.pid)?.created === row.created);
  return latest;
}
async function until(probe, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (monitorError) throw monitorError;
    const value = await probe();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
function validateEndpoint(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && url.port !== '53420' && /^\/devtools\/browser\/[a-z\d-]+$/iu.test(url.pathname));
  return url.href;
}
function ownedHttp(url) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.protocol, 'http:');
  assert.notEqual(parsed.port, '53420');
  return new Promise((resolve, reject) => {
    const req = request(parsed, { agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(new Error('CDP response exceeded limit')); });
      response.on('end', () => { try { assert.equal(response.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.setTimeout(1500, () => req.destroy(new Error('Owned CDP HTTP timeout')));
    req.once('error', reject);
    req.end();
  });
}
async function safeScreenshot(page, name) {
  assert(page.url().startsWith('dsh-app://app/'), 'Screenshot target changed');
  // Fail closed before capturing sensitive screens; never record HAR/trace or inspected body text.
  const text = await page.locator('body').innerText();
  assert(!/(?:dsh-room:|[?&]token=|sk-[a-z\d]{12}|邀请码|邀请链接|invitation|invite link)/iu.test(text), 'Sensitive invitation/credential screen: screenshot refused');
  // This discovery never fills a form. Refuse nonempty editable fields rather than risking pixels.
  const nonempty = await page.locator('input,textarea,[contenteditable="true"]').evaluateAll(elements => elements.some(element => String('value' in element ? element.value : element.textContent).trim().length > 0));
  assert(!nonempty, 'Nonempty editable field: screenshot refused');
  const output = path.join(reportRoot, `${name}.png`);
  const session = await page.context().newCDPSession(page);
  try {
    // Native capture avoids a Playwright screenshot/masking hang observed specifically on Plugins.
    const shot = await Promise.race([session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), delay(15000).then(() => { throw new Error('Native renderer screenshot timed out'); })]);
    await writeFile(output, Buffer.from(shot.data, 'base64'));
  } finally { await session.detach(); }
  report.screenshots.push(output);
}
async function clickVisible(page, names) {
  for (const name of names) {
    for (const role of ['button', 'link', 'menuitem', 'tab']) {
      const locator = page.getByRole(role, { name, exact: true });
      if (await locator.count() === 1 && await locator.isVisible() && await locator.isEnabled()) {
        await locator.click({ timeout: 5000 });
        report.actions.push(`${role}: ${String(name)}`);
        return true;
      }
    }
  }
  return false;
}
async function installPlugin(page) {
  assert(/^[a-f\d]{64}$/u.test(options.sha256 ?? ''), '--package requires exact lower-case --sha256');
  assert(options.package.endsWith('.tgz'), 'Use an immutable distribution tarball');
  const bytes = await readFile(options.package);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, options.sha256, 'Artifact hash mismatch');
  const ownedPackage = path.join(base, 'remote-room.tgz');
  await writeFile(ownedPackage, bytes);
  report.artifact = { version: 'package-owned', sha256: digest };
  await page.getByRole('button', { name: /^(Add plugin|添加插件)$/u }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /^(Package name or address|Package or address|包名或地址)$/u }).fill(ownedPackage);
  await dialog.getByRole('button', { name: /^(Install|安装)$/u, exact: true }).click();
  const enable = dialog.getByRole('button', { name: /^(Enable now|立即启用)$/u, exact: true });
  await enable.waitFor({ state: 'visible', timeout: 150000 });
  report.actions.push('native Plugins Add textbox -> Install -> Enable now visible');
  const eventResponses = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.protocol === 'dsh-app:' && url.pathname === '/api/remote-room/events') eventResponses.push({ status: response.status(), contentType: response.headers()['content-type'] ?? '' });
  });
  await enable.click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^(Account menu|账号菜单)$/u, exact: true }).click();
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/u, exact: true }).click();
  const settings = page.getByRole('dialog', { name: /^(Settings|设置)$/u });
  await settings.getByRole('button', { name: /^(Remote room|远程协助)$/u, exact: true }).click();
  await settings.getByRole('heading', { name: /^(Remote room|远程协助)$/u }).waitFor();
  await settings.getByText(/^(Updates live|状态实时同步)$/u, { exact: true }).waitFor();
  await settings.getByText(/^(No remote connection yet|尚无远程连接)$/u, { exact: true }).waitFor();
  await until(() => eventResponses.some(item => item.status === 200 && item.contentType.startsWith('text/event-stream')), 'native custom-scheme event stream 200', 15000);
  report.eventStreamResponses = eventResponses;
  report.installEnable = 'passed: UI tarball Install, Enable now, native event stream 200, empty Remote room settings';
  report.settingsEntry = 'clicked';
  // Invitation labels alone are not credentials, but the discovery capture is deliberately strict.
  // Capture the neutral Plugins page only after closing settings; never relax its safety checks.
  await settings.getByRole('button', { name: /^(Close|关闭)$/u, exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  report.actions.push('native Remote room settings visible, Updates live, empty room state');
  try { await safeScreenshot(page, '03-installed-enabled'); }
  catch (error) {
    if (error.message !== 'Native renderer screenshot timed out') throw error;
    report.installedScreenshot = 'unavailable: native renderer capture timed out after verified UI assertions';
  }
}

let webTeardown;
/**
 * Packaged Desktop as Host, an isolated Web profile as Guest, both driven only through real UI.
 * Native pages are never captured (that renderer path times out); Web screenshots stay masked.
 */
async function mixedJourney(desktopPage) {
  const { OwnedProcesses, isolatedEnvironment, prepareBase, ownLaunchURL } = await import('./e2e-ui/web-fixture.mjs');
  const journey = await import('./e2e-ui/web-journey.mjs');
  const role = options.mode === 'mixed-guest' ? 'guest' : 'host';
  const evidence = path.join(reportRoot, 'evidence');
  const webBase = path.join(reportRoot, 'fixture-web');
  const browserBase = path.join(reportRoot, 'fixture-browser');
  await mkdir(evidence, { recursive: true });
  await prepareBase(webBase); await prepareBase(browserBase);
  const web = new OwnedProcesses(message => report.webEvents.push(message), value => value);
  let server;
  webTeardown = async () => {
    try { if (server) await server.close(); } catch (error) { report.webTeardown = error.message; }
    try { await web.stopAll(); } catch (error) { report.webTeardown = error.message; }
  };
  server = await chromium.launchServer({ headless: false, env: isolatedEnvironment(browserBase), timeout: 30000 });
  web.adopt(server.process(), 'owned Chromium web peer');
  const browser = await chromium.connect(server.wsEndpoint());
  const owned = path.join(webBase, 'remote-room.tgz');
  await copyFile(options.package, owned);
  const child = web.start(options.cli, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], isolatedEnvironment(webBase), path.join(webBase, 'workspace'), `${role === 'host' ? 'guest' : 'host'} Web`);
  const launch = await ownLaunchURL(child, new Set());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(25000); page.setDefaultNavigationTimeout(30000);
  await page.goto(launch.href);
  await page.waitForURL(url => url.origin === launch.origin && !url.searchParams.has('token'));
  await journey.dismissFreshWebWelcome(page);
  const webEndpoint = { page, context, base: webBase, label: role === 'host' ? 'guest-web' : 'host-web', origin: launch.origin };
  const results = { stages: report.webStages };
  await journey.installAndEnable(webEndpoint, owned, { report: message => report.webEvents.push(message), evidence, results });
  await journey.openRemoteSettings(page);
  desktopPage.setDefaultTimeout(25000);
  await desktopPage.getByRole('button', { name: /^(Account menu|账号菜单)$/u, exact: true }).click();
  await desktopPage.getByRole('menuitem', { name: /^(Settings|设置)$/u, exact: true }).click();
  const settings = desktopPage.getByRole('dialog', { name: /^(Settings|设置)$/u });
  await settings.getByRole('button', { name: /^(Remote room|远程协助)$/u, exact: true }).click();
  await settings.getByRole('heading', { name: /^(Remote room|远程协助)$/u }).waitFor();
  const desktopEndpoint = { page: desktopPage, base, label: role === 'host' ? 'host-desktop' : 'guest-desktop' };
  const [host, guest] = role === 'host' ? [desktopEndpoint, webEndpoint] : [webEndpoint, desktopEndpoint];
  const shot = async (target, file) => { if (target.url().startsWith('dsh-app:')) return; await journey.maskedScreenshot(target, file); };
  await journey.businessJourney([host, guest], { root: reportRoot, evidence, report: message => report.webEvents.push(message), results, secrets: new Set(), resources: [], coexist: false, visual: false, processes: false, shot });
  report.mixedJourney = role === 'host'
    ? 'passed native-host / web-guest install/join/approve/preview/revoke'
    : 'passed web-host / native-guest install/join/approve/preview/revoke';
  report.uiJourney = `passed ${role} pairing across Desktop and Web`;
  await webTeardown();
  webTeardown = undefined;
}

async function cleanup() {
  return cleanupPromise ??= (async () => {
    clearTimeout(deadline);
    clearInterval(monitor);
    if (monitorBusy) await monitorBusy;
    let forced = false;
    if (child) {
      await observe();
      report.ownedBeforeQuit = latest.map(row => row.pid);
      if (browser) {
        const session = await browser.newBrowserCDPSession();
        // Electron may quit without replying. Do not await a normal protocol response.
        void session.send('Browser.close').catch(() => {});
        report.quitMethod = 'browser-level CDP Browser.close (teardown, NOT a Quit UI click)';
      } else if (endpoint) {
        const socket = new WebSocket(endpoint);
        await new Promise(resolve => { const timer = setTimeout(resolve, 2000); socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        socket.close();
        report.quitMethod = 'raw browser-level CDP Browser.close (teardown)';
      }
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if ((await observe()).length === 0 && rootExit) break;
        await delay(500);
      }
      if (latest.length || !rootExit) {
        forced = true;
        report.forcePids = latest.map(row => row.pid);
        // Recheck exact creation time before forcing each previously recorded PID. No process-name kill.
        for (const row of [...latest].reverse()) {
          const created = row.created.replaceAll("'", "''");
          await powershell(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}'; if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${created}'){ Stop-Process -Id ${row.pid} -Force -ErrorAction Stop }`);
        }
        await until(async () => (await observe()).length === 0 && rootExit, 'owned forced process exit', 10000);
      }
      report.rootExitCode = rootCode;
      report.processes = [...known.values()];
      report.remainingOwnedPids = latest.map(row => row.pid);
      if (endpoint) {
        const port = new URL(endpoint).port;
        let active = false;
        try { await ownedHttp(`http://127.0.0.1:${port}/json/version`); active = true; } catch (error) { /* Expected connection refusal after quit. */ }
        report.cdpUnavailableAfterQuit = !active;
        assert(!active, 'Owned CDP still responds after teardown');
      }
    }
    if (webTeardown) { const stop = webTeardown; webTeardown = undefined; await stop(); }
    assert.equal(await realpath(base), ownedBase);
    assert(path.basename(reportRoot).startsWith('dsh-room-desktop-report-') && path.dirname(base) === reportRoot);
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
    report.fixtureRemoved = true;
    report.teardown = forced ? 'forced-fail' : 'graceful';
    if (forced) throw new Error('Owned forced cleanup was required; lifecycle suite failed');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { report.failure = `Interrupted: ${signal}`; void finish(130); });
async function finish(code) {
  try { await cleanup(); } catch (error) { report.cleanupFailure = error.message; if (report.teardown === 'not-reached') report.teardown = 'incomplete'; code = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(reportRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[desktop] ${JSON.stringify(report, null, 2)}`);
  process.exit(code);
}
try {
  const before = await snapshot();
  child = spawn(options.exe, [`--user-data-dir=${paths['electron-user-data']}`, '--remote-debugging-port=0'], { env, cwd: paths.workspace, stdio: ['ignore', 'ignore', 'pipe'] });
  child.once('exit', code => { rootExit = true; rootCode = code; });
  child.once('error', error => { monitorError = error; rootExit = true; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-128000); });
  assert(!before.some(row => row.pid === child.pid), 'Spawned PID already existed');
  report.pid = child.pid;
  deadline = setTimeout(() => { report.failure = 'Overall deadline exceeded'; void finish(1); }, options.package ? 420000 : 240000);
  await observe();
  monitor = setInterval(() => { if (!monitorBusy) { monitorBusy = observe().catch(error => { monitorError = error; }).finally(() => { monitorBusy = undefined; }); } }, 800);
  endpoint = await until(async () => {
    if (rootExit) throw new Error('Native app exited before discovery; possible single-instance refusal. No retry or live fallback.');
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z\d-]+)/iu.exec(stderr);
    if (match) { report.endpointSource = 'owned-child-stderr'; return validateEndpoint(match[1]); }
    try {
      const activePort = path.join(paths['electron-user-data'], 'DevToolsActivePort');
      const info = await stat(activePort);
      assert(info.mtimeMs >= bornAfter, 'DevToolsActivePort is not fresh');
      const [port, suffix] = (await readFile(activePort, 'utf8')).trim().split(/\r?\n/u);
      assert(/^\d+$/u.test(port));
      report.endpointSource = 'fresh-owned-userData-DevToolsActivePort';
      return validateEndpoint(`ws://127.0.0.1:${port}${suffix}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return undefined;
  }, 'owned renderer CDP endpoint', 60000);
  const origin = `http://127.0.0.1:${new URL(endpoint).port}`;
  const version = await ownedHttp(`${origin}/json/version`);
  assert.equal(validateEndpoint(version.webSocketDebuggerUrl), endpoint);
  report.browserVersion = version.Browser;
  report.cdpPort = new URL(endpoint).port;
  const targets = await until(async () => { const rows = await ownedHttp(`${origin}/json/list`); return rows.some(row => row.type === 'page' && row.url.startsWith('dsh-app://app/')) ? rows : undefined; }, 'dsh-app main target', 90000);
  report.targetKinds = targets.map(row => ({ type: row.type, url: row.url.startsWith('dsh-app://app/') ? 'dsh-app://app/' : new URL(row.url).protocol }));
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'));
  assert(page, 'Owned CDP did not expose dsh-app://app/');
  page.setDefaultTimeout(7000);
  await page.locator('body').waitFor({ state: 'visible' });
  await until(async () => (await page.getByRole('button').count()) > 0, 'interactive native UI', 30000);
  report.launchAttach = 'passed';
  report.target = 'dsh-app://app/';
  await stat(path.join(paths.home, 'profiles', 'desktop'));
  report.desktopProfileCreated = true;
  await observe();
  // Only previously-owned descendants are inspected; emit a boolean, never their argv.
  for (const row of [...known.values()].filter(value => !value.root)) {
    const result = await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}'; if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${row.created}'){ [bool]($p.CommandLine -match 'dsh-desktop-host') } else { 'False' }`);
    row.host = result === 'True';
  }
  report.hostDescendantObserved = [...known.values()].some(row => row.host);
  assert(report.hostDescendantObserved, 'No owned Host descendant identified');
  await safeScreenshot(page, '01-initial');
  // Real visible UI only: bounded no-key onboarding, never preload/remote/ctx injection.
  for (let step = 0; step < 8; step++) {
    const clicked = await clickVisible(page, [/跳过/u, /暂时跳过/u, /稍后设置/u, /稍后/u, /Skip(?: for now)?/iu, /Set up later/iu, /继续/u, /下一步/u, /Continue/iu, /Next/iu, /开始使用/u, /Get started/iu, /完成/u, /Done/iu]);
    if (!clicked) break;
    await delay(350); // Allow the clicked wizard transition to settle before reading its next controls.
  }
  report.visibleButtons = (await page.getByRole('button').allTextContents()).map(text => text.trim()).filter(Boolean).map(text => text.replace(/(?:sk-|[?&]token=)\S+/giu, '<redacted>')).slice(0, 45);
  report.pluginsEntry = await clickVisible(page, [/插件/u, /Plugins/iu]) ? 'clicked' : 'not-visible';
  if (report.pluginsEntry === 'clicked') {
    await page.getByRole('button', { name: /Add plugin|添加插件/iu }).waitFor({ state: 'visible', timeout: 30000 });
    report.onboarding = report.actions.length === 1 ? 'no-key-main-UI-without-onboarding' : 'no-key-UI-path-completed';
    report.pluginsPageVisible = true;
    try { await safeScreenshot(page, '02-plugins'); }
    catch (error) {
      if (error.message !== 'Native renderer screenshot timed out') throw error;
      report.pluginsScreenshot = 'unavailable: owned renderer capture timed out; Add plugin DOM assertion passed';
    }
  } else {
    report.settingsEntry = await clickVisible(page, [/设置/u, /Settings/iu]) ? 'clicked' : 'not-visible';
    await safeScreenshot(page, '02-after-onboarding');
    report.onboarding = report.settingsEntry === 'clicked' ? 'no-key-UI-path-completed' : 'blocked-no-visible-keyless-continuation';
    if (report.settingsEntry === 'clicked') {
      report.pluginsEntry = await clickVisible(page, [/插件/u, /Plugins/iu]) ? 'clicked' : 'not-visible-after-settings';
      if (report.pluginsEntry === 'clicked') await safeScreenshot(page, '03-plugins');
    }
  }
  await observe();
  if (report.onboarding === 'blocked-no-visible-keyless-continuation') throw new Error('Native onboarding blocks no-key access to Settings/Plugins; see safe screenshots and visible button labels');
  assert.equal(report.pluginsEntry, 'clicked', 'Plugins entry not reached by real clicks');
  if (options.package) await installPlugin(page);
  if (options.mode === 'mixed' || options.mode === 'mixed-guest') await mixedJourney(page);
  await finish(0);
} catch (error) {
  // Do not serialize Playwright internals, page content, raw stderr, endpoint IDs, or auth URLs.
  report.failure = String(error.message).replace(/(?:https?|ws):\/\/\S+/giu, '<url-redacted>').slice(0, 900);
  await finish(1);
}
