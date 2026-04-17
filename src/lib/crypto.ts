import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// AES-256-GCM wrapper for secret-at-rest encryption.
//
// Used to encrypt API provider credentials (SendGrid, Coinsbuy, Unipayment,
// Fairpay) stored in the `api_credentials` table. The master key lives in
// the server-only env var API_CREDENTIALS_MASTER_KEY (32 random bytes,
// base64-encoded) and is never sent to clients.
//
// Ciphertext, iv, and auth_tag are stored separately as base64 strings.
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;    // GCM recommended
const KEY_LENGTH = 32;   // 256 bits

function getMasterKey(): Buffer {
  const b64 = process.env.API_CREDENTIALS_MASTER_KEY;
  if (!b64) {
    throw new Error(
      'API_CREDENTIALS_MASTER_KEY is not set. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`API_CREDENTIALS_MASTER_KEY must decode to ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  return key;
}

export interface EncryptedBundle {
  ciphertext: string;   // base64
  iv: string;           // base64
  authTag: string;      // base64
}

export function encryptSecret(plaintext: string): EncryptedBundle {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptSecret(bundle: EncryptedBundle): string {
  const key = getMasterKey();
  const iv = Buffer.from(bundle.iv, 'base64');
  const authTag = Buffer.from(bundle.authTag, 'base64');
  const ciphertext = Buffer.from(bundle.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Returns the last N chars of a secret for safe display.
 * For a SendGrid key "SG.abc...xyz", lastFour(s, 4) → "..xyz".
 */
export function lastChars(secret: string, n = 4): string {
  if (!secret) return '';
  return secret.slice(-n);
}
