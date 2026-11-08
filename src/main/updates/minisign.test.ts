import { describe, it, expect } from 'vitest';
import { parsePublicKey, signedFileName, verifySignature } from './minisign';

// Made with `tauri signer generate` / `tauri signer sign` (throwaway key), so this proves the
// format matches what Tauri and the Otherworld Services feed use.
const TAURI_PUB =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZGOTc2N0Q5ODk2NUU1NDYKUldSRzVXV0oyV2VYYjd0UGYzeERzQmhkaTl4WjhFS2o4NFo1bTVoQ29LaUsrYXE3d1hxc3hIYjEK';
const TAURI_SIG =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSRzVXV0oyV2VYYjVqUE02ZUFUbzBGWEhuNjhzMi9HVDgwL2Q5aE4wNExwd2E0Z2lzKyt6TEx3UUpMN1VYbXk1T3MvMUxpMEpYS3E2ekVibkFxeFkzZVEveGF6S0hUREFRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDkyMjk3CWZpbGU6cGF5bG9hZC5iaW4KSGJyNWpKSDJ4NDdsWm5SRm9Lc3lVK05LV0JXQVVBbDJUMWZLelhPVlVaUlNJZFF6TXA4T1k4VTN2Q3JBMFdtTWlscFQrWllXMmRGS3hHM3JydFJHQXc9PQo=';
const PAYLOAD = Buffer.from('OtherSSH update test payload\n');

// The release script's signer, imported by path so the app's typecheck doesn't need its types.
const signerPath = '../../../scripts/release/minisign.mjs';

describe('verifySignature', () => {
  it('accepts a signature made by the Tauri signer and returns its signed comment', () => {
    const comment = verifySignature(PAYLOAD, TAURI_SIG, parsePublicKey(TAURI_PUB));
    expect(comment).toBe('timestamp:1794092297\tfile:payload.bin');
    expect(signedFileName(comment)).toBe('payload.bin');
  });

  it('rejects a changed download', () => {
    const tampered = Buffer.from('OtherSSH update test payload!\n');
    expect(() => verifySignature(tampered, TAURI_SIG, parsePublicKey(TAURI_PUB))).toThrow(/does not match/);
  });

  it('rejects a signature from another key', async () => {
    const signer = await import(signerPath);
    const other = signer.generateKey('pw');
    expect(() => verifySignature(PAYLOAD, TAURI_SIG, parsePublicKey(other.publicKey))).toThrow(/different key/);
  });

  it('rejects an edited trusted comment', () => {
    const text = Buffer.from(TAURI_SIG, 'base64').toString('utf8').replace('file:payload.bin', 'file:other.bin');
    const edited = Buffer.from(text).toString('base64');
    expect(() => verifySignature(PAYLOAD, edited, parsePublicKey(TAURI_PUB))).toThrow(/tampered/);
  });

  it("verifies what the release script's signer makes, with a password-protected key", async () => {
    const signer = await import(signerPath);
    const generated = signer.generateKey('correct horse');
    const key = signer.loadKey(generated.text, 'correct horse');
    const sig = signer.signData(PAYLOAD, key, 'timestamp:1\tfile:OtherSSH_0.2.0_x64-setup.exe');
    expect(() => verifySignature(PAYLOAD, sig, parsePublicKey(generated.publicKey))).not.toThrow();
    expect(() => signer.loadKey(generated.text, 'wrong')).toThrow();
  });
});
