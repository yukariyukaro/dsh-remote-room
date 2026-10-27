import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import net, { type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRoomCredential, validateRoomCredential, roomChannelBinding, type RoomCredential } from '../../src/security/credential.js';
let primary: RoomCredential;
let secondary: RoomCredential;
beforeAll(async () => { primary = await createRoomCredential('test-room'); secondary = await createRoomCredential('test-room'); });
import { authenticateChannel, type AuthenticateChannelOptions } from '../../src/security/tls-channel.js';

// The relay is deliberately test-only and untrusted: it sees TLS ciphertext and
// can alter/drop it, but never receives a secret or participates in TLS.
async function relayPair() {
  const accepted: Socket[] = [];
  let ready!: () => void;
  const bothAccepted = new Promise<void>(resolve => { ready = resolve; });
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    accepted.push(socket);
    if (accepted.length === 2) ready();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  const first = net.connect(address.port, '127.0.0.1');
  await once(first, 'connect');
  const second = net.connect(address.port, '127.0.0.1');
  await once(second, 'connect');
  await bothAccepted;
  const raw: [Socket, Socket] = [first, second];
  for (const socket of raw) socket.on('error', () => {});
  let corruptNext = false;
  let corruptDirection: number | undefined;
  let drop = false;
  let mutated = false;
  const wire: Buffer[] = [];
  accepted.forEach((source, i) => {
    source.on('data', data => {
      const bytes = Buffer.from(data);
      wire.push(Buffer.from(bytes));
      if (drop) return;
      if (corruptNext && (corruptDirection === undefined || corruptDirection === i)) {
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        corruptNext = false;
        mutated = true;
      }
      if (!accepted[1 - i]!.destroyed) accepted[1 - i]!.write(bytes);
    });
    source.on('end', () => accepted[1 - i]!.end());
    source.on('close', () => accepted[1 - i]!.destroy());
  });
  // These are NOT net.Socket objects. Exercise the generic Duplex path that a
  // future WSS relay stream uses, including underlying transport destruction.
  const transports = raw.map(socket => {
    const stream = new Duplex({
      read() { socket.resume(); },
      write(chunk, encoding, callback) { socket.write(chunk, encoding, callback); },
      final(callback) { socket.end(callback); },
      destroy(error, callback) { socket.destroy(); callback(error); },
    });
    socket.on('data', data => { if (!stream.push(data)) socket.pause(); });
    socket.on('end', () => stream.push(null));
    socket.on('close', () => stream.destroy());
    socket.on('error', error => stream.destroy(error));
    stream.on('error', () => {});
    return stream;
  }) as [Duplex, Duplex];
  return {
    transports, raw, accepted, wire,
    corrupt(direction?: number) { corruptNext = true; corruptDirection = direction; },
    drop() { drop = true; },
    get mutated() { return mutated; },
    async close() {
      const closed = once(server, 'close');
      transports.forEach(socket => socket.destroy());
      raw.forEach(socket => socket.destroy());
      accepted.forEach(socket => socket.destroy());
      server.close();
      await closed;
    },
  };
}

const base = (credential: RoomCredential, role: 'host' | 'guest'): AuthenticateChannelOptions => ({
  role, roomId: 'test-room', credential, timeoutMs: 2_000,
});

async function authenticatedPair(pair: Awaited<ReturnType<typeof relayPair>>, credential = primary) {
  return Promise.all([
    authenticateChannel(pair.transports[0], base(credential, 'host')),
    authenticateChannel(pair.transports[1], base(credential, 'guest')),
  ]);
}

async function readOne(socket: TLSSocket, data: string, writer: TLSSocket) {
  const received = once(socket, 'data');
  writer.write(data);
  const [chunk] = await received;
  return chunk.toString();
}

