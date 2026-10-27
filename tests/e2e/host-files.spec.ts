import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GrantAccess, type FileCall, type GrantMode } from '../../src/host/access.js';
import { HostFiles } from '../../src/host/files.js';
import { AuditError, BoundedMemoryAuditStore, KvAuditStore, type AuditInput, type AuditKvUnit } from '../../src/host/audit-store.js';

// Load the actual installed transitive rc3 projection provider (no mock Context/policy/fs).
const require = createRequire(import.meta.url);
const policyRequire = createRequire(require.resolve('@deepseek-ai/dsh-sandbox-policy'));
const { SessionProjectionRegistry } = await import(policyRequire.resolve('@deepseek-ai/dsh-session-projection'));

describe('Host file capability / real rc3 Cordis sandbox stack', () => {
  let directory: string;
  let root: string;
  let root2: string;
  let outside: string;
  let ctx: Context;
  let fs: SandboxedFileSystem;
  let grants: GrantAccess;
  let files: HostFiles;
  let audit: BoundedMemoryAuditStore;
  let epoch: string;
  const signal = () => new AbortController().signal;
  const call = (overrides: Partial<FileCall> = {}): FileCall => ({ roomId: 'room', peerId: 'authenticated-peer', epoch, requestId: randomUUID(), signal: signal(), ...overrides });
  async function approve(mode: GrantMode = 'workspace-write', selectedRoot = root, ttl = 60_000) {
    epoch = randomUUID();
    await grants.approve({ roomId: 'room', peerId: 'authenticated-peer', epoch, mode, root: selectedRoot, expiresAt: Date.now() + ttl }, signal());
  }
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'dsh-room-host-files-'));
    root = path.join(directory, 'root-one');
    root2 = path.join(directory, 'root-two');
    outside = path.join(directory, 'outside-sentinel.txt');
    await mkdir(root);
    await mkdir(root2);
    await writeFile(path.join(root, 'one.txt'), 'hello\n世界🙂\n');
    await writeFile(path.join(root2, 'two.txt'), 'SECOND_ROOT_SENTINEL');
    await writeFile(outside, 'OUTSIDE_SENTINEL');
    ctx = new Context();
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: directory });
    await ctx.plugin(SandboxedFileSystem, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 });
    fs = ctx.fs as SandboxedFileSystem;
    expect(fs).toBeInstanceOf(SandboxedFileSystem);
    grants = new GrantAccess(fs);
    audit = new BoundedMemoryAuditStore();
    files = new HostFiles(fs, grants, audit, { maxReadBytes: 4096, maxWriteBytes: 4096, maxRangeBytes: 16, maxListEntries: 32 });
    await approve();
  });
  afterEach(async () => {
    grants?.revoke();
    await files?.close();
    await audit?.close();
    await ctx?.fiber.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('resolves host coordinates, reads metadata/text/bytes/ranges, lists, atomically writes and edits', async () => {
    const resolved = await files.resolve(call(), 'one.txt');
    expect(resolved.processPath).toBe(path.join(root, 'one.txt'));
    expect(resolved.fileUrl).toMatch(/^file:/u);
    expect((await files.stat(call(), 'one.txt'))?.type).toBe('file');
    expect((await files.lstat(call(), 'one.txt'))?.type).toBe('file');
    expect(await files.readText(call(), 'one.txt')).toBe('hello\n世界🙂\n');
    expect(Buffer.from(await files.readBytes(call(), 'one.txt')).toString()).toBe('hello\n世界🙂\n');
    expect(Buffer.from(await files.readByteRange(call(), 'one.txt', { offset: 1, length: 3 })).toString()).toBe('ell');
    expect(await files.readByteRange(call(), 'one.txt', { offset: 1000, length: 4 })).toHaveLength(0);
    expect((await files.listDir(call(), '.')).map(entry => entry.name)).toEqual(['one.txt']);
    const outcome = await files.writeText(call(), 'nested/new.txt', 'first\n', { kind: 'createIfAbsent' });
    expect(outcome).toMatchObject({ operation: 'create', before: null, after: 'first\n' });
    const edited = await files.editText(call(), 'nested/new.txt', { oldString: 'first', newString: 'second', replaceAll: false }, { version: outcome.version });
    expect(edited.before).toBe('first\n');
    expect(edited.after).toBe('second\n');
    expect(await readFile(path.join(root, 'nested/new.txt'), 'utf8')).toBe('second\n');
    const journal = await audit.query({ limit: 200 });
    expect(journal.entries.find(entry => entry.operation === 'editText' && entry.status === 'success')?.outcome).toMatchObject({ content: 'omitted', beforeBytes: 6, afterBytes: 7 });
    expect(JSON.stringify(journal)).not.toContain('second\\n');
  });

  it('blocks every entrypoint outside root, including sibling root/temp and spoofed target objects', async () => {
    for (const requested of [outside, path.join(root2, 'two.txt'), path.join(tmpdir(), randomUUID()), '../outside-sentinel.txt']) {
      const reads = [() => files.resolve(call(), requested), () => files.stat(call(), requested), () => files.lstat(call(), requested),
        () => files.readText(call(), requested), () => files.readBytes(call(), requested), () => files.readByteRange(call(), requested, { offset: 0, length: 8 }),
        () => files.listDir(call(), requested), () => files.streamText(call(), requested),
        () => files.writeText(call(), requested, 'ATTACK'), () => files.editText(call(), requested, { oldString: 'SENTINEL', newString: 'ATTACK', replaceAll: true })];
      for (const invoke of reads) {
        const error = await invoke().then(() => null, error => error);
        expect(error).toMatchObject({ code: 'FS_SANDBOX_DENIED' });
        expect(error.message).not.toContain('outside-sentinel');
      }
    }
    await expect(files.readText(call(), { targetKey: outside, displayPath: path.join(root, 'one.txt') } as unknown as string)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    expect(await readFile(outside, 'utf8')).toBe('OUTSIDE_SENTINEL');
    expect(await readFile(path.join(root2, 'two.txt'), 'utf8')).toBe('SECOND_ROOT_SENTINEL');
  });

  it('ignores guest mode/root/policy fields and refuses readonly write despite full deployment fallback', async () => {
    await approve('read-only');
    const fake = { ...call(), mode: 'danger-full-access', root: directory, policy: { mode: 'danger-full-access', workspaceRoot: directory } };
    expect(await files.readText(fake, 'one.txt')).toContain('hello');
    await expect(files.writeText(fake, 'one.txt', 'ATTACK')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(files.editText(fake, 'one.txt', { oldString: 'hello', newString: 'ATTACK', replaceAll: false })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(files.readText({ ...fake, peerId: 'forged' }, 'one.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(files.readText({ ...fake, epoch: 'old' }, 'one.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await approve('danger-full-access');
    expect(await files.readText(call(), outside)).toBe('OUTSIDE_SENTINEL');
    await files.writeText(call(), outside, 'full is explicit, not OS elevation');
    expect(await readFile(outside, 'utf8')).toBe('full is explicit, not OS elevation');
  });

  it('preserves atomic stale-version outcomes with no audit pre/post content reads', async () => {
    const original = (await files.stat(call(), 'one.txt'))!.version;
    const contentRead = vi.spyOn(fs, 'readText');
    const bytesRead = vi.spyOn(fs, 'readBytes');
    const streamRead = vi.spyOn(fs, 'streamText');
    const write = await files.writeText(call(), 'one.txt', 'updated', { kind: 'replaceIfVersion', version: original });
    expect(write.before).toBe('hello\n世界🙂\n');
    await expect(files.writeText(call(), 'one.txt', 'stale', { kind: 'replaceIfVersion', version: original })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });
    await expect(files.editText(call(), 'one.txt', { oldString: 'updated', newString: 'stale', replaceAll: false }, { version: original })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });
    expect(await readFile(path.join(root, 'one.txt'), 'utf8')).toBe('updated');
    expect(contentRead).not.toHaveBeenCalled();
    expect(bytesRead).not.toHaveBeenCalled();
    expect(streamRead).not.toHaveBeenCalled();
    await expect(files.writeText(call(), 'one.txt', 'x', { kind: 'replaceIfVersion', version: FsVersion('stale') })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });
  });

  it('bounds text/bytes/ranges/write/edit/list and rejects pre-aborted calls', async () => {
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(5000));
    await expect(files.readText(call(), 'large.txt')).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
    await expect(files.readBytes(call(), 'large.txt')).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
    await expect(files.readByteRange(call(), 'one.txt', { offset: 0, length: 17 })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
    await expect(files.readByteRange(call(), 'one.txt', { offset: -1, length: 1 })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
    await expect(files.writeText(call(), 'one.txt', 'x'.repeat(5000))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
    await expect(files.editText(call(), 'large.txt', { oldString: 'x', newString: 'y', replaceAll: true })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
    const controller = new AbortController(); controller.abort();
    await expect(files.stat(call({ signal: controller.signal }), 'one.txt')).rejects.toMatchObject({ code: 'FS_ABORTED' });
    for (let index = 0; index < 33; index++) await writeFile(path.join(root, `f${index}`), '');
    await expect(files.listDir(call(), '.')).rejects.toMatchObject({ code: 'FS_TOO_LARGE' });
  });

  it('rejects symlink/junction traversal, hides list descendants, and pins replaced root', async (test) => {
    try {
      await symlink(root2, path.join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(root, path.join(root, 'internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
        test.skip(`Windows link privilege unavailable: ${String(error.code)}`); return;
      }
      throw error;
    }
    for (const requested of ['escape-link', 'escape-link/two.txt', 'internal-link/one.txt']) {
      await expect(files.resolve(call(), requested)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
      await expect(files.lstat(call(), requested)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
      await expect(files.writeText(call(), requested, 'ATTACK')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    }
    const listing = await files.listDir(call(), '.');
    expect(listing.map(entry => entry.name)).toEqual(['one.txt']);
    expect(JSON.stringify(listing)).not.toContain(root2);
    await rename(root, `${root}-old`);
    await mkdir(root);
    await writeFile(path.join(root, 'one.txt'), 'replaced-root');
    await expect(files.readText(call(), 'one.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('pins a changed root without requiring any symlink permissions', async () => {
    await rename(root, `${root}-old`);
    await mkdir(root);
    await writeFile(path.join(root, 'one.txt'), 'replacement');
    await expect(files.resolve(call(), 'one.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('pull streams preserve unicode and revoke closes resources/blocks old handles', async () => {
    const { handle } = await files.streamText(call(), 'one.txt');
    let text = '';
    for (;;) { const part = await files.streamNext(call(), handle); if (part.done) break; text += part.value; }
    expect(text).toBe('hello\n世界🙂\n');
    await expect(files.streamNext(call(), handle)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    const pending = await files.streamText(call(), 'one.txt');
    grants.revoke('test revocation');
    await expect(files.streamNext(call(), pending.handle)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(files.readText(call(), 'one.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await approve('workspace-write', root2);
    expect(await files.readText(call(), 'two.txt')).toBe('SECOND_ROOT_SENTINEL');
    await expect(files.streamNext(call(), pending.handle)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('aborts in-flight bytes on revocation and expires grants without extending them', async () => {
    let reached!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    fs.internals.inspectReadBytesAfterStat = async () => { reached(); await proceed; };
    const reading = files.readBytes(call(), 'one.txt');
    await ready;
    grants.revoke();
    release();
    await expect(reading).rejects.toMatchObject({ code: 'FS_ABORTED' });
    await approve('workspace-write', root, 10);
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(files.readText(call(), 'one.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('fails closed before mutation on journal failure, reports committed audit gaps without replay', async () => {
    const failing = { append: vi.fn().mockRejectedValue(new AuditError()), query: audit.query.bind(audit), close: async () => {} };
    const host = new HostFiles(fs, grants, failing);
    await expect(host.writeText(call(), 'one.txt', 'not executed')).rejects.toBeInstanceOf(AuditError);
    expect(await readFile(path.join(root, 'one.txt'), 'utf8')).toBe('hello\n世界🙂\n');
    let count = 0;
    const gap = { ...failing, append: async (entry: AuditInput) => { count++; if (count === 2) throw new AuditError(); return audit.append(entry); } };
    const gapHost = new HostFiles(fs, grants, gap);
    await expect(gapHost.writeText(call(), 'one.txt', 'committed')).rejects.toThrow('committed');
    expect(await readFile(path.join(root, 'one.txt'), 'utf8')).toBe('committed');
    expect((await audit.query()).entries.some(entry => entry.status === 'unknown')).toBe(true);
  });
});

describe('bounded metadata audit adapters', () => {
  const input = (index: number): AuditInput => ({ requestId: `request-${index}`, roomId: 'room', peerId: 'peer', epoch: 'epoch', operation: 'readText', status: 'success' });
  it('bounds entries/bytes, detaches queries, paginates and rejects access after close', async () => {
    const store = new BoundedMemoryAuditStore({ maxEntries: 3, maxBytes: 700 });
    for (let index = 0; index < 10; index++) await store.append(input(index));
    const page = await store.query({ limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.oldest).toBeGreaterThan(1);
    expect(page.latest).toBe(10);
    expect((await store.query({ after: page.next })).entries.at(-1)?.seq).toBe(10);
    expect(Buffer.byteLength(JSON.stringify((await store.query()).entries))).toBeLessThanOrEqual(700);
    await store.close();
    await expect(store.append(input(11))).rejects.toBeInstanceOf(AuditError);
  });
  it('reopens a persisted KvUnit snapshot, bounds retention, never persists content', async () => {
    let persisted: unknown;
    const makeUnit = (): AuditKvUnit => ({ loadAll: async () => ({ tables: {}, global: structuredClone(persisted) }),
      putRecord: async () => {}, deleteRecord: async () => {}, setGlobal: async value => { persisted = structuredClone(value); }, close: async () => {} });
    const first = await KvAuditStore.open(makeUnit(), { maxEntries: 2 });
    await first.append({ ...input(0), outcome: { version: 'v', beforeBytes: null, afterBytes: 6, content: 'omitted' }, secret: 'NEVER_PERSIST' } as AuditInput);
    await first.close();
    expect(JSON.stringify(persisted)).not.toContain('NEVER_PERSIST');
    const reopened = await KvAuditStore.open(makeUnit(), { maxEntries: 2 });
    expect((await reopened.query()).entries[0]?.seq).toBe(1);
    await reopened.append(input(1)); await reopened.append(input(2));
    expect((await reopened.query()).entries.map(entry => entry.seq)).toEqual([2, 3]);
    await reopened.close();
  });
});
