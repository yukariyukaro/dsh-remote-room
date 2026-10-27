// Test-only native-runtime evidence; never reads or changes a DSH profile.
// Its ephemeral loopback TCP listener only constructs an untrusted relay pair.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto, randomBytes, createHash, X509Certificate } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import assert from 'node:assert/strict';

x509.cryptoProvider.set(webcrypto);
const protocol = 'dsh-remote-room/mtls/v2';
const room = 'test-boringssl-room';
const binding = createHash('sha256').update(JSON.stringify([protocol, room])).digest('hex');
const hostname = `${binding}.dsh.invalid`;
const alpn = `${protocol}:${binding}`;
const settings = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256' };
const pem = (type, value) => `-----BEGIN ${type}-----\n${Buffer.from(value).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${type}-----\n`;

async function credentials() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: `CN=${hostname}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
    ],
  });
  const certPem = cert.toString('pem');
  const key = pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const native = new X509Certificate(certPem);
  return { cert: certPem, key, fingerprint: native.fingerprint256, raw: native.raw };
}

async function relayPair() {
  const relay = [];
  let done;
  const ready = new Promise(resolve => { done = resolve; });
  const listener = net.createServer(socket => { relay.push(socket); socket.on('error', () => {}); if (relay.length === 2) done(); });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const raw = [];
  for (let i = 0; i < 2; i++) { const socket = net.connect(listener.address().port, '127.0.0.1'); await once(socket, 'connect'); raw.push(socket); }
  await ready;
  let corruptDirection;
  let mutated = false;
  const wire = [];
  relay.forEach((source, i) => {
    source.on('data', data => {
      const bytes = Buffer.from(data); wire.push(Buffer.from(bytes));
      if (corruptDirection === i) { bytes[bytes.length - 1] ^= 1; corruptDirection = undefined; mutated = true; }
      if (!relay[1 - i].destroyed) relay[1 - i].write(bytes);
    });
    source.on('close', () => relay[1 - i].destroy());
    source.on('end', () => relay[1 - i].end());
  });
  const transports = raw.map(socket => {
    const stream = new Duplex({
      read() { socket.resume(); },
      write(data, encoding, callback) { socket.write(data, encoding, callback); },
      final(callback) { socket.end(callback); },
      destroy(error, callback) { socket.destroy(); callback(error); },
    });
    socket.on('data', data => { if (!stream.push(data)) socket.pause(); });
    socket.on('end', () => stream.push(null));
    socket.on('close', () => stream.destroy());
    socket.on('error', error => stream.destroy(error));
    stream.on('error', () => {});
    return stream;
  });
  return {
    transports, raw, wire,
    corrupt(direction) { corruptDirection = direction; },
    get mutated() { return mutated; },
    async close() { const closed = once(listener, 'close'); transports.forEach(s => s.destroy()); raw.forEach(s => s.destroy()); relay.forEach(s => s.destroy()); listener.close(); await closed; },
  };
}

function authenticate(transport, role, own, trust = own, requestedAlpn = alpn) {
  let socket;
  let server;
  let authenticated = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(Object.assign(new Error('Handshake timeout'), { code: 'TIMEOUT' })), 2500);
    const fail = error => { clearTimeout(timer); socket?.destroy(); transport.destroy(); if (!authenticated) reject(error); };
    const complete = candidate => {
      socket = candidate;
      try {
        assert.equal(candidate.authorized, true);
        assert.equal(candidate.getProtocol(), 'TLSv1.3');
        assert.equal(candidate.getPeerCertificate().fingerprint256, trust.fingerprint);
        assert.equal(candidate.alpnProtocol, requestedAlpn);
        assert.equal(candidate.isSessionReused(), false);
        clearTimeout(timer);
        authenticated = true;
        candidate.on('error', () => { candidate.destroy(); transport.destroy(); });
        candidate.on('close', () => { transport.destroy(); server?.removeAllListeners(); });
        resolve(candidate);
      } catch (error) { fail(error); }
    };
    transport.on('error', fail);
    transport.once('close', () => { if (!authenticated) fail(Object.assign(new Error('Early close'), { code: 'CLOSED' })); else socket?.destroy(); });
    try {
      const config = { ...settings, key: own.key, cert: own.cert, ca: trust.cert, rejectUnauthorized: true, ALPNProtocols: [requestedAlpn] };
      if (role === 'host') {
        server = tls.createServer({ ...config, requestCert: true });
        server.on('tlsClientError', fail);
        server.once('secureConnection', complete);
        // No production listener. Accept one already-connected generic Duplex.
        server.emit('connection', transport);
      } else {
        socket = tls.connect({ ...config, socket: transport, servername: hostname });
        socket.on('error', fail);
        socket.once('secureConnect', () => complete(socket));
      }
    } catch (error) { fail(error); }
  });
}

async function exchange(receiver, sender, message) { const read = once(receiver, 'data'); sender.write(message); assert.equal((await read)[0].toString(), message); }
const own = await credentials();
const other = await credentials();
const results = [];

if (process.env.DSH_TLS_TEST_PRODUCTION === '1') {
  // Node24/Electron24 native TS stripping imports production source, not a mock.
  const source = await import('node:fs/promises');
  const { stripTypeScriptTypes } = await import('node:module');
  const credentialPath = new URL('../../src/security/credential.ts', import.meta.url);
  const credentialText = stripTypeScriptTypes(await source.readFile(credentialPath, 'utf8'));
  // Resolve external packages relative to this spike through absolute file URLs.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const credentialUrl = 'data:text/javascript,' + encodeURIComponent(credentialText
    .replace("'reflect-metadata'", JSON.stringify(pathToFileURL(require.resolve('reflect-metadata')).href))
    .replace("'@peculiar/x509'", JSON.stringify(pathToFileURL(require.resolve('@peculiar/x509')).href)));
  const productionCredential = await import(credentialUrl);
  const channelText = stripTypeScriptTypes(await source.readFile(new URL('../../src/security/tls-channel.ts', import.meta.url), 'utf8'));
  const production = await import('data:text/javascript,' + encodeURIComponent(channelText.replaceAll("'./credential.js'", JSON.stringify(credentialUrl))));
  const credential = await productionCredential.createRoomCredential(room);
  const pair = await relayPair();
  try {
    const sockets = await Promise.all(pair.transports.map((transport, i) => production.authenticateChannel(transport, { role: i ? 'guest' : 'host', roomId: room, credential, timeoutMs: 2500 })));
    await exchange(sockets[0], sockets[1], 'production-guest-data');
    await exchange(sockets[1], sockets[0], 'production-host-data');
    const failure = once(sockets[0], 'error');
    const closed = new Promise(resolve => sockets[0].once('close', resolve));
    pair.corrupt(1); sockets[1].write('production-tamper');
    const [error] = await failure; await closed;
    assert.match(error.code, /SSL/); assert(pair.transports[0].destroyed);
    results.push({ test: 'production-credential+channel-native-runtime', passed: true, code: error.code });
    sockets.forEach(socket => socket.destroy());
  } finally { await pair.close(); }
}

{
  const pair = await relayPair();
  try {
    const [host, guest] = await Promise.all(pair.transports.map((stream, i) => authenticate(stream, i ? 'guest' : 'host', own)));
    await exchange(host, guest, 'private-guest-message'); await exchange(guest, host, 'private-host-message');
    const capture = Buffer.concat(pair.wire).toString();
    assert(!capture.includes('private-guest-message')); assert(!capture.includes('private-host-message'));
    results.push({ test: 'generic-Duplex-TLS13-mutual-auth+data', passed: true, authorized: [host.authorized, guest.authorized], cipher: host.getCipher().standardName });
    host.destroy(); guest.destroy();
  } finally { await pair.close(); }
}

for (const variant of ['different-invite', 'untrusted-client', 'wrong-alpn']) {
  const pair = await relayPair();
  try {
    const handshakes = await Promise.allSettled([
      authenticate(pair.transports[0], 'host', own),
      authenticate(pair.transports[1], 'guest', variant === 'wrong-alpn' ? own : other, variant === 'untrusted-client' || variant === 'wrong-alpn' ? own : other, variant === 'wrong-alpn' ? `${alpn}-wrong` : alpn),
    ]);
    // TLS1.3 client secureConnect can precede server client-cert rejection.
    // Host must never expose capabilities until its secureConnection gate.
    assert.equal(handshakes[0].status, 'rejected');
    for (const result of handshakes) if (result.status === 'fulfilled') result.value.destroy();
    results.push({ test: variant, passed: true, outcomes: handshakes.map(result => result.status === 'rejected' ? result.reason.code ?? result.reason.message : 'client-secure-before-server-reject') });
  } finally { await pair.close(); }
}

for (const direction of [0, 1]) {
  const pair = await relayPair();
  try {
    const sockets = await Promise.all(pair.transports.map((stream, i) => authenticate(stream, i ? 'guest' : 'host', own)));
    const sender = sockets[direction]; const receiver = sockets[1 - direction];
    await exchange(receiver, sender, 'warmup');
    const plaintext = []; receiver.on('data', data => plaintext.push(data));
    const failure = once(receiver, 'error');
    const closed = new Promise(resolve => receiver.once('close', resolve));
    pair.corrupt(direction); sender.write('do-not-deliver');
    const [error] = await failure; await closed;
    assert.match(error.code, /SSL/); assert.equal(pair.mutated, true); assert.deepEqual(plaintext, []); assert(receiver.destroyed); assert(pair.transports[1 - direction].destroyed);
    results.push({ test: `tamper-direction-${direction}`, passed: true, code: error.code });
    sockets.forEach(socket => socket.destroy());
  } finally { await pair.close(); }
}

console.log(JSON.stringify({ runtime: process.versions, library: '@peculiar/x509@2.2.0 + reflect-metadata@0.2.2', certificateBytes: own.raw.length, privatePemBytes: Buffer.byteLength(own.key), invitationCredentialBase64urlBytes: Buffer.from(JSON.stringify({cert:own.cert,key:own.key})).toString('base64url').length, results }, null, 2));
