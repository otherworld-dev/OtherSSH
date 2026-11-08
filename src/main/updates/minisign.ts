import { createPublicKey, verify } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';

// Update installers are signed in minisign's format, the same one Tauri's
// updater and the Otherworld Services feed use: the feed's `signature` is the
// base64 of a whole .sig file, and the app carries the base64 of the matching
// public key file. Electron's BoringSSL has Ed25519 but not BLAKE2b, hence noble.

export interface PublicKey {
  keyId: Buffer;
  key: Buffer;
}

const b64lines = (b64: string): string[] => Buffer.from(b64.trim(), 'base64').toString('utf8').split(/\r?\n/);

/** The base64 of a minisign public key file (two lines: a comment, then "Ed" + key id + key). */
export function parsePublicKey(b64: string): PublicKey {
  const raw = Buffer.from(b64lines(b64)[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') throw new Error('Not a minisign public key');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

function ed25519(key: Buffer, message: Uint8Array, signature: Uint8Array): boolean {
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') }, format: 'jwk' });
  return verify(null, message, publicKey, signature);
}

/**
 * Check `data` against the base64 of a minisign .sig file. Throws with a reason
 * unless both the file signature and the signed trusted comment are good, and
 * returns the trusted comment (signed, so safe to read the file name from).
 */
export function verifySignature(data: Uint8Array, signatureB64: string, publicKey: PublicKey): string {
  const lines = b64lines(signatureB64);
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = lines[2] ?? '';
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (sig.length !== 74 || !trusted.startsWith('trusted comment: ') || global.length !== 64) {
    throw new Error('The update signature is not in the expected format');
  }
  const algorithm = sig.toString('latin1', 0, 2);
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('The update signature uses an unknown algorithm');
  if (!sig.subarray(2, 10).equals(publicKey.keyId)) throw new Error('The update was signed with a different key');

  const signature = sig.subarray(10);
  const signed = algorithm === 'ED' ? blake2b(data, { dkLen: 64 }) : data; // "ED" signs the BLAKE2b-512 of the file
  if (!ed25519(publicKey.key, signed, signature)) throw new Error('The update signature does not match the download');
  const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf8');
  if (!ed25519(publicKey.key, Buffer.concat([signature, comment]), global)) {
    throw new Error('The update signature has been tampered with');
  }
  return comment.toString('utf8');
}

/** The `file:` field of a trusted comment (`timestamp:1794092297<tab>file:OtherSSH_0.2.0_x64-setup.exe`). */
export function signedFileName(trustedComment: string): string | undefined {
  return trustedComment
    .split('\t')
    .find((f) => f.startsWith('file:'))
    ?.slice('file:'.length);
}
