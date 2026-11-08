// Minisign-format keys and signatures for update installers, in plain Node so a release needs
// no extra tools. The format matches Tauri's updater and the Otherworld Services feed:
// signatures are prehashed ("ED": Ed25519 over the BLAKE2b-512 of the file), and both the
// public key and the signature travel as the base64 of their whole text file.
// The app's side of this is src/main/updates/minisign.ts.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const keyIdHex = (keyId) => Buffer.from(keyId).reverse().toString("hex").toUpperCase();

function rawPublicKey(privateKey) {
  return Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
}

/** The base64 of the public key file, as the app embeds it. */
export function publicKeyB64({ keyId, privateKey }) {
  const raw = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPublicKey(privateKey)]);
  return b64(`untrusted comment: minisign public key: ${keyIdHex(keyId)}\n${raw.toString("base64")}\n`);
}

/** A new key: the key file's text (the private key encrypted with `password`) and the public key. */
export function generateKey(password) {
  if (!password) throw new Error("a password is needed to protect the key");
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const file = {
    comment: "OtherSSH updater signing key. Keep it secret and backed up; see scripts/release/README.md.",
    keyId: keyId.toString("hex"),
    secretKey: privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: password }),
  };
  return { text: `${JSON.stringify(file, null, 2)}\n`, publicKey: publicKeyB64({ keyId, privateKey }) };
}

export function loadKey(text, password) {
  const file = JSON.parse(text);
  const keyId = Buffer.from(file.keyId, "hex");
  if (keyId.length !== 8) throw new Error("the key file has no valid key id");
  const privateKey = createPrivateKey({ key: file.secretKey, format: "pem", passphrase: password });
  return { keyId, privateKey };
}

/** The base64 of a .sig file for `data`. */
export function signData(data, key, trustedComment) {
  const signature = sign(null, blake2b(data, { dkLen: 64 }), key.privateKey);
  const sigLine = Buffer.concat([Buffer.from("ED", "latin1"), key.keyId, signature]).toString("base64");
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), key.privateKey);
  return b64(
    `untrusted comment: signature from OtherSSH updater key\n${sigLine}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`,
  );
}
