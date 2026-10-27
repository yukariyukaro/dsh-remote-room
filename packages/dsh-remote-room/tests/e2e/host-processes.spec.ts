import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OperationContext, RoomGrant } from '../../src/room-service.ts';
import { RoomProcesses } from '../../src/host/processes.ts';
import { AuditError, BoundedMemoryAuditStore, type AuditInput, type AuditStore } from '../../src/host/audit-store.ts';
import { object, type Json } from '../../src/protocol.ts';

const require = createRequire(import.meta.url);
const policyRequire = createRequire(require.resolve('@deepseek-ai/dsh-sandbox-policy'));
const { SessionProjectionRegistry } = await import(policyRequire.resolve('@deepseek-ai/dsh-session-projection'));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Page {
  chunks: { stream: string; text: string; from: number; to: number }[];
  nextCursor: number; oldestCursor: number; latestCursor: number; gap: boolean; gapBytes: number; outputClosed: boolean;
  status: { state: string; exitCode: number | null; signal: string | null; reason: string | null };
}

// No mock subprocess/fs/policy provider: actual rc3 Cordis service, OS processes and native PTY.
describe('RoomProcesses / real Host subprocess capability', () => {
  let directory: string;
  let root: string;
  let ctx: Context;
  let processes: RoomProcesses;
  let audit: BoundedMemoryAuditStore;
  let grant: RoomGrant;
  let lifecycle: AbortController;
  const call = (overrides: Partial<OperationContext> = {}): OperationContext => ({ roomId: grant.roomId, peerId: grant.peerId,
    epoch: grant.epoch, requestId: randomUUID(), signal: new AbortController().signal, ...overrides });
  const invoke = (method: string, args: Json, context = call()) => processes.invoke(method, args, context);
  const start = async (script: string, extra: Record<string, Json> = {}, context = call()) => object(await invoke('exec.start', { argv: [process.execPath, '-e', script], ...extra }, context)).handle as string;
  const page = async (handle: string, after = 0, kind = 'exec', maxBytes = 65536) => await invoke(`${kind}.read`, { handle, after, maxBytes }) as unknown as Page;
  async function waitOutput(handle: string, contains: string, kind = 'exec'): Promise<Page> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = await page(handle, 0, kind);
      if (result.chunks.map(chunk => chunk.text).join('').includes(contains)) return result;
      if (result.outputClosed) throw new Error(`Process closed before expected output: ${JSON.stringify(result.status)}`);
      await delay(25);
    }
    throw new Error('Real process did not publish expected output within deadline');
  }
  async function collect(handle: string, kind = 'exec') {
    let cursor = 0;
    let text = '';
    let last!: Page;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      last = await page(handle, cursor, kind);
      expect(last.gap).toBe(false);
      for (const part of last.chunks) { expect(part.from).toBe(cursor); expect(part.to - part.from).toBe(Buffer.byteLength(part.text)); cursor = part.to; text += part.text; }
      expect(last.nextCursor).toBe(cursor);
      if (last.outputClosed && cursor === last.latestCursor) return { text, last };
      await delay(20);
    }
    throw new Error('Real process output did not close within deadline');
  }
  async function replace(mode: RoomGrant['mode'] = 'danger-full-access', limits: ConstructorParameters<typeof RoomProcesses>[3] = {}, journal: AuditStore = audit, ttl = 60_000) {
    await processes?.revoke('replace');
    lifecycle = new AbortController();
    grant = { roomId: 'real-process-room', peerId: 'authenticated-peer', epoch: randomUUID(), root, mode, expiresAt: Date.now() + ttl };
    processes = new RoomProcesses(ctx.subprocess, ctx.fs, journal, limits);
    await processes.authorize(grant, lifecycle.signal);
  }
  beforeEach(async () => {
    processes = undefined as unknown as RoomProcesses;
    directory = await mkdtemp(path.join(tmpdir(), 'dsh-room-processes-'));
    root = path.join(directory, 'root'); await mkdir(root);
    ctx = new Context();
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: directory });
    await ctx.plugin(SandboxedFileSystem, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 });
    await ctx.plugin(LocalSubprocessRuntime);
    expect(ctx.subprocess).toBeInstanceOf(LocalSubprocessRuntime);
    audit = new BoundedMemoryAuditStore();
    await replace();
  });
  afterEach(async () => {
    await processes?.revoke('test teardown').catch(() => {});
    await ctx?.fiber.dispose();
    await audit?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('executes a real Host node process, writes marker, returns Unicode streaming byte cursors and exit facts', async () => {
    const handle = await start(`require('node:fs').writeFileSync('marker.txt','HOST_WRITE'); const b=Buffer.from('世界🙂\\n'); for (let i=0;i<b.length;i++) setTimeout(()=>process.stdout.write(b.subarray(i,i+1)),i*10); setTimeout(()=>process.stderr.write('STDERR\\n'),150)`);
    const { text: output, last } = await collect(handle);
    expect(output).toBe('世界🙂\nSTDERR\n');
    expect(output).not.toContain('\ufffd');
    expect(last.status).toMatchObject({ state: 'exited', exitCode: 0, signal: null });
    expect(await readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('HOST_WRITE');
    const journal = await audit.query({ limit: 200 });
    expect(journal.entries).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'exec.start', status: 'attempt' }), expect.objectContaining({ operation: 'exec.start', status: 'success' })]));
    expect(JSON.stringify(journal)).not.toContain('HOST_WRITE');
    expect(JSON.stringify(journal)).not.toContain('writeFileSync');
  });

  it('strictly denies arbitrary exec and PTY in BOTH lower room modes and audits denials despite full deployment', async () => {
    const spawn = vi.spyOn(ctx.subprocess, 'spawn');
    const terminal = vi.spyOn(ctx.subprocess, 'spawnTerminal');
    for (const mode of ['read-only', 'workspace-write'] as const) {
      await replace(mode);
      for (const method of ['exec.start', 'exec.read', 'exec.write', 'exec.kill', 'pty.start', 'pty.read', 'pty.write', 'pty.resize', 'pty.kill']) {
        await expect(invoke(method, { argv: [process.execPath, '-e', "require('node:fs').writeFileSync('bypass','bad')"], policy: { mode: 'danger-full-access' } })).rejects.toMatchObject({ code: 'PROCESS_DENIED' });
      }
    }
    expect(spawn).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled();
    const entries = (await audit.query({ limit: 200 })).entries;
    expect(entries.filter(entry => entry.status === 'denied')).toHaveLength(18);
    expect(JSON.stringify(entries)).not.toContain('writeFileSync');
  });

  it('rejects guest policy, stale epochs/peers/rooms and wrong-kind handles', async () => {
    await expect(invoke('exec.start', { argv: [process.execPath], mode: 'danger-full-access' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const handle = await start("process.stdout.write('READY'); setInterval(()=>{},1000)");
    await waitOutput(handle, 'READY');
    for (const context of [call({ peerId: 'other' }), call({ epoch: 'old' }), call({ roomId: 'other' })]) {
      await expect(invoke('exec.read', { handle }, context)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    }
    await expect(invoke('pty.read', { handle })).rejects.toMatchObject({ code: 'HANDLE_NOT_FOUND' });
    await invoke('exec.kill', { handle });
  });

  it('requires fenced real Host cwd, permits full-access absolute cwd and refuses links/junctions', async () => {
    const outside = path.join(directory, 'outside'); await mkdir(outside);
    const handle = await start("require('node:fs').writeFileSync('absolute-cwd-marker','yes')", { cwd: outside });
    await collect(handle);
    expect(await readFile(path.join(outside, 'absolute-cwd-marker'), 'utf8')).toBe('yes');
    await expect(start('0', { cwd: '../outside' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(start('0', { cwd: 'link' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('bounds room concurrency to two and stdin writes honor backpressure/end without leaking content into audit', async () => {
    const script = "process.stdout.write('READY'); process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>process.stdout.write(x)); process.stdin.on('end',()=>process.exit(0))";
    const one = await start(script); const two = await start(script);
    await waitOutput(one, 'READY'); await waitOutput(two, 'READY');
    await expect(start('0')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await invoke('exec.write', { handle: one, data: 'stdin-secret-世界🙂', end: true })).toMatchObject({ acceptedBytes: Buffer.byteLength('stdin-secret-世界🙂'), ended: true });
    expect((await collect(one)).text).toBe('READYstdin-secret-世界🙂');
    await invoke('exec.kill', { handle: two });
    expect(JSON.stringify(await audit.query({ limit: 200 }))).not.toContain('stdin-secret');
  });

  it('bounds total ring to 256KiB and chunks to 64KiB with explicit byte gaps and no split Unicode', async () => {
    const handle = await start("process.stdout.write('世界🙂'.repeat(100000)); setTimeout(()=>process.stdout.write('TAIL'),100)");
    const deadline = Date.now() + 8000;
    let first!: Page;
    do { first = await page(handle); if (first.outputClosed) break; await delay(30); } while (Date.now() < deadline);
    expect(first.outputClosed).toBe(true); expect(first.gap).toBe(true); expect(first.gapBytes).toBeGreaterThan(0);
    expect(first.latestCursor).toBe(1_000_004);
    expect(first.latestCursor - first.oldestCursor).toBeLessThanOrEqual(256 * 1024);
    let cursor = first.oldestCursor; let output = '';
    while (cursor < first.latestCursor) {
      const part = await page(handle, cursor);
      expect(part.gap).toBe(false); expect(part.nextCursor).toBeGreaterThan(cursor);
      expect(part.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0)).toBeLessThanOrEqual(65536);
      for (const chunk of part.chunks) { expect(chunk.text).not.toContain('\ufffd'); expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(65536); output += chunk.text; }
      cursor = part.nextCursor;
    }
    expect(output.endsWith('TAIL')).toBe(true);
    const insideMultibyte = await page(handle, first.oldestCursor + 1, 'exec', 4);
    expect(insideMultibyte.chunks.every(chunk => !chunk.text.includes('\ufffd'))).toBe(true);
  });

  it('detaches post-start request cancellation, but pre-aborted start never spawns and never replays a requestId', async () => {
    const controller = new AbortController(); const context = call({ signal: controller.signal });
    const handle = await start("process.stdout.write('READY'); setInterval(()=>{},1000)", {}, context);
    controller.abort(); await waitOutput(handle, 'READY');
    await expect(start('0', {}, { ...context, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const aborted = new AbortController(); aborted.abort();
    const spawn = vi.spyOn(ctx.subprocess, 'spawn');
    await expect(start('0', {}, call({ signal: aborted.signal }))).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(spawn).not.toHaveBeenCalled();
    await invoke('exec.kill', { handle });
  });

  it('kills actual descendant work on revoke before audit failure and rejects all old handles', async () => {
    let failAudit = false;
    const journal: AuditStore = { append: (entry, signal) => failAudit ? Promise.reject(new AuditError()) : audit.append(entry, signal), query: audit.query.bind(audit), close: async () => {} };
    await replace('danger-full-access', {}, journal);
    const child = "setInterval(()=>require('node:fs').appendFileSync('heartbeat','x'),30)";
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});process.stdout.write('READY:'+c.pid);setInterval(()=>{},1000)`;
    const handle = await start(script);
    await waitOutput(handle, 'READY:');
    await delay(150); failAudit = true;
    await expect(processes.revoke('test audit down')).rejects.toBeInstanceOf(AuditError);
    const before = await readFile(path.join(root, 'heartbeat'), 'utf8'); await delay(200);
    expect(await readFile(path.join(root, 'heartbeat'), 'utf8')).toBe(before);
    failAudit = false;
    await expect(invoke('exec.read', { handle })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('fails closed before spawn if attempt journal fails and kills an ambiguous started process if success journal fails', async () => {
    let failSuccess = false;
    const journal: AuditStore = { append: (entry: AuditInput, signal) => entry.operation === 'exec.start' && (!failSuccess || entry.status === 'success') ? Promise.reject(new AuditError()) : audit.append(entry, signal),
      query: audit.query.bind(audit), close: async () => {} };
    await replace('danger-full-access', {}, journal);
    const spawn = vi.spyOn(ctx.subprocess, 'spawn');
    await expect(start("setInterval(()=>{},1000)")).rejects.toMatchObject({ code: 'HOST_AUDIT_UNAVAILABLE' });
    expect(spawn).not.toHaveBeenCalled();
    failSuccess = true;
    await expect(start("setInterval(()=>{},1000)")).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels an ambiguous in-flight start after actual execution and kills without replay', async () => {
    let reached!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const journal: AuditStore = { append: async (entry, signal) => {
      if (entry.operation === 'exec.start' && entry.status === 'success') { reached(); await gate; }
      return audit.append(entry, signal);
    }, query: audit.query.bind(audit), close: async () => {} };
    await replace('danger-full-access', {}, journal);
    const controller = new AbortController();
    const context = call({ signal: controller.signal });
    const starting = start("setInterval(()=>require('node:fs').appendFileSync('cancel-heartbeat','x'),20)", {}, context);
    const settled = starting.then(() => null, error => error);
    await ready;
    // Wait for real target side effects, not merely a mocked spawn return.
    await vi.waitFor(async () => expect((await readFile(path.join(root, 'cancel-heartbeat'), 'utf8')).length).toBeGreaterThan(0), { timeout: 5000 });
    controller.abort(); release();
    expect(await settled).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const before = await readFile(path.join(root, 'cancel-heartbeat'), 'utf8'); await delay(150);
    expect(await readFile(path.join(root, 'cancel-heartbeat'), 'utf8')).toBe(before);
    await expect(start('0', {}, { ...context, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });

  it('enforces execution deadline and room lifecycle abort even without another RPC', async () => {
    await replace('danger-full-access', { maxExecMs: 150 });
    const handle = await start("process.stdout.write('READY'); setInterval(()=>{},1000)");
    await delay(300);
    expect((await page(handle)).outputClosed).toBe(true);
    const second = await start("setInterval(()=>{},1000)");
    lifecycle.abort(); await delay(100);
    await expect(invoke('exec.read', { handle: second })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('keeps finished handle metadata bounded without evicting either live process', async () => {
    await replace('danger-full-access', { maxHandles: 2 });
    const live = await start("process.stdout.write('LIVE');setInterval(()=>{},1000)");
    await waitOutput(live, 'LIVE');
    const finished = await start("process.stdout.write('FINISHED')");
    await collect(finished);
    await delay(100);
    const next = await start("process.stdout.write('NEXT')");
    await collect(next);
    await expect(invoke('exec.read', { handle: finished })).rejects.toMatchObject({ code: 'HANDLE_NOT_FOUND' });
    expect((await page(live)).status.state).toBe('running');
    await invoke('exec.kill', { handle: live });
  });

  it('expires an actual idle PTY after Host TTL rather than keeping an unbounded session', async test => {
    await replace('danger-full-access', { ptyIdleMs: 250 });
    let handle: string;
    try { handle = object(await invoke('pty.start', { argv: [process.execPath, '-e', "setInterval(()=>{},1000)"] })).handle as string; }
    catch (error) { expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' }); test.skip('Real PTY not supported; no fallback'); return; }
    await delay(1500);
    const result = await page(handle, 0, 'pty');
    expect(result.status.reason).toBe('PTY_IDLE');
    await vi.waitFor(async () => expect((await page(handle, 0, 'pty')).outputClosed).toBe(true), { timeout: 4000 });
  });

  it('allocates an actual PTY with write/resize/Unicode and independent start signal, or explicitly reports unavailable', async test => {
    const controller = new AbortController();
    const script = "console.log('REAL_TTY:'+Boolean(process.stdin.isTTY)+':世界🙂');process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{console.log('ECHO:'+x);if(x.includes('quit'))process.exit(0)});setInterval(()=>{},1000)";
    let handle: string;
    try { handle = object(await invoke('pty.start', { argv: [process.execPath, '-e', script], cols: 100, rows: 30 }, call({ signal: controller.signal }))).handle as string; }
    catch (error) {
      expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
      test.skip(`Real PTY unavailable on ${process.platform}/${process.arch}; no spawn fallback`); return;
    }
    controller.abort();
    const ready = await waitOutput(handle, 'REAL_TTY:true:世界🙂', 'pty');
    expect(ready.chunks.map(chunk => chunk.text).join('')).not.toContain('\ufffd');
    expect(await invoke('pty.resize', { handle, cols: 90, rows: 32 })).toMatchObject({ resized: true });
    await invoke('pty.write', { handle, data: 'hello-world\r' });
    await waitOutput(handle, 'ECHO:hello-world', 'pty');
    await invoke('pty.kill', { handle });
    expect((await page(handle, 0, 'pty')).outputClosed).toBe(true);
  });
});