describe('TLS 1.3 pinned invitation mTLS over an untrusted Duplex relay', () => {
  it('authenticates both endpoints with the exact invitation certificate and encrypts bidirectional data', async () => {
    const pair = await relayPair();
    try {
      const [host, guest] = await authenticatedPair(pair);
      for (const socket of [host, guest]) {
        expect(socket.getProtocol()).toBe('TLSv1.3');
        expect(socket.getCipher().standardName).toBe('TLS_AES_128_GCM_SHA256');
        expect(socket.authorized).toBe(true);
        expect(socket.getPeerCertificate().raw.equals(new X509Certificate(primary.certificate).raw)).toBe(true);
        expect(socket.isSessionReused()).toBe(false);
        expect(socket.alpnProtocol).toBe(roomChannelBinding('test-room').alpn);
      }
      expect(guest.authorized).toBe(true); // rejectUnauthorized was never disabled.
      expect(await readOne(host, 'guest-private-message', guest)).toBe('guest-private-message');
      expect(await readOne(guest, 'host-private-message', host)).toBe('host-private-message');
      const captured = Buffer.concat(pair.wire).toString('utf8');
      expect(captured).not.toContain('guest-private-message');
      expect(captured).not.toContain('host-private-message');
      host.destroy(); guest.destroy();
    } finally { await pair.close(); }
  });

  it('rejects a different invitation credential and releases both transports', async () => {
    const pair = await relayPair();
    try {
      const results = await Promise.allSettled([
        authenticateChannel(pair.transports[0], base(primary, 'host')),
        authenticateChannel(pair.transports[1], base(secondary, 'guest')),
      ]);
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(pair.transports.every(stream => stream.destroyed)).toBe(true);
      expect(pair.raw.every(stream => stream.destroyed)).toBe(true);
    } finally { await pair.close(); }
  });

  it('rejects an invitation certificate bound to a different room', async () => {
    const pair = await relayPair();
    const secret = primary;
    try {
      const results = await Promise.allSettled([
        authenticateChannel(pair.transports[0], base(secret, 'host')),
        authenticateChannel(pair.transports[1], { ...base(secret, 'guest'), roomId: 'other-room' }),
      ]);
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(pair.transports.every(stream => stream.destroyed)).toBe(true);
    } finally { await pair.close(); }
  });

  it('does not accept a guest-to-guest role reflection', async () => {
    const pair = await relayPair();
    const secret = primary;
    try {
      const results = await Promise.allSettled(pair.transports.map(stream => authenticateChannel(stream, base(secret, 'guest'))));
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(pair.transports.every(stream => stream.destroyed)).toBe(true);
    } finally { await pair.close(); }
  });

  it('times out an inert peer and destroys its underlying raw stream', async () => {
    const pair = await relayPair();
    try {
      await expect(authenticateChannel(pair.transports[0], {
        ...base(primary, 'host'), timeoutMs: 30,
      })).rejects.toMatchObject({ code: 'ERR_CHANNEL_TIMEOUT' });
      expect(pair.transports[0].destroyed).toBe(true);
      expect(pair.raw[0].destroyed).toBe(true);
    } finally { await pair.close(); }
  });

  it.each([false, true])('aborts authentication and clears resources (already aborted=%s)', async alreadyAborted => {
    const pair = await relayPair();
    const controller = new AbortController();
    try {
      if (alreadyAborted) controller.abort();
      const pending = authenticateChannel(pair.transports[0], {
        ...base(primary, 'host'), signal: controller.signal,
      });
      if (!alreadyAborted) controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
      expect(pair.transports[0].destroyed).toBe(true);
      expect(pair.raw[0].destroyed).toBe(true);
    } finally { await pair.close(); }
  });

  it('rejects early peer closure without waiting for the handshake timeout', async () => {
    const pair = await relayPair();
    try {
      const pending = authenticateChannel(pair.transports[0], base(primary, 'host'));
      pair.transports[1].destroy();
      await expect(pending).rejects.toMatchObject({ code: 'ERR_CHANNEL_CLOSED' });
      expect(pair.transports[0].destroyed).toBe(true);
    } finally { await pair.close(); }
  });

  it('fails authentication if the relay changes handshake bytes', async () => {
    const pair = await relayPair();
    try {
      pair.corrupt();
      const results = await Promise.allSettled([
        authenticateChannel(pair.transports[0], base(primary, 'host')),
        authenticateChannel(pair.transports[1], base(primary, 'guest')),
      ]);
      expect(pair.mutated).toBe(true);
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    } finally { await pair.close(); }
  });

  it.each([0, 1])('rejects corrupted records from endpoint %s without releasing their plaintext', async senderIndex => {
    const pair = await relayPair();
    try {
      const sockets = await authenticatedPair(pair);
      const sender = sockets[senderIndex]!;
      const receiver = sockets[1 - senderIndex]!;
      // Flush any post-handshake control records before arming the mutation.
      expect(await readOne(receiver, 'warmup', sender)).toBe('warmup');
      const delivered: Buffer[] = [];
      receiver.on('data', data => delivered.push(data));
      const error = once(receiver, 'error');
      const closed = new Promise<void>(resolve => receiver.once('close', resolve));
      pair.corrupt(senderIndex);
      sender.write('never-deliver-tampered-record');
      const [failure] = await error;
      expect(failure.code).toMatch(/ERR_SSL/);
      await closed;
      expect(pair.mutated).toBe(true);
      expect(delivered).toEqual([]);
      expect(receiver.destroyed).toBe(true);
      expect(pair.transports[1 - senderIndex]!.destroyed).toBe(true);
      sockets.forEach(socket => socket.destroy());
    } finally { await pair.close(); }
  });

  it('performs a fresh handshake and fresh traffic keys on reconnect', async () => {
    const secret = primary;
    const captured: Buffer[] = [];
    const exporter: Buffer[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const pair = await relayPair();
      try {
        const [host, guest] = await authenticatedPair(pair, secret);
        const hostBinding = host.exportKeyingMaterial(32, 'test-only-channel-binding', Buffer.alloc(0));
        const guestBinding = guest.exportKeyingMaterial(32, 'test-only-channel-binding', Buffer.alloc(0));
        expect(hostBinding.equals(guestBinding)).toBe(true);
        exporter.push(hostBinding);
        expect(await readOne(host, 'fresh-connection', guest)).toBe('fresh-connection');
        captured.push(Buffer.concat(pair.wire));
        host.destroy(); guest.destroy();
      } finally { await pair.close(); }
    }
    expect(exporter[0]!.equals(exporter[1]!)).toBe(false);
    expect(captured[0]!.equals(captured[1]!)).toBe(false);
    exporter.forEach(buffer => buffer.fill(0));
  });

  it('rejects a TLS 1.3 client without the invitation certificate', async () => {
    const pair = await relayPair();
    try {
      const server = authenticateChannel(pair.transports[0], base(primary, 'host'));
      const binding = roomChannelBinding('test-room');
      const client = tls.connect({ socket: pair.transports[1], minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true,
        ca: primary.certificate, servername: binding.hostname, ALPNProtocols: [binding.alpn] });
      const clientError = once(client, 'error');
      await expect(server).rejects.toBeInstanceOf(Error);
      await clientError;
      expect(pair.transports[0].destroyed).toBe(true);
      client.destroy();
    } finally { await pair.close(); }
  });

  it('rejects a TLS 1.2 downgrade attempt', async () => {
    const pair = await relayPair();
    try {
      const server = authenticateChannel(pair.transports[0], base(primary, 'host'));
      const client = tls.connect({ socket: pair.transports[1], minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', rejectUnauthorized: true });
      const clientError = once(client, 'error');
      await expect(server).rejects.toBeInstanceOf(Error);
      await clientError;
      expect(pair.transports[0].destroyed).toBe(true);
      client.destroy();
    } finally { await pair.close(); }
  });

  it('aborts a stalled two-ended handshake and refuses both endpoints', async () => {
    const pair = await relayPair();
    const controller = new AbortController();
    const secret = primary;
    try {
      pair.drop();
      const host = authenticateChannel(pair.transports[0], { ...base(secret, 'host'), signal: controller.signal });
      const guest = authenticateChannel(pair.transports[1], base(secret, 'guest'));
      const results = Promise.allSettled([host, guest]);
      controller.abort();
      expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(pair.transports.every(stream => stream.destroyed)).toBe(true);
      expect(pair.raw.every(stream => stream.destroyed)).toBe(true);
    } finally { await pair.close(); }
  });

  it('rejects a mismatched invitation private key and destroys the transport', async () => {
    const pair = await relayPair();
    try {
      await expect(authenticateChannel(pair.transports[0], base({ ...primary, privateKey: secondary.privateKey }, 'host')))
        .rejects.toMatchObject({ code: 'ERR_CHANNEL_OPTIONS' });
      expect(pair.transports[0].destroyed).toBe(true);
    } finally { await pair.close(); }
  });

  it('generates fresh self-signed P-256 credentials bound to their room and protocol', async () => {
    expect(() => validateRoomCredential('test-room', primary)).not.toThrow();
    expect(() => validateRoomCredential('other-room', primary)).toThrow();
    expect(() => validateRoomCredential('test-room', { ...primary, certificate: secondary.certificate })).toThrow();
    expect(primary.certificate).not.toBe(secondary.certificate);
    expect(primary.privateKey).not.toBe(secondary.privateKey);
    const cert = new X509Certificate(primary.certificate);
    expect(cert.ca).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(cert.verify(cert.publicKey)).toBe(true);
  });
});
