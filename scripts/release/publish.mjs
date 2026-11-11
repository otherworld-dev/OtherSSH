// The Otherworld Services admin API, as build.mjs uses it for `--publish`: upload the
// installers, then publish the release. Kept apart so the request shapes are easy to adjust.
//
// The shapes follow the Otherworld Services `updates` admin API (v0.4.0, see its README);
// build.mjs only relies on `uploadInstaller` and `publishRelease` throwing on any failure.
//
// The token comes from OTHERWORLD_ADMIN_TOKEN, or failing that the file ~/.otherworld/admin-token,
// and is only ever sent in the Authorization header. It is never printed: every message these
// functions make has it masked.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_ENV = "OTHERWORLD_ADMIN_TOKEN";
export const TOKEN_FILE = join(homedir(), ".otherworld", "admin-token");
export const DEFAULT_API_BASE = "https://api.otherworld.dev";
export const PRODUCT = "otherssh";
export const CHANNELS = ["stable", "beta"];

/** The admin token, or an error that says how to set it (never what it is). */
export function adminToken(env = process.env, file = TOKEN_FILE) {
  let token = (env[TOKEN_ENV] || "").trim();
  if (!token && existsSync(file)) token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`--publish needs the admin token in ${TOKEN_ENV} or ${file}`);
  return token;
}

/** Checks --channel and --rollout before anything is built. Rollout is a percentage, 1 to 100. */
export function checkPublishOptions({ channel, rollout }) {
  if (!CHANNELS.includes(channel)) throw new Error(`--channel must be one of ${CHANNELS.join(", ")}, not ${channel}`);
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) {
    throw new Error(`--rollout must be a whole percentage from 1 to 100, not ${rollout}`);
  }
}

const mask = (text, token) => (token ? String(text).split(token).join("***") : String(text));

async function request(apiBase, token, method, path, { body, headers = {} } = {}) {
  const url = `${apiBase.replace(/\/+$/, "")}${path}`;
  let res;
  try {
    res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
  } catch (e) {
    throw new Error(mask(`${method} ${url} failed: ${e.cause?.message || e.message}`, token));
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(mask(`${method} ${url} answered ${res.status} ${res.statusText}: ${text.slice(0, 500)}`, token));
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/**
 * Uploads one installer so it is served at
 * `<apiBase>/downloads/otherssh/<version>/<name>`.
 *
 *   PUT /admin/api/updates/otherssh/releases/<version>/files/<name>
 *   body = the installer bytes
 *   -> 201 {"url": "...", "bytes": <n>, "sha256": "..."}; 409 if the file already exists
 */
export async function uploadInstaller({ apiBase, token, version, name, file }) {
  const bytes = readFileSync(file);
  const path = `/admin/api/updates/${PRODUCT}/releases/${encodeURIComponent(version)}/files/${encodeURIComponent(name)}`;
  const answer = await request(apiBase, token, "PUT", path, {
    body: bytes,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (Number(answer.bytes) !== bytes.length) {
    throw new Error(`upload of ${name}: the server stored ${answer.bytes} bytes, not ${bytes.length}`);
  }
  return answer;
}

/**
 * Publishes `version` on `channel` to `rollout` percent of installs. Only called once every
 * installer has uploaded.
 *
 *   POST /admin/api/updates/otherssh/releases
 *   {"version", "channel", "rollout_percent", "notes", "pub_date",
 *    "platforms": {"windows-x86_64": {"url", "signature"}}}
 *   -> 201 {"release": {...}, "replaced": false}; 409 if the version is already published
 * The server answers by `${target}-${arch}` and refuses unknown fields, so latest.json's
 * installer-specific keys (`windows-x86_64-nsis`) are left out.
 */
export async function publishRelease({ apiBase, token, manifest, channel, rollout }) {
  const platforms = Object.fromEntries(Object.entries(manifest.platforms).filter(([key]) => !key.endsWith("-nsis")));
  const body = { version: manifest.version, channel, rollout_percent: rollout, notes: manifest.notes, pub_date: manifest.pub_date, platforms };
  return request(apiBase, token, "POST", `/admin/api/updates/${PRODUCT}/releases`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Uploads every installer, in turn, then publishes. Any failed upload throws before the
 * publish request is made, so clients are never pointed at a file that isn't there.
 */
export async function publish({ apiBase, token, manifest, installers, channel, rollout, log = console.log }) {
  checkPublishOptions({ channel, rollout });
  for (const i of installers) {
    log(`release: uploading ${i.name}`);
    await uploadInstaller({ apiBase, token, version: manifest.version, name: i.name, file: i.file });
  }
  log(`release: publishing ${manifest.version} on ${channel} to ${rollout}% of installs`);
  await publishRelease({ apiBase, token, manifest, channel, rollout });
  log(`release: published ${manifest.version}`);
}
