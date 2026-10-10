// Encryption of custodial wallet secret keys at rest: AES-256-GCM with a key from the
// environment. The gallery ID and public key are bound as associated data, so an
// encrypted secret cannot be moved to another gallery's row and still decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;

export function encryptSecret(key: Buffer, secret: Uint8Array, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(key: Buffer, blob: Buffer, aad: string): Uint8Array {
  if (blob[0] !== VERSION) throw new Error('unknown wallet secret format');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]));
}
