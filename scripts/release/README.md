# Releasing OtherSSH

These scripts build a signed Windows installer and publish it to the Otherworld Services update
feed, which OtherSSH checks for updates. The updater is a port of OtherLook's (see its
`scripts/release/README.md`): the same feed, the same minisign signatures, the
same channels and staged rollouts, and the same rules for installing quietly. The code is in
`src/main/updates/`.

| File | What it does |
| --- | --- |
| `build.mjs` | Builds the app and installer, signs the installer for the updater, writes `latest.json` and, with `--publish`, uploads and publishes the release |
| `publish.mjs` | The Otherworld Services admin API calls `--publish` makes (upload, then publish) |
| `minisign.mjs` | Makes keys and signatures in minisign's format, in plain Node |
| `keygen.mjs` | Makes the updater signing key, once |

## The updater key

The private key lives outside the repo at `%USERPROFILE%\.otherworld\otherssh-updater.key`,
encrypted, with its password in `otherssh-updater.key.password.txt` next to it. Both files are
readable only by your Windows account. The public key is built into the app in
`src/main/updates/public-key.ts`.

Back both files up somewhere safe, such as a password manager. If the private key is lost,
installed copies can no longer be updated, as they only accept installers signed with it, and
everyone would have to reinstall by hand. Never commit either file or paste them anywhere.
`keygen.mjs` refuses to replace an existing key for the same reason.

For CI, put the key file somewhere and set `OTHERSSH_UPDATER_KEY` to its path and
`OTHERSSH_UPDATER_KEY_PASSWORD` to its password as secrets.

## Making a release

1. Bump `version` in `package.json`. This is the version the updater compares, and a published
   version can't be published again.
2. Build:

   ```
   node scripts/release/build.mjs --notes "Short summary of what changed"
   ```

   This runs `electron-vite build` and `electron-builder --win nsis --x64`, signs
   `dist/OtherSSH_<version>_x64-setup.exe` (the `.sig` is written next to it) and writes
   `dist/updates/latest.json` and `dist/updates/<version>/OtherSSH_<version>_x64-setup.exe`.
   Use `--notes-file` for longer notes. The notes appear in the "OtherSSH was updated" message
   after the update installs.
3. Publish. Add `--publish` to upload the installer to Otherworld Services and then publish the
   release:

   ```
   set OTHERWORLD_ADMIN_TOKEN=...
   node scripts/release/build.mjs --notes "Short summary" --publish --channel beta --rollout 25
   ```

   `--channel` is `stable` (the default) or `beta`; `--rollout` is the percentage of installs
   offered the release (1 to 100, default 100), which the feed decides from each copy's install
   id. The release is only published once the upload has succeeded, so no copy is ever pointed
   at a file that isn't there. The token is only sent in the `Authorization` header and never
   printed, and `--publish` checks it, `--channel` and `--rollout` before building.

   Widen a staged rollout or pull a bad release from the "Desktop updates" section of the
   Otherworld Services admin page, or with its CLI
   (`npm run keys -- rollout|yank|unyank --app otherssh --version <v>`).

The feed only answers for apps it knows, so `otherssh` has to be listed in `UPDATE_APPS`
(`src/services/updates/apps.ts` in Otherworld Services) and deployed before the first publish.

## How updates install

The "Updates" setting (Settings, Updates) decides what happens once an update has downloaded
and its signature has been checked:

| Setting | What happens |
| --- | --- |
| Install automatically (the default) | The installer runs quietly (`/S`, no window, and no UAC prompt for a per-user install). It installs when you close OtherSSH, without starting it again, or while you are away with no connections open, and then starts OtherSSH again. Settings shows a status line and "Restart now". |
| Download and ask me | A message offers "Restart to update". |
| Don't check | No checks unless you choose "Check for updates". |

The one real difference from OtherLook is that an install while you are away never happens with
a connection open, as restarting would drop it, and neither does one during an upload or with a
dialog open. "Restart now" asks first if connections are open. Otherwise the rules are the same,
and are `idleInstall`, `quitInstall` and `manualInstall` in `src/main/updates/rules.ts`, with a
test for each condition:

- Away means no input to the PC for 20 minutes, or the session locked for 2 minutes (Electron's
  `powerMonitor` reports locks, unlocks, sleep and wake). An unlock or a wake from sleep starts
  the wait again, so a timer that ran on through a sleep can't fire as you start typing.
- After an unlock or a wake, if the last check was more than four hours ago, it checks again
  30 seconds later, once the network is back.
- No install is started within a day of the last one, and none while Windows is shutting down.
- An update that has waited three days without installing brings one message, "An OtherSSH
  update is ready", with "Restart now" and "Later", and comes back no more than every three days.

Each install is recorded first (`attempt` in `updates.json`, with the release notes). On the
next start the new version shows "OtherSSH was updated to ..." once; if it is still the old
version the failure is logged once. The download is held in memory and its signature checked
again just before the installer is written out and started, from `%TEMP%\otherssh-update`.
After a quiet install the installer's `--force-run` starts OtherSSH again; the window remembers
its size and position, but connections have to be opened again.

`updates.json` and `otherssh.log` (what the updater did and why it waited) are in the data folder,
`%APPDATA%\OtherSSH`.

## The feed

```
GET https://api.otherworld.dev/v1/updates/otherssh/windows/x86_64/<current version>[?channel=beta]
X-Install-Id: <uuid>
```

answers 200 with `{version, notes, pub_date, url, signature}` or 204 when there is nothing newer.
The install id is a random UUID made on the first check and kept in `updates.json`; it is never
tied to an account or a host. Installers are served from
`https://api.otherworld.dev/downloads/otherssh/<version>/<file>`.

## Testing an update locally

Development builds only check for updates when `OTHERSSH_UPDATE_ENDPOINT` is set, and may use
plain `http` for it; they never install. Serve a manifest with a higher version than
`package.json` that points at a signed installer from `build.mjs`, then:

```
set OTHERSSH_USER_DATA=%TEMP%\otherssh-updatetest
set OTHERSSH_UPDATE_ENDPOINT=http://127.0.0.1:8766/v1/updates/otherssh/{{target}}/{{arch}}/{{current_version}}
npm run start
```

Settings, Check for updates, should download it, check the signature and say it is ready to
install. Do not test the install itself on a machine where OtherSSH is installed: the installer
closes any running OtherSSH and installs over the real copy.
