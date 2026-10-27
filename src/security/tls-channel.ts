import { constants, X509Certificate } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { connect, createServer, type TLSSocket, type Server } from 'node:tls';
import { roomChannelBinding, validateRoomCredential, type RoomCredential } from './credential.js';
export { CHANNEL_PROTOCOL } from './credential.js';

export interface AuthenticateChannelOptions {
  role: 'host' | 'guest';
  roomId: string;
  credential: RoomCredential;
  timeoutMs: number;
  signal?: AbortSignal;
}

const CIPHER = 'TLS_AES_128_GCM_SHA256';
function channelError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Owns an already-connected binary Duplex. No application capability handlers may
 * be attached before this promise resolves. The native TLS engine (OpenSSL or
 * BoringSSL) owns handshake signatures, ephemeral exchange, Finished, transcript,
 * record AEAD, sequence numbers and replay protection. This API never listens on
 * a port, logs keys, accepts TLS1.2, disables certificate checks, or saves sessions.
 * Reconnects must call it again. AbortSignal applies to authentication only.
 *
 * Both roles must present the exact room invitation certificate and prove its
 * private key. Thus this is bearer invitation authentication, not device identity.
 * In TLS1.3 guest secureConnect may precede host's client-certificate acceptance;
 * only host secureConnection authorizes host capabilities. Application ready/RPC
 * acknowledgments, not this transport promise, confirm that the peer accepted us.
 */
export async function authenticateChannel(
  transport: Duplex,
  options: AuthenticateChannelOptions,
): Promise<TLSSocket> {
  let socket: TLSSocket | undefined;
  try {
    if (options.role !== 'host' && options.role !== 'guest') {
      throw channelError('Invalid channel role', 'ERR_CHANNEL_OPTIONS');
    }
    try { validateRoomCredential(options.roomId, options.credential); }
    catch { throw channelError('Invalid room credential or room binding', 'ERR_CHANNEL_OPTIONS'); }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
      throw channelError('Invalid authentication timeout', 'ERR_CHANNEL_OPTIONS');
    }
    if (options.signal?.aborted) throw channelError('Channel authentication aborted', 'ABORT_ERR');
    if (transport.destroyed || !transport.readable || !transport.writable) {
      throw channelError('Transport is not usable', 'ERR_CHANNEL_TRANSPORT');
    }
    const { hostname, alpn } = roomChannelBinding(options.roomId);
    const certificate = new X509Certificate(options.credential.certificate);
    const settings = {
      minVersion: 'TLSv1.3' as const,
      maxVersion: 'TLSv1.3' as const,
      ciphers: CIPHER,
      secureOptions: constants.SSL_OP_NO_TICKET | constants.SSL_OP_NO_RENEGOTIATION,
      key: options.credential.privateKey,
      cert: options.credential.certificate,
      ca: options.credential.certificate,
      rejectUnauthorized: true,
      ALPNProtocols: [alpn],
    };

    return await new Promise<TLSSocket>((resolve, reject) => {
      let settled = false;
      let server: Server | undefined;
      const timer = setTimeout(() => fail(channelError('Channel authentication timed out', 'ERR_CHANNEL_TIMEOUT')), options.timeoutMs);
      const clearAuthentication = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        socket?.removeListener('secureConnect', onSecure);
        server?.removeListener('secureConnection', onSecure);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearAuthentication();
        socket?.destroy();
        transport.destroy();
        reject(error);
      };
      const onError = (error: Error) => {
        if (!settled) fail(error);
        else { socket?.destroy(); transport.destroy(); }
      };
      const onAbort = () => fail(channelError('Channel authentication aborted', 'ABORT_ERR'));
      const onTransportError = (error: Error) => {
        if (!settled) fail(error);
        else socket?.destroy(error);
      };
      const onTransportClose = () => {
        if (!settled) fail(channelError('Peer closed before authentication', 'ERR_CHANNEL_CLOSED'));
        else socket?.destroy();
        transport.removeListener('error', onTransportError);
        server?.removeAllListeners();
      };
      const onSocketClose = () => {
        if (!settled) fail(channelError('Peer closed before authentication', 'ERR_CHANNEL_CLOSED'));
        transport.destroy();
        transport.removeListener('error', onTransportError);
        transport.removeListener('close', onTransportClose);
        socket?.removeListener('error', onError);
        server?.removeAllListeners();
      };
      const onSecure = (acceptedSocket?: TLSSocket) => {
        const tlsSocket = acceptedSocket ?? socket!;
        socket = tlsSocket;
        // CA trust is exact and per-invitation, never system roots. Exact DER pin
        // additionally rejects other leaves signed by the shared invitation CA.
        const peer = tlsSocket.getPeerCertificate();
        if (!tlsSocket.authorized || tlsSocket.isSessionReused()
          || tlsSocket.getProtocol() !== 'TLSv1.3'
          || tlsSocket.getCipher().standardName !== CIPHER
          || tlsSocket.alpnProtocol !== alpn
          || !peer.raw?.equals(certificate.raw)) {
          fail(channelError('TLS did not authenticate the required room identity', 'ERR_CHANNEL_AUTHENTICATION'));
          return;
        }
        if (settled) return;
        settled = true;
        clearAuthentication();
        if (options.role === 'host') {
          tlsSocket.on('error', onError);
          tlsSocket.once('close', onSocketClose);
        }
        resolve(tlsSocket);
      };
      transport.on('error', onTransportError);
      transport.once('close', onTransportClose);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      try {
        if (options.role === 'host') {
          // Standalone new TLSSocket(isServer:true) hides post-handshake SSL errors
          // behind private _tlsError events. The public Server connection path
          // releases control and provides correct ordinary error/close semantics.
          server = createServer({ ...settings, requestCert: true, handshakeTimeout: options.timeoutMs });
          server.once('secureConnection', onSecure);
          server.on('tlsClientError', (error, candidate) => { socket = candidate; fail(error); });
          server.on('error', onError);
          server.emit('connection', transport);
        } else {
          socket = connect({ ...settings, socket: transport, servername: hostname });
          socket.on('error', onError);
          socket.once('close', onSocketClose);
          socket.once('secureConnect', onSecure);
        }
      } catch (error) { fail(error instanceof Error ? error : new Error('TLS setup failed')); }
    });
  } catch (error) {
    socket?.destroy();
    transport.destroy();
    throw error;
  }
}
