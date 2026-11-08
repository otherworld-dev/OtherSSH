// Makes the updater signing key, once. See scripts/release/README.md.
//
//   node scripts/release/keygen.mjs
//
// Writes the private key, encrypted, to %USERPROFILE%\.otherworld\otherssh-updater.key with a
// random password in otherssh-updater.key.password.txt next to it, and the public key to
// src/main/updates/public-key.ts. Refuses to replace an existing key: installed copies only
// accept updates signed with the key they were built with, so a new one strands them.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateKey } from "./minisign.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keyFile = resolve(process.env.OTHERSSH_UPDATER_KEY || join(homedir(), ".otherworld", "otherssh-updater.key"));
const passwordFile = `${keyFile}.password.txt`;

if (existsSync(keyFile)) {
  throw new Error(`${keyFile} already exists. Delete it yourself only if no released copy uses it.`);
}

const password = randomBytes(24).toString("base64url");
const { text, publicKey } = generateKey(password);
mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
writeFileSync(keyFile, text, { flag: "wx", mode: 0o600 });
writeFileSync(passwordFile, `${password}\n`, { flag: "wx", mode: 0o600 });
// Windows ignores those modes: drop the inherited ACL and leave only this account.
if (process.platform === "win32") {
  for (const f of [keyFile, passwordFile]) {
    execFileSync("icacls", [f, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { stdio: "ignore" });
  }
}

const publicKeyFile = join(root, "src", "main", "updates", "public-key.ts");
writeFileSync(
  publicKeyFile,
  `// Made by scripts/release/keygen.mjs: the base64 of the minisign public key file. Installers\n` +
    `// must be signed with the matching private key (kept outside the repo) or the app refuses them.\n` +
    `export const UPDATE_PUBLIC_KEY =\n  '${publicKey}';\n`,
);

console.log(`keygen: private key  -> ${keyFile}`);
console.log(`keygen: its password -> ${passwordFile}`);
console.log(`keygen: public key   -> ${publicKeyFile}`);
console.log("keygen: back both private files up somewhere safe now, such as a password manager.");
