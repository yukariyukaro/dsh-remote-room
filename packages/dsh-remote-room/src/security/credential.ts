import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { createHash, createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'node:crypto';

export const CHANNEL_PROTOCOL = 'dsh-remote-room/mtls/v2';
export interface RoomCredential {
  certificate: string;
  privateKey: string;
}

/** Public, deterministic room/protocol binding; never includes private material. */
export function roomChannelBinding(roomId: string): { hostname: string; alpn: string } {
  if (typeof roomId !== 'string' || !roomId || Buffer.byteLength(roomId) > 512) {
    throw new Error('roomId must be 1..512 UTF-8 bytes');
  }
  const digest = createHash('sha256').update(JSON.stringify([CHANNEL_PROTOCOL, roomId])).digest('hex');
  return { hostname: `${digest}.dsh.invalid`, alpn: `${CHANNEL_PROTOCOL}:${digest}` };
}

/**
 * Generates a fresh bearer credential using native WebCrypto P-256. The X509
 * library only encodes/signs certificates; TLS remains wholly native. Returned
 * private PEM is sensitive and must stay in the invitation fragment/in memory.
 * JavaScript strings cannot be reliably zeroized; no disk/key-log storage occurs.
 * All invitation holders can impersonate either role, as with a shared PSK.
 */
export async function createRoomCredential(roomId: string): Promise<RoomCredential> {
  const { hostname } = roomChannelBinding(roomId);
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: `CN=${hostname}`,
    // A room ends when its host destroys it, so the certificate window must never be the
    // thing that expires a share. This is a decade-long backstop for a leaked credential;
    // access is still granted only by host approval, never by certificate validity.
    notBefore: new Date(Date.now() - 300_000),
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    // Node 24's WebCrypto KeyUsage union additionally includes post-quantum
    // encapsulation usages absent from DOM typings. These generated EC keys
    // actually contain only the sign/verify usages requested above.
    keys: keys as CryptoKeyPair,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
    ],
  }, webcrypto as Crypto);
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  try {
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const credential = { certificate: certificate.toString('pem'), privateKey };
    validateRoomCredential(roomId, credential);
    return credential;
  } finally { der.fill(0); }
}

/** Synchronous, fail-closed validation before taking ownership of TLS keys. */
export function validateRoomCredential(roomId: string, credential: RoomCredential): void {
  const { hostname } = roomChannelBinding(roomId);
  if (!credential || typeof credential.certificate !== 'string' || typeof credential.privateKey !== 'string'
    || Buffer.byteLength(credential.certificate) > 8192 || Buffer.byteLength(credential.privateKey) > 4096
    || !/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(credential.certificate)
    || !/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----\s*$/.test(credential.privateKey)) {
    throw new Error('Invalid room credential encoding');
  }
  const certificate = new X509Certificate(credential.certificate);
  const key = createPrivateKey(credential.privateKey);
  if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)
    || !certificate.checkPrivateKey(key)
    || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || certificate.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || certificate.checkHost(hostname, { subject: 'never', wildcards: false }) !== hostname
    || certificate.subject !== `CN=${hostname}`
    || !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1')
    || !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2')
    || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error('Room credential is not a valid room-bound self-signed P-256 identity');
  }
}
