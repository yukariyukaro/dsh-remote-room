#!/usr/bin/env node
/** Real supported-CLI profiles. No current-profile state or inherited credentials are used. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('../', import.meta.url));
const options = { cli: 'D:\\J\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd', mode: 'installed', smoke: false, processes: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('node scripts/e2e-profiles.mjs [--cli <dsh.cmd|dsh>] [--package <built.tgz>] [--mode installed|overlay] [--smoke] [--processes] [--npm-script <npm-cli.js> --pnpm-script <pnpm.mjs>]\nRun this driver with Node >=24.9. npm-script selects a temporary exact @deepseek-ai/dsh@0.2.1-rc.3 installation. Default: installed, authenticated TLS relay + real remote tool read/write/epoch/revoke. Overlay explicitly tests Loader composition, NOT installation.');
    process.exit(0);
  }
  if (arg === '--smoke') options.smoke = true;
  else if (arg === '--processes') options.processes = true;
  else if (['--cli', '--package', '--mode', '--npm-script', '--pnpm-script'].includes(arg) && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
assert(['installed', 'overlay'].includes(options.mode), 'mode must be installed or overlay');
const root = await mkdtemp(path.join(tmpdir(), 'dsh-room-profiles-'));
const ownedRoot = await realpath(root);
const resources = [];
let cleaning;
let totalTimer;
const secrets = new Set();
const redact = value => {
  let text = String(value).replace(/([?&#](?:token|key|hostToken|createToken)=)[^\s&#)]+/giu, '$1<redacted>');
  for (const secret of secrets) text = text.split(secret).join('<redacted>');
  return text;
};
const report = message => console.log(`[profiles] ${redact(message)}`);

/** Only explicitly selected OS process-launch variables survive; no environment scan reads keys. */
function environment(base) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, PATH: [path.dirname(process.execPath), ...(options['pnpm-script'] ? [path.join(root, 'bin')] : []), env.PATH ?? ''].join(path.delimiter),
    HOME: base, USERPROFILE: base, APPDATA: path.join(base, 'appdata'), LOCALAPPDATA: path.join(base, 'localappdata'),
    npm_config_userconfig: path.join(base, 'empty.npmrc'), npm_config_globalconfig: path.join(base, 'empty-global.npmrc'), npm_config_cache: path.join(base, 'npm-cache'),
    TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp'), DSH_HOME: path.join(base, 'home'),
    DSH_AGENTS_HOME: path.join(base, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1', CI: '1' };
}

