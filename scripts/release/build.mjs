// Builds a signed release and the files the auto-updater reads. See scripts/release/README.md.
//
//   node scripts/release/build.mjs [--notes "What changed" | --notes-file notes.md]
//                                  [--base-url https://api.otherworld.dev/downloads/otherssh]
//                                  [--out dist/updates]
//                                  [--publish [--channel stable|beta] [--rollout 1-100]]
//
// 1. Builds the app (electron-vite) and the NSIS installer (electron-builder).
// 2. Signs the installer with the updater key (minisign format, as OtherLook's), from the file
//    in OTHERSSH_UPDATER_KEY or ~/.otherworld/otherssh-updater.key, with its password from
//    OTHERSSH_UPDATER_KEY_PASSWORD or <key file>.password.txt. Neither is ever printed.
// 3. Copies the installer to <out>/<version>/ and writes <out>/latest.json, the manifest.
// 4. With --publish, uploads the installer to Otherworld Services and then publishes the
//    release on --channel (default stable) to --rollout percent of installs (default 100),
//    through publish.mjs. A failed upload stops it before anything is published. The admin
//    token comes from OTHERWORLD_ADMIN_TOKEN, is never printed, and is checked before building.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadKey, signData } from "./minisign.mjs";
import { adminToken, checkPublishOptions, DEFAULT_API_BASE, PRODUCT, publish } from "./publish.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const apiBase = (process.env.OTHERWORLD_API_BASE || DEFAULT_API_BASE).replace(/[/]+$/, "");
  const opts = {
    apiBase,
    downloadsBase: `${apiBase}/downloads/${PRODUCT}`,
    baseUrl: "",
    notes: "",
    out: join(root, "dist", "updates"),
    publish: false,
    channel: "stable",
    rollout: 100,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--base-url") opts.baseUrl = value();
    else if (a === "--notes") opts.notes = value();
    else if (a === "--notes-file") opts.notes = readFileSync(value(), "utf8").trim();
    else if (a === "--out") opts.out = resolve(value());
    else if (a === "--publish") opts.publish = true;
    else if (a === "--channel" || a === "--rollout") {
      const v = value().trim();
      if (a === "--channel") opts.channel = v.toLowerCase();
      else opts.rollout = Number(v.replace(/%$/, ""));
      opts.publishFlags = true;
    } else throw new Error(`unknown option ${a}`);
  }
  opts.baseUrl = (opts.baseUrl || opts.downloadsBase).replace(/[/]+$/, "");
  return opts;
}

function signingKey() {
  const keyFile = process.env.OTHERSSH_UPDATER_KEY || join(homedir(), ".otherworld", "otherssh-updater.key");
  if (!existsSync(keyFile)) throw new Error(`no updater signing key at ${keyFile}: see scripts/release/README.md`);
  const pwFile = `${keyFile}.password.txt`;
  const password = process.env.OTHERSSH_UPDATER_KEY_PASSWORD ?? (existsSync(pwFile) ? readFileSync(pwFile, "utf8").trim() : "");
  try {
    return loadKey(readFileSync(keyFile, "utf8"), password);
  } catch {
    throw new Error(`couldn't open the updater key at ${keyFile}: is the password right?`);
  }
}

function run(script, args) {
  console.log(`release: ${script} ${args.join(" ")}`.trim());
  execFileSync(process.execPath, [join(root, "node_modules", ...script.split("/")), ...args], { cwd: root, stdio: "inherit" });
}

const opts = parseArgs(process.argv.slice(2));
// Everything that could fail late is checked before the build.
let token = null;
if (opts.publish) {
  checkPublishOptions(opts);
  token = adminToken();
  if (opts.baseUrl !== opts.downloadsBase) {
    throw new Error(`--publish uploads to ${opts.downloadsBase}, so --base-url (${opts.baseUrl}) can't point elsewhere`);
  }
} else if (opts.publishFlags) {
  throw new Error("--channel and --rollout only apply with --publish");
}
const key = signingKey();

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
run("electron-vite/bin/electron-vite.js", ["build"]);
run("electron-builder/cli.js", ["--win", "nsis", "--x64"]);

// electron-builder.yml names it like OtherLook's: OtherSSH_<version>_x64-setup.exe
const name = `OtherSSH_${version}_x64-setup.exe`;
const built = join(root, "dist", name);
if (!existsSync(built)) throw new Error(`the build didn't write ${built}`);

const bytes = readFileSync(built);
const signature = signData(bytes, key, `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${name}`);
writeFileSync(`${built}.sig`, `${signature}\n`);

mkdirSync(join(opts.out, version), { recursive: true });
const file = join(opts.out, version, name);
copyFileSync(built, file);
const entry = { signature, url: `${opts.baseUrl}/${version}/${encodeURIComponent(name)}` };
const manifest = {
  version,
  notes: opts.notes || `OtherSSH ${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: { "windows-x86_64": entry },
};
writeFileSync(join(opts.out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release: ${name} signed -> ${join(opts.out, version)}`);
console.log(`release: wrote ${join(opts.out, "latest.json")} for ${version}`);

if (opts.publish) {
  await publish({ apiBase: opts.apiBase, token, manifest, installers: [{ name, file }], channel: opts.channel, rollout: opts.rollout });
}
