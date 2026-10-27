/** Owned Web fixtures only: no live profile, implicit credentials, or SDK launcher. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function isolatedEnvironment(base) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // A public relay is a local setting, never a source default: hand it to the owned Host only.
  if (process.env.RR_PUBLIC_RELAY !== undefined) env.DSH_REMOTE_ROOM_RELAY = process.env.RR_PUBLIC_RELAY;
  if (process.env.RR_RELAY_TOKEN !== undefined) env.DSH_REMOTE_ROOM_RELAY_TOKEN = process.env.RR_RELAY_TOKEN;
  return { ...env, PATH: [path.dirname(process.execPath), env.PATH ?? ''].join(path.delimiter),
    HOME: base, USERPROFILE: base, APPDATA: path.join(base, 'appdata'), LOCALAPPDATA: path.join(base, 'localappdata'),
    TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp'), DSH_HOME: path.join(base, 'home'), DSH_AGENTS_HOME: path.join(base, 'agents'),
    npm_config_userconfig: path.join(base, 'empty.npmrc'), npm_config_globalconfig: path.join(base, 'empty-global.npmrc'), npm_config_cache: path.join(base, 'npm-cache'),
    DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1', CI: '1' };
}

export async function prepareBase(base) {
  for (const dir of ['tmp', 'appdata', 'localappdata', 'workspace', 'home', 'agents']) await mkdir(path.join(base, dir), { recursive: true });
  await writeFile(path.join(base, 'empty.npmrc'), '');
  await writeFile(path.join(base, 'empty-global.npmrc'), '');
}

export async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function bounded(promise, label, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
}

/** Track descendant PID + creation time; never kill by process name or trust a recycled PID. */
export class OwnedProcesses {
  records = [];
  snapshots = new Map();
  checking;
  constructor(report, redact) { this.report = report; this.redact = redact; }
  start(command, args, env, cwd, label) {
    let executable = command, argv = args;
    if (/\.m?js$/iu.test(command)) { executable = process.execPath; argv = [command, ...args]; }
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
      for (const value of [command, ...args]) assert(!/["%\r\n&|<>^]/u.test(value), 'Unsafe cmd argument');
      executable = 'cmd.exe';
      argv = ['/d', '/s', '/c', `"${[command, ...args].map(value => `"${value}"`).join(' ')}"`];
    }
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: executable === 'cmd.exe' });
    const record = this.adopt(child, label);
    child.stdout.on('data', data => { record.stdout = (record.stdout + data).slice(-128_000); record.output = (record.output + data).slice(-128_000); });
    child.stderr.on('data', data => { record.output = (record.output + data).slice(-128_000); });
    return record;
  }
  adopt(child, label) {
    const record = { child, label, launchedAt: Date.now(), stdout: '', output: '', closed: false, descendants: new Map() };
    record.completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { record.closed = true; record.code = code; resolve(code); });
    });
    record.completion.catch(() => {});
    this.records.push(record);
    this.report(`${label}: owned PID ${child.pid}`);
    return record;
  }
  async completed(record, timeout = 30_000) {
    const code = await bounded(record.completion, record.label, timeout);
    assert.equal(code, 0, `${record.label} exit ${code}\n${this.redact(record.output)}`);
    return record.output;
  }
  async processTable() {
    assert.equal(process.platform, 'win32', 'PID creation-time verification currently requires Windows');
    // Only process IDs, ancestry and birth times are read; no command lines or environment.
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="Born";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let code;
    try { code = await bounded(done, 'owned PID snapshot', 15_000); }
    catch (error) { child.kill(); throw error; }
    assert.equal(code, 0, `PID snapshot failed: ${err}`);
    return new Map(JSON.parse(out.replace(/^\uFEFF/u, '')).map(item => [item.ProcessId, item]));
  }
  async snapshot() {
    if (this.checking) return this.checking;
    return this.checking = this.takeSnapshot().finally(() => { this.checking = undefined; });
  }
  async takeSnapshot() {
    const table = await this.processTable();
    for (const record of this.records) {
      const own = table.get(record.child.pid);
      if (!record.closed && own && Date.parse(own.Born) >= record.launchedAt - 2_000 && !record.descendants.has(own.ProcessId)) record.descendants.set(own.ProcessId, own.Born);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of table.values()) {
          if (record.descendants.has(item.ProcessId)) continue;
          const parentBirth = record.descendants.get(item.ParentProcessId);
          if (parentBirth && table.get(item.ParentProcessId)?.Born === parentBirth && Date.parse(item.Born) >= Date.parse(parentBirth)) {
            record.descendants.set(item.ProcessId, item.Born); changed = true;
          }
        }
      }
    }
    this.snapshots = table;
    return table;
  }
  async stopAll() {
    await this.snapshot();
    for (const record of [...this.records].reverse()) {
      for (const [pid, born] of record.descendants) {
        if (this.snapshots.get(pid)?.Born !== born) continue;
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        const done = new Promise((resolve, reject) => { killer.once('error', reject); killer.once('close', resolve); });
        await bounded(done, `owned tree ${pid} stop`, 10_000);
      }
      if (!record.closed) await bounded(record.completion, `${record.label} stop`, 10_000);
    }
    const table = await this.processTable();
    for (const record of this.records) for (const [pid, born] of record.descendants) assert.notEqual(table.get(pid)?.Born, born, `Owned PID ${pid} survived; keep temporary data`);
    this.report('owned PID trees stopped and birth-time checked (forced teardown where needed)');
  }
}

export async function ownLaunchURL(record, secrets) {
  const launch = await until(() => {
    if (record.closed) throw new Error(`${record.label} exited before Web readiness`);
    return /dsh web: (http:\/\/[^\s]+)/u.exec(record.stdout)?.[1];
  }, `${record.label} own stdout readiness`, 90_000);
  const url = new URL(launch);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); assert.equal(url.pathname, '/');
  assert(url.port && url.port !== '0' && url.port !== '53420', 'Refuse live GUI or invalid port');
  const token = url.searchParams.get('token'); assert(token, 'Own child omitted boot token'); secrets.add(token);
  return url;
}

export async function removeStoppedData(base, ownedRoot) {
  const resolved = await realpath(base);
  assert(resolved.startsWith(ownedRoot + path.sep), 'Deletion must remain inside this run');
  assert(['host', 'guest', 'browser'].includes(path.basename(resolved)), 'Only known owned fixture data may be removed');
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