async function killTree(record) {
  if (record.closed) return;
  if (process.platform === 'win32') {
    // The PID is one we spawned, never a discovered/shared DSH PID.
    const killer = spawn('taskkill.exe', ['/PID', String(record.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await Promise.race([new Promise(resolve => killer.once('close', resolve)), delay(8_000).then(() => { killer.kill(); })]);
  } else {
    try { process.kill(-record.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([record.completion, delay(5_000)]);
    if (!record.closed) {
      try { process.kill(-record.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  await Promise.race([record.completion, delay(8_000).then(() => { if (!record.closed) throw new Error(`Child ${record.child.pid} did not stop`); })]);
}

function start(command, args, env, cwd, label) {
  let executable = command;
  let argv = args;
  if (/\.m?js$/iu.test(command)) { executable = process.execPath; argv = [command, ...args]; }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
    // cmd receives only generated/local paths and fixed flags; reject shell expansion characters.
    for (const value of [command, ...args]) assert(!/["%\r\n&|<>^]/u.test(value), 'Unsafe cmd argument');
    executable = 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${[command, ...args].map(value => `"${value}"`).join(' ')}"`];
  }
  const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: executable === 'cmd.exe' });
  const record = { child, label, output: '', stdout: '', closed: false, code: undefined };
  record.completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { record.closed = true; record.code = code; resolve(code); });
  });
  // Keep rejection observed even when readiness, rather than completion, owns the next wait.
  record.completion.catch(() => {});
  child.stdout.on('data', data => { record.stdout = (record.stdout + data).slice(-128_000); record.output = (record.output + data).slice(-128_000); });
  child.stderr.on('data', data => { record.output = (record.output + data).slice(-128_000); });
  resources.push(() => killTree(record));
  report(`${label}: spawned owned PID ${child.pid}`);
  return record;
}

async function completed(record, timeout = 120_000) {
  let timer;
  try {
    const code = await Promise.race([record.completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${record.label} exceeded ${timeout}ms\n${redact(record.output)}`)), timeout); })]);
    assert.equal(code, 0, `${record.label} exit ${code}\n${redact(record.output)}`);
    return record.output;
  } finally { clearTimeout(timer); }
}

async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

/** Direct loopback HTTP avoids inherited proxy dispatchers and redirects to other origins. */
async function request(url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const target = new URL(url);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.protocol, 'http:');
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method, agent: false, headers: { ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      ...(cookie ? { cookie } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) req.destroy(new Error('HTTP response exceeded limit')); });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error('HTTP timeout')));
    req.once('error', reject);
    req.end(body);
  });
}

async function cookieJarFromOwnURL(record) {
  // Only stdout from this exact isolated child is considered an authentication source.
  const launch = await until(() => {
    if (record.closed) throw new Error(`${record.label} exited before readiness: ${redact(record.output)}`);
    return /dsh web: (http:\/\/[^\s]+)/u.exec(record.stdout)?.[1];
  }, `${record.label} readiness`, 90_000);
  const url = new URL(launch);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/');
  assert(url.port && url.port !== '0');
  const token = url.searchParams.get('token');
  assert(token, 'Own readiness URL omitted auth token');
  secrets.add(token);
  const exchange = await request(url);
  assert.equal(exchange.status, 303, 'Own boot token exchange');
  assert.equal(exchange.headers.location, './');
  const values = exchange.headers['set-cookie'];
  assert(Array.isArray(values) && values.length > 0, 'Own boot exchange omitted cookies');
  const cookie = values.map(value => value.split(';', 1)[0]).join('; ');
  secrets.add(cookie);
  report(`${record.label}: authenticated owned origin ${url.origin}`);
  return { origin: url.origin, cookie };
}

async function api(browser, action, fields = {}, allowFailure = false) {
  const result = await request(`${browser.origin}/api/remote-room`, { method: 'POST', cookie: browser.cookie, body: JSON.stringify({ action, ...fields }) });
  assert.equal(result.status, 200, `remote-room ${action} HTTP ${result.status}: ${redact(result.text)}`);
  const payload = JSON.parse(result.text);
  if (!allowFailure) assert.equal(payload.ok, true, `remote-room ${action}: ${redact(result.text)}`);
  return allowFailure ? payload : payload.value;
}

// This fixture invokes public Agent/tools services in the real CLI-created runtime. It never
// constructs a Cordis context, installs plugins privately, or calls a tool definition directly.
const observerSource = `
export const name = 'profiles-e2e-observer';
export const inject = ['connection', 'agents', 'agentPresets', 'tools', 'permissionPresets'];
export function apply(ctx) {
  let handle;
  let counter = 0;
  ctx.effect(() => async () => {
    if (handle) {
      handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await handle.dispose();
    }
  });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/profiles-e2e-tools', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      const admitted = ctx.connection.admit(request);
      if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner' || admitted.peer.id !== ctx.connection.browserPeer.id) return new Response('Forbidden', { status: 403 });
      const body = await request.json();
      if (!['remote_rooms','remote_read','remote_list','remote_write','remote_edit','remote_exec','remote_process','remote_pty'].includes(body.name)) return new Response('Tool not allowed', { status: 400 });
      if (!handle) {
        handle = await ctx.agents.create({ sessionId: 'profiles-e2e-tools', meta: { cwd: process.cwd() }, setup: async scope => { await ctx.agentPresets.mount(scope, 'cordis'); } });
        ctx.permissionPresets.set(handle.agent.session, 'danger-full-access');
        handle.agent.session.append('turn/start', { turn: 1 });
      }
      const result = await ctx.tools.execute({ callId: 'profiles-e2e-' + (++counter), name: body.name, arguments: body.arguments, agent: handle.agent, signal: request.signal });
      return Response.json(result);
    }
  }));
}
`;

async function tool(browser, name, args, failure = false) {
  const response = await request(`${browser.origin}/api/profiles-e2e-tools`, { method: 'POST', cookie: browser.cookie, body: JSON.stringify({ name, arguments: args }) });
  assert.equal(response.status, 200, `Tool fixture HTTP ${response.status}: ${redact(response.text)}`);
  const result = JSON.parse(response.text);
  assert.equal(result.isError, failure, `${name}: ${redact(response.text)}`);
  return failure ? result : (typeof result.value === 'string' ? JSON.parse(result.value) : result.value);
}

async function processScenario(host, guest, relay, shared, guestBase) {
  // Installed-provider evidence, separate from browser clicks and separate from a real LLM call.
  const created = await api(host, 'create', { root: shared, mode: 'danger-full-access', relay });
  secrets.add(created.invitation);
  const id = created.room.id;
  await until(async () => (await api(host, 'state')).rooms.find(room => room.id === id)?.phase === 'authenticating', 'full room relay');
  await api(guest, 'join', { invitation: created.invitation });
  await until(async () => (await api(host, 'state')).rooms.find(room => room.id === id)?.phase === 'pending', 'full room pairing');
  await api(host, 'approve', { id });
  const room = await until(async () => {
    const value = (await api(guest, 'state')).rooms.find(room => room.id === id);
    return value?.phase === 'authorized' && value;
  }, 'full room authorization');
  const at = { roomId: id, epoch: room.epoch };
  const marker = path.join(shared, 'exec-host-marker.txt');
  const started = await tool(guest, 'remote_exec', { ...at, argv: [process.execPath, '-e', `require('node:fs').writeFileSync('exec-host-marker.txt','HOST_ONLY');process.stdout.write('EXEC_UNICODE_你好');process.stderr.write('EXEC_STDERR');process.exitCode=7`] });
  let cursor = 0;
  let output = '';
  let exited;
  await until(async () => {
    const result = await tool(guest, 'remote_process', { ...at, handle: started.handle, action: 'read', after: cursor });
    assert.equal(result.data.gap, false);
    output += result.data.chunks.map(chunk => chunk.text).join('');
    cursor = result.data.nextCursor;
    exited = result.data.status;
    return result.data.outputClosed && cursor === result.data.latestCursor;
  }, 'actual exec output drain');
  assert(output.includes('EXEC_UNICODE_你好') && output.includes('EXEC_STDERR'));
  assert.equal(exited.exitCode, 7);
  assert.equal(await readFile(marker, 'utf8'), 'HOST_ONLY');
  await assert.rejects(readFile(path.join(guestBase, 'workspace', 'exec-host-marker.txt')), { code: 'ENOENT' });
  const pty = await tool(guest, 'remote_pty', { ...at, action: 'start', argv: [process.execPath, '-e', `console.log('PTY_REAL:'+process.stdout.isTTY);process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{if(s.includes('ROOM_INPUT'))console.log('PTY_ACK_你好')});setInterval(()=>{},1000)`], cols: 80, rows: 24 });
  cursor = 0; output = '';
  const ptyRead = async () => {
    const result = await tool(guest, 'remote_pty', { ...at, action: 'read', handle: pty.handle, after: cursor });
    assert.equal(result.data.gap, false);
    cursor = result.data.nextCursor;
    output += result.data.chunks.map(chunk => chunk.text).join('');
    return result.data;
  };
  await until(async () => { await ptyRead(); return output.includes('PTY_REAL:true'); }, 'actual PTY isTTY');
  await tool(guest, 'remote_pty', { ...at, action: 'resize', handle: pty.handle, cols: 100, rows: 30 });
  await tool(guest, 'remote_pty', { ...at, action: 'write', handle: pty.handle, data: 'ROOM_INPUT\r' });
  await until(async () => { await ptyRead(); return output.includes('PTY_ACK_你好'); }, 'actual PTY Unicode stdin ACK');
  await tool(guest, 'remote_pty', { ...at, action: 'kill', handle: pty.handle });
  await until(async () => { const result = await ptyRead(); return result.outputClosed && cursor === result.latestCursor; }, 'actual PTY close');
  const heartbeat = path.join(shared, 'revoke-heartbeat.txt');
  await tool(guest, 'remote_exec', { ...at, argv: [process.execPath, '-e', `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('revoke-heartbeat.txt','x'),50)`] });
  await until(async () => { try { return (await readFile(heartbeat)).length > 2; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'actual process heartbeat');
  await api(host, 'revoke', { id });
  const size = (await readFile(heartbeat)).length;
  await delay(350);
  assert.equal((await readFile(heartbeat)).length, size, 'Revoke must stop actual Host execution');
  await until(async () => ['closed', 'failed'].includes((await api(guest, 'state')).rooms.find(room => room.id === id)?.phase), 'full room revoke propagation');
  const denied = await tool(guest, 'remote_exec', { ...at, argv: [process.execPath, '-e', 'process.exit(99)'] }, true);
  assert.equal(denied.error.info.code, 'NOT_AUTHORIZED');
  report('PASS installed Host exec Unicode/stderr/exit/Host-only marker; real PTY isTTY/stdin/resize/kill; live process revoked');
}

async function teardown() {
  return cleaning ??= (async () => {
    clearTimeout(totalTimer);
    const failures = [];
    for (const close of resources.reverse()) { try { await close(); } catch (error) { failures.push(error); } }
    // Re-check the exact mkdtemp result before recursive removal; no user-provided deletion target.
    assert.equal(await realpath(root), ownedRoot);
    assert(path.basename(root).startsWith('dsh-room-profiles-'));
    if (failures.length) throw new AggregateError(failures, 'Owned child teardown failed; temporary directory retained');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    report('all owned child trees stopped; temporary roots removed');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void teardown().then(() => process.exit(130), error => { console.error(redact(error.stack)); process.exit(1); }); });
totalTimer = setTimeout(() => { console.error('[profiles] overall deadline exceeded'); void teardown().finally(() => process.exit(1)); }, 8 * 60_000);

try {
  report(`carrier ${options.cli}; mode ${options.mode}`);
  const bases = ['host', 'guest'].map(name => path.join(root, name));
  for (const base of bases) {
    for (const dir of ['tmp', 'appdata', 'localappdata', 'workspace', 'home', 'agents']) await mkdir(path.join(base, dir), { recursive: true });
  }
  if (options['pnpm-script']) {
    await mkdir(path.join(root, 'bin'));
    assert(process.platform === 'win32', 'Explicit pnpm script shim currently supports Windows only');
    const shim = `@echo off\r\n"${process.execPath}" "${path.resolve(options['pnpm-script'])}" %*\r\n`;
    await writeFile(path.join(root, 'bin/pnpm.cmd'), shim);
  }
  const env = environment(bases[0]);
  if (options['npm-script']) {
    assert(Number(process.versions.node.split('.')[0]) >= 24 && (Number(process.versions.node.split('.')[0]) > 24 || Number(process.versions.node.split('.')[1]) >= 9), 'npm runtime requires Node >=24.9');
    assert(options['pnpm-script'], 'npm runtime requires --pnpm-script for a pinned package manager');
    const npm = path.resolve(options['npm-script']);
    const metadata = JSON.parse(await completed(start(npm, ['view', '@deepseek-ai/dsh@0.2.1-rc.3', 'version', 'bin', '--json', '--registry=https://registry.npmjs.org'], env, bases[0], 'exact CLI registry metadata'), 30_000));
    assert.equal(metadata.version, '0.2.1-rc.3');
    assert.equal(typeof metadata.bin?.dsh, 'string');
    const runtime = path.join(root, 'npm-runtime');
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await completed(start(npm, ['install', '--prefix', runtime, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '@deepseek-ai/dsh@0.2.1-rc.3'], env, bases[0], 'exact CLI npm install'), 180_000);
    const manifest = JSON.parse(await readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    assert.equal(manifest.version, '0.2.1-rc.3');
    assert.equal(manifest.bin.dsh, metadata.bin.dsh);
    options.cli = path.resolve(runtime, 'node_modules/@deepseek-ai/dsh', manifest.bin.dsh);
    report(`exact npm CLI ${manifest.version}, Node ${process.version}, OpenSSL ${process.versions.openssl}`);
  }
  const help = await completed(start(options.cli, ['--help'], env, bases[0], 'CLI help'), 20_000);
  assert(help.includes('--patch') && help.includes('plugin'), 'Carrier help does not support profiles/patch/plugin');
  const pluginHelp = await completed(start(options.cli, ['plugin', '--help'], env, bases[0], 'plugin help'), 20_000);
  assert(pluginHelp.includes('--profile') && pluginHelp.includes('add <pkg>'), 'Unsupported installation CLI');
  const webHelp = await completed(start(options.cli, ['--profile', 'web', '--help'], env, bases[0], 'web help'), 90_000);
  assert(webHelp.includes('--port') && webHelp.includes('--no-open'), 'Unsupported web lifecycle flags');
  if (options.mode === 'installed') {
    const packageFile = path.resolve(options.package ?? path.join(repo, 'artifacts/local-dsh-remote-room-0.1.2.tgz'));
    assert(packageFile.endsWith('.tgz'), 'Install a packed artifact, not a linked package directory');
    // Copy only the explicitly selected built artifact. Never walk user homes or credential files.
    const ownedPackage = path.join(root, 'remote-room.tgz');
    await copyFile(packageFile, ownedPackage);
    const digest = createHash('sha256').update(await readFile(ownedPackage)).digest('hex');
    report(`artifact ${packageFile}; sha256 ${digest}`);
    for (const base of bases) await completed(start(options.cli, ['plugin', '--profile', 'web', 'add', ownedPackage, '--ignore-scripts'], environment(base), path.join(base, 'workspace'), `${path.basename(base)} install`));
  }
  const browsers = [];
  for (const base of bases) {
    const observer = path.join(base, 'observer.mjs');
    await writeFile(observer, observerSource);
    const entries = [{ id: 'profiles-e2e-observer', name: pathToFileURL(observer).href }];
    if (options.mode === 'overlay') entries.unshift({ id: 'dsh-remote-room', name: pathToFileURL(path.join(repo, 'lib/index.js')).href, config: {} });
    const patch = path.join(base, 'observer.patch.yml');
    await writeFile(patch, JSON.stringify([{ insert: entries }]) + '\n');
    const child = start(options.cli, ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], environment(base), path.join(base, 'workspace'), `${path.basename(base)} web`);
    const browser = await cookieJarFromOwnURL(child);
    browsers.push(browser);
    const state = await api(browser, 'state');
    assert.deepEqual(state.rooms, []);
    report(`${path.basename(base)} Host plugin active; authenticated HTTP state callable`);
    if (!options.smoke) {
      const rooms = await tool(browser, 'remote_rooms', {});
      assert.deepEqual(rooms.data.rooms, []);
      report(`${path.basename(base)} real Agent tool execution callable`);
    }
  }
  assert.notEqual(browsers[0].origin, browsers[1].origin);
  if (!options.smoke) {
    const { build } = await import('esbuild');
    const relayModule = path.join(root, 'relay.mjs');
    await build({ entryPoints: [path.join(repo, 'relay/src/server.ts')], outfile: relayModule, bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
    // Resolve ws from the project; generated relay code lives under the created temp tree.
    const wsEntry = fileURLToPath(import.meta.resolve('ws'));
    const source = await readFile(relayModule, 'utf8');
    await writeFile(relayModule, source.replaceAll('from "ws"', `from ${JSON.stringify(pathToFileURL(wsEntry).href)}`));
    const { startRelay } = await import(pathToFileURL(relayModule).href);
    const relay = await startRelay({ host: '127.0.0.1', port: 0 });
    resources.push(() => relay.close());
    const shared = path.join(bases[0], 'workspace');
    const file = path.join(shared, 'shared.txt');
    await writeFile(file, 'real profile seed\n');
    const [host, guest] = browsers;
    const created = await api(host, 'create', { root: shared, mode: 'workspace-write', relay: relay.url });
    secrets.add(created.invitation);
    const id = created.room.id;
    await until(async () => {
      const room = (await api(host, 'state')).rooms.find(room => room.id === id);
      if (room?.phase === 'failed') throw new Error(`Host relay registration failed: ${room.error}`);
      return room?.phase === 'authenticating';
    }, 'host relay registration');
    await api(guest, 'join', { invitation: created.invitation });
    await until(async () => {
      const state = await api(host, 'state');
      const room = state.rooms.find(room => room.id === id);
      if (room?.phase === 'failed') throw new Error(`TLS pairing failed: ${room.error}`);
      return room?.phase === 'pending';
    }, 'TLS authenticated host pending');
    const pending = (await api(guest, 'state')).rooms.find(room => room.id === id);
    const at = { roomId: id, epoch: pending.epoch, path: file };
    const denied = await api(guest, 'readText', { id, epoch: at.epoch, path: file }, true);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'NOT_AUTHORIZED');
    await api(host, 'approve', { id });
    await until(async () => (await api(guest, 'state')).rooms.find(room => room.id === id)?.phase === 'authorized', 'guest authorized');
    const read = await tool(guest, 'remote_read', at);
    assert.equal(read.data.text, 'real profile seed\n');
    await tool(guest, 'remote_write', { ...at, content: 'written across TLS relay\n', expected: { kind: 'replaceIfVersion', version: read.data.observedVersion } });
    assert.equal(await readFile(file, 'utf8'), 'written across TLS relay\n');
    const stale = await tool(guest, 'remote_read', { ...at, epoch: 'stale-epoch' }, true);
    assert.equal(stale.error.info.code, 'NOT_AUTHORIZED');
    await api(host, 'revoke', { id });
    await until(async () => ['closed', 'failed'].includes((await api(guest, 'state')).rooms.find(room => room.id === id)?.phase), 'revocation propagated');
    const revoked = await api(guest, 'readText', { id, epoch: at.epoch, path: file }, true);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error.code, 'NOT_AUTHORIZED');
    report('PASS authenticated TLS relay join, preapproval denial, real remote tool read/write, stale epoch denial, revoke denial');
    if (options.processes) await processScenario(host, guest, relay.url, shared, bases[1]);
  }
  report(`PASS ${options.mode === 'installed' ? 'installed' : 'Loader-overlay (NOT installation)'} dual-profile ${options.smoke ? 'lifecycle/auth/state smoke' : 'integration'}`);
} catch (error) {
  console.error(`[profiles] FAIL ${redact(error.stack ?? error)}`);
  process.exitCode = 1;
} finally {
  try { await teardown(); } catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
}
