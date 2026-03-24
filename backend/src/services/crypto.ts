import crypto from 'crypto';
import {CipherGCM, DecipherGCM} from "node:crypto";

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.SECRET_KEY;
  if (!secret) throw new Error('SECRET_KEY environment variable is not set');
  // Derive a 32-byte key using SHA-256
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(plaintext: string): string {
  const key: Buffer<ArrayBufferLike> = getKey();
  const iv: Buffer = crypto.randomBytes(12);
  const cipher: CipherGCM = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted: Buffer<ArrayBuffer> = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag: Buffer = cipher.getAuthTag();
  const payload = {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decrypt(encoded: string): string {
  const key: Buffer<ArrayBufferLike> = getKey();
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const iv: Buffer<ArrayBuffer> = Buffer.from(payload.iv, 'base64');
  const authTag: Buffer<ArrayBuffer> = Buffer.from(payload.authTag, 'base64');
  const ciphertext: Buffer<ArrayBuffer> = Buffer.from(payload.ciphertext, 'base64');
  const decipher: DecipherGCM = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
