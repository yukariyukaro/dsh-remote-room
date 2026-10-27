import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

// This diagnostic deliberately exercises the requested direct TLSSocket server
// constructor. Production uses createServer's public lifecycle instead: direct
// server TLSSockets suppress post-handshake SSL errors into private _tlsError.
const mode = process.argv[2] ?? 'strict';
assert(['strict', 'wrong', 'reject'].includes(mode));
let serverAuthenticated = false;
let clientAuthenticated = false;
let hostReceived = false;
let guestReceived = false;
const failures = [];
const key = randomBytes(32);
const sockets = new Set();
const settings = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256' };
const context = tls.createSecureContext(settings);
const server = net.createServer(raw => {
  sockets.add(raw);
  const channel = new tls.TLSSocket(raw, {
    ...settings,
    isServer: true,
    secureContext: context,
    pskCallback(socket, identity) {
      console.log('server psk identity', identity);
      return identity === 'spike:guest-to-host' && mode !== 'reject' ? key : null;
    },
  });
  sockets.add(channel);
  channel.on('error', e => { failures.push(e.code); console.log('server error', e.code, e.message); });
  channel.on('secure', () => {
    serverAuthenticated = true;
    assert.equal(channel.getProtocol(), 'TLSv1.3');
    assert.equal(channel.isSessionReused(), true);
    assert.deepEqual(channel.getPeerCertificate(), {});
    console.log('server secure', channel.getProtocol(), channel.getCipher(), channel.authorized,
      'peerCert', JSON.stringify(channel.getPeerCertificate()));
    channel.write('host hello');
  });
  channel.on('data', d => { hostReceived = true; console.log('server received', d.toString()); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const raw = net.connect(server.address().port, '127.0.0.1');
sockets.add(raw);
await once(raw, 'connect');
const client = tls.connect({
  ...settings,
  socket: raw,
  rejectUnauthorized: true,
  pskCallback() { console.log('client psk callback'); return { identity: 'spike:guest-to-host', psk: mode === 'wrong' ? randomBytes(32) : key }; },
});
sockets.add(client);
client.on('error', e => { failures.push(e.code); console.log('client error', e.code, e.message); });
client.on('secureConnect', () => {
  clientAuthenticated = true;
  assert.equal(client.authorized, true);
  assert.equal(client.getProtocol(), 'TLSv1.3');
  assert.equal(client.isSessionReused(), true);
  assert.deepEqual(client.getPeerCertificate(), {});
  console.log('client secureConnect', client.getProtocol(), client.getCipher(), client.authorized,
    client.authorizationError, 'peerCert', JSON.stringify(client.getPeerCertificate()));
  client.write('guest hello');
});
client.on('data', d => { guestReceived = true; console.log('client received', d.toString()); });
await new Promise(resolve => setTimeout(resolve, 300));
for (const socket of sockets) socket.destroy();
server.close();
key.fill(0);
if (mode === 'strict') {
  assert(serverAuthenticated && clientAuthenticated && hostReceived && guestReceived);
  assert.equal(failures.length, 0);
} else {
  assert(!serverAuthenticated && !clientAuthenticated && !hostReceived && !guestReceived);
  assert(failures.length > 0);
}
console.log(JSON.stringify({ mode, node: process.version, openssl: process.versions.openssl,
  serverAuthenticated, clientAuthenticated, hostReceived, guestReceived, failures, result: 'PASS' }));
