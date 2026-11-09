# ELI5 Learner on Android: setup guide

This guide takes you from nothing to the ELI5 Learner app on your Android phone (tested on a Pixel),
with optional sync to the desktop app through your own Google Drive. Nothing you create while
following it is ever committed: client IDs, the client secret, signing keys and `local.properties`
stay on your machine. The design is in
[spec/tech/16-android-companion.md](../spec/tech/16-android-companion.md).

> **Status (milestone M5, built; sync awaiting gate G1).** Stage A works today: the local-mode
> reader builds, and the release APK is signed with your key and scanned for secrets by
> `scripts/android-dist.sh`. CI builds and tests the Android project on every change to it
> (`.github/workflows/android.yml`, no secrets, never a release). Stages B and C describe sync.
> **Sync against a real Google Drive is unverified until gate G1** (spec 16 §13): the code is built and tested against an
> in-memory fake Drive first, and the cross-client checks with a real Cloud project come after.
> The desktop sync engine (push, primary claim, heartbeat, clean-up) is built and tested against
> that fake Drive only; its behaviour against a real Drive is also unverified until G1. The same
> holds for library sync on the phone (pull, offline cache, search, the phone's device file): built
> and tested against an in-memory Drive and database only, unverified against a real Drive until G1.
> "Send to my Mac" (the share sheet, the outbox, the Inbox and its statuses) is built and tested the
> same way. The desktop side that runs phone jobs (the inbox behind "Accept jobs from phone") is
> built and tested against the in-memory store only; it too is unverified against a real Drive
> until G1. Versions on the phone (the tree, previews and "Make current on your Mac") are built and
> tested the same way, against an in-memory Drive and database only.
> Until G1 passes, treat Stages B and C as a preview; details may change, and if the hidden app
> folder turns out not to be shared between the desktop and Android clients, sync moves to a
> visible Drive folder instead.

There are three stages. You can stop after any of them.

| Stage | What you get | Needs Google Cloud? | Time |
| --- | --- | --- | --- |
| A. Build and install the APK | An offline reader for exported ELI5 documents | No | 30–45 min the first time |
| B. Google Cloud project | The OAuth clients sync needs | Yes | 20 min |
| C. Connect both apps | Library on the phone, "Send to my Mac" from the share sheet | Yes | 10 min |

---

## Stage A · Build and install the APK

### A1. Install the Android toolchain (once, on the Mac)

You need Homebrew. Nothing here needs `sudo`.

```sh
brew install --cask android-commandlinetools
brew install openjdk@21
```

Add these lines to your shell profile (`~/.zprofile` or `~/.profile`), then open a new terminal:

```sh
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Accept the SDK licenses and install the packages the build uses (the exact platform and build-tools
versions are listed in [README.md](README.md); the ones below are the defaults at the time of
writing):

```sh
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;37.0.0"
```

Check: `adb version` and `java -version` (should say 21) both work.

### A2. Create your signing key (once, keep it forever)

Every version of the app you install must be signed with the same key, or Android refuses the
update. Google also identifies your app by this key. Create it **outside** the repository and **back
it up** together with its password (for example in your password manager). If the key is lost, the
installed app can never be updated; you would have to uninstall it and register new Android OAuth
clients.

(If you already have `~/.config/eli5-learner/eli5-release.jks` and the four lines below in
`~/.gradle/gradle.properties`, skip this step and just make sure both are backed up.)

```sh
mkdir -p ~/.config/eli5-learner
keytool -genkeypair -v -keystore ~/.config/eli5-learner/eli5-release.jks \
  -alias eli5 -keyalg RSA -keysize 4096 -validity 10000
```

Pick a password and remember it. Then add these lines to `~/.gradle/gradle.properties` (create the
file if needed; it is in your home folder, not in the repo) and run `chmod 600
~/.gradle/gradle.properties`:

```properties
ELI5_ANDROID_KEYSTORE=/Users/<you>/.config/eli5-learner/eli5-release.jks
ELI5_ANDROID_KEYSTORE_PASSWORD=<your password>
ELI5_ANDROID_KEY_ALIAS=eli5
ELI5_ANDROID_KEY_PASSWORD=<your password>
```

If these are missing, the build still works but signs the release APK with the debug key.

### A3. Build

```sh
cd android
cp local.properties.example local.properties   # then set sdk.dir=/opt/homebrew/share/android-commandlinetools
./gradlew :app:printOAuthFingerprints          # prints application ID + SHA-1 for debug and release; keep this output for Stage B
./gradlew :app:assembleRelease
../scripts/android-dist.sh                     # copies the signed APK to release/android/ (git-ignored) and verifies the signature
```

`printOAuthFingerprints` prints the application ID and one SHA-1 per key (no passwords or paths):

```
Application ID: io.github.eli5learner
Debug SHA-1:    AB:CD:...:12
Release SHA-1:  34:56:...:EF
```

If the release line says "release signing not configured", Gradle cannot see the four
`ELI5_ANDROID_*` properties from A2, and the release APK falls back to the debug key.
`android-dist.sh` then prints a warning; fix the properties before you install, because an app
signed with the debug key cannot later be updated in place by one signed with the release key.

### A4. Install on the phone

1. On the phone: Settings > About phone > tap **Build number** seven times to unlock Developer
   options.
2. Settings > System > Developer options > turn on **USB debugging** (or **Wireless debugging**).
3. Connect the phone by USB and accept the "Allow USB debugging?" prompt. For wireless: in Wireless
   debugging tap "Pair device with pairing code", then on the Mac run `adb pair <ip>:<port>` and
   `adb connect <ip>:<port>`.
4. Install:

   ```sh
   adb install -r release/android/eli5-learner-release.apk
   ```

Alternative without `adb`: copy the APK to the phone (Drive, email, USB file transfer), tap it in
the Files app, and allow "Install unknown apps" for that app when Android asks. `adb` installs are
the most reliable route; Android's developer verification rules exempt them.

### A5. What works now (no Google setup)

- **Import:** Library > Import, or share an `index.html` to ELI5 Learner from Files, Gmail or the
  Drive app, or tap it and choose "Open with ELI5 Learner".
- **Read offline:** every tab (In depth, ELI5, the optional ASD-STE100 tab with its one-line hint,
  and section ELI5 tabs), glossary, charts, the interactive animations (sandboxed; they cannot load
  or send anything over HTTP), theme and dark mode (a document set to "Auto" follows the phone).
- **Capture:** sharing a link, text, photos, a PDF or an Office file to **Send to my Mac** works;
  the capture waits in the Inbox as "Connect Google Drive to send" (Cancel removes it).

To get documents from the Mac: publish with the Local directory publisher (or find the document's
folder in the library) and send `index.html` to the phone any way you like, or
`adb push <path>/index.html /sdcard/Download/` and import it from Downloads.

---

## Stage B · Google Cloud project (once)

All of this is in the Google Cloud console, signed in with the Google account you will use for sync.
Use **one project for everything**. Desktop and Android clients in different projects cannot see
each other's data.

1. **Create a project** at <https://console.cloud.google.com/projectcreate>. Any name, for example
   "ELI5 Learner personal".
2. **Enable the Drive API (don't skip this):** APIs & Services > Library > "Google Drive API" >
   Enable, in the same project as your clients. Without it, sign-in works but every sync fails with
   "Turn on the Google Drive API in your Google Cloud project, then Sync now".
3. **Google Auth Platform > Branding:** app name "ELI5 Learner", your email as support and developer
   contact. Do **not** upload a logo (it triggers a brand review). To publish the app later (see
   "Testing vs In production"), also fill in, with pages you control:
   - **Application home page:** for example `https://<your-user>.github.io/<your-repo>/`.
   - **Application privacy policy link:** for example `https://<your-user>.github.io/<your-repo>/privacy/`.
   - **Authorized domains:** the domain of both pages, for example `<your-user>.github.io`.

   The pages only need to exist and describe the app (a GitHub Pages site is enough); nothing in
   the apps reads these values.
4. **Audience:** User type **External**. Publishing status stays **Testing** for now. Under Test
   users, add your own Gmail address.
5. **Data access:** Add scopes `openid`, `.../auth/userinfo.email` and
   `https://www.googleapis.com/auth/drive.appdata`. Nothing else. Never add the full `drive` scope.
6. **Clients > Create client** three times:

   | Application type | Fields | What you keep |
   | --- | --- | --- |
   | Desktop app | Name: "ELI5 Learner desktop" | Download the JSON (`client_secret_….json`). Keep it outside the repo. |
   | Android | Package name and SHA-1 from the `Release SHA-1` line of `printOAuthFingerprints` | Nothing; Google matches the app by package and key. |
   | Android | Package name and SHA-1 from the `Debug SHA-1` line | Nothing. Only needed if you install debug builds. |

   The Android app needs no client ID in its code or config. Google recognizes it by package name
   plus signing key.

### Testing vs In production

*(Unverified until G1.)*

In **Testing**, Google lets the desktop stay signed in for only 7 days, and the phone's permission
lapses after 7 days too. Sync then stops each week with "Sign in again to keep syncing". To end
that:

1. Make sure Branding has the home page, privacy policy link and authorized domain (Stage B step 3).
2. Go to **Google Auth Platform > Audience** and click **Publish app**, then confirm. The publishing
   status changes to **In production**. Because the app asks only for non-sensitive scopes
   (`openid`, email and `drive.appdata`), no verification review is required, and new sign-ins no
   longer expire after 7 days.
3. **Reconnect both apps.** A sign-in made while the project was in Testing keeps its 7-day expiry
   even after you publish. On the Mac, Settings > Sync > **Disconnect**, then **Connect Google Drive**; on
   the phone, Settings > **Disconnect**, then **Connect**. Your library stays where it is.
4. Expect the **"Google hasn't verified this app"** screen when you reconnect, on the Mac and on
   the phone. It appears because the app is not verified, not because something is wrong. Check
   that it names your own app and your own email as developer, then choose **Advanced** and
   **Go to ELI5 Learner (unsafe)** (the exact wording varies) and allow access as before. Only you
   (and anyone you hand your client to) ever sees this screen.

### Gate G1 · the cross-client check (once, before trusting sync)

The check proves that the desktop and Android clients of one project see the same hidden app folder
(spec 16 §13). It needs a **debug** build on the phone, because the probe screen exists only there,
and the debug SHA-1 registered as an Android client.

1. From `android/`: `./gradlew assembleDebug`, then
   `adb install -r app/build/outputs/apk/debug/app-debug.apk`. (A debug build has another signing
   key than the release build; uninstall the release build first if `adb` refuses.)
2. On the phone: Settings > **Connect Google Drive**, allow access. Then Settings > Diagnostics.
3. Under "Drive probe": **Start change feed**, then **Write probe-phone.json**.
4. On the Mac, the desktop side writes `probe-desktop.json` and lists the folder (a throwaway
   script during development).
5. On the phone: **Read probe-desktop.json** shows its content, **Check changes** lists it, and
   **List app folder** counts both probes. Finally **Delete my probe** (or let the desktop delete it).

If the phone never sees the desktop's file, the two clients are not in one project or not on one
account (Troubleshooting below); if they are and it still fails, sync moves to a visible Drive
folder as described at the top.

---

## Stage C · Connect both apps

*(Unverified until G1. The phone's Connect button is built (Settings and the first-run screen),
and so is the desktop Settings > Sync section with the sidebar sync indicator; both are tested only
against a stand-in for Google so far. Library sync on the phone (step C2.3) and "Send to my Mac"
(step C2.4) are built and tested against an in-memory Drive only.)*

### C1. Desktop

1. Open ELI5 Learner on the Mac > Settings > Sync and turn on **Sync with my Google Drive**. Nothing
   is sent to Google until you connect in step 3.
2. Paste the contents of the downloaded Desktop client JSON into "Google client", or drop the file
   on the field, then click **Save client**. It is stored in the macOS Keychain and never shown
   again. (Developers running `npm run dev` can instead set `ELI5_GOOGLE_CLIENT_ID` and
   `ELI5_GOOGLE_CLIENT_SECRET` in a local `.env`, which is git-ignored.)
3. Click **Connect Google Drive**. Your browser opens Google's consent page. Choose your account and
   allow access. The browser tab then says you can close it, and Settings shows "Connected as" your
   address. The first push uploads your library; the cloud icon in the sidebar footer shows
   progress (click it to come back to Settings > Sync).
4. Turn on **Accept jobs from phone** if you want to send captures from the phone.

To remove everything from Drive later, use **Delete cloud copy** in the same section. It turns Sync
off and leaves your library on the Mac as it is.

### C2. Phone

1. Open ELI5 Learner > Settings (or the onboarding screen) > **Connect Google Drive**.
2. Pick the same Google account and allow access.
3. The app shows "Waiting for your Mac…" until it sees the desktop, then downloads the library.
   The cloud icon in the Library shows the state (tap it for "Your Mac was last seen…" and **Sync
   now**); pull down on the list to sync. Settings > Sync chooses what is kept offline (all
   documents, the 20 most recent, or only the ones you mark **Keep offline** in a row's menu) and
   whether documents over 5 MB wait for Wi-Fi. The phone also syncs when you open the app and about
   every 15 minutes in the background while online.
4. Share a link or a photo from any app to ELI5 Learner, add an optional note, tap **Send to my
   Mac**. The Inbox shows its progress. The Mac must be running ELI5 Learner (the menu bar is enough)
   for the job to start.

### C3. First real-Drive check (gate G1 hand-off)

Once Stages B, C1 and C2 are done, confirm in one sitting:

- [ ] Desktop: Settings > Sync shows "Connected as" your address, and the sidebar cloud icon goes
      idle after the first push.
- [ ] Phone: install the 0.4.0 APK (A3, A4) over the old one, connect with the **same** Google
      account, and wait for "Waiting for your Mac…" to clear.
- [ ] Every document in the Mac's library appears on the phone with its title, and opens.
- [ ] A document with an ASD-STE100 tab or an animation renders on the phone as it does on the Mac.
- [ ] A document the Mac rebuilt shows "Rebuilt with prompt set …" as its current version under
      the version chip.

If a step fails, note which one and see Troubleshooting below.

### Where your data goes

Sync uses a hidden app folder in your Google Drive. You cannot browse it in Drive, other apps cannot
read it, and it counts against your storage. It holds your documents and their titles and summaries,
not your source files or notes. It is not end-to-end encrypted, so Google can read it.

To delete it: desktop Settings > Sync > **Delete cloud copy**, or drive.google.com > Settings >
Manage apps > ELI5 Learner > Options > **Delete hidden app data**. To revoke access entirely:
<https://myaccount.google.com/permissions>. Your Mac's library is not affected.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Turn on the Google Drive API in your Google Cloud project, then Sync now" (desktop or phone) | The Drive API isn't enabled in the project your clients are in (Drive answers 403 `accessNotConfigured`) | Enable it (Stage B step 2), wait a minute, then press **Sync now**. Sync doesn't retry this on its own. |
| Phone: "Developer error" or error code 10 when connecting | Package name or SHA-1 doesn't match an Android client | Re-run `printOAuthFingerprints`; the APK you installed must match one Android client exactly (debug vs release). |
| Phone sees no Mac and no documents | Desktop and Android clients are in different Cloud projects, or different Google accounts | Put all clients in one project; use the same account on both. |
| Sync stops every 7 days | Project still in Testing, or the apps were connected before you published | Publish the app, then disconnect and reconnect on both (Stage B, "Testing vs In production"). |
| "Google hasn't verified this app" when connecting | The app is In production but not verified | Expected for a personal project; continue past it (Stage B). |
| **Publish app** is greyed out or asks for more | Branding lacks a home page, privacy policy link or authorized domain | Fill them in (Stage B step 3). |
| Desktop: "access_denied" in the browser | Your account isn't a test user | Add it under Audience > Test users. |
| `adb install` fails with "signatures do not match" | Installed app was signed with another key | Use the same keystore; or uninstall first (deletes the phone's cached data, not your library). |
| Phone: a document says "Not on this phone yet" | The offline policy skips it, it is over 5 MB on mobile data, or the Mac is still uploading it | Open it to download it now, or pull down to sync later. |
| Inbox job stays "Waiting for your Mac" | ELI5 Learner isn't running on the Mac, "Accept jobs from phone" is off, or the Mac is asleep | Open the app on the Mac; check Settings > Sync. |
| `sdkmanager: command not found` | `PATH`/`ANDROID_HOME` not set in this shell | Open a new terminal after editing your profile. |
| Gradle says the Java version is unsupported | `JAVA_HOME` points to an old JDK | Point it at JDK 21 (A1). |

## Never commit

`android/local.properties`, `~/.gradle/gradle.properties` values, `*.jks`/`*.keystore`, the Desktop
client JSON, `.env`, APK files. The repository's hygiene check (`npm run check:hygiene`) fails if any
of these is tracked.
