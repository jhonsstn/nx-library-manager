import { safeStorage } from 'electron';
import type { SecretCipher } from '../settings/settings.store';

const PREFIX = 'enc:v1:';

/**
 * Windows/macOS-encrypted secret storage through Electron `safeStorage`
 * (spec 11: "architecture should support upgrading to Electron safeStorage").
 */
export function createSafeStorageCipher(): SecretCipher | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  return {
    encrypt(plain: string): string {
      return `${PREFIX}${safeStorage.encryptString(plain).toString('base64')}`;
    },
    decrypt(payload: string): string | null {
      if (!payload.startsWith(PREFIX)) return null;
      try {
        return safeStorage.decryptString(Buffer.from(payload.slice(PREFIX.length), 'base64'));
      } catch {
        return null;
      }
    },
  };
}
