# ELI5 Learner on Android: setup guide

This guide takes you from nothing to the ELI5 Learner app on your Android phone (tested on a Pixel),
with optional sync to the desktop app through your own Google Drive. Nothing you create while
following it is ever committed: client IDs, the client secret, signing keys and `local.properties`
stay on your machine. The design is in
[spec/tech/16-android-companion.md](../spec/tech/16-android-companion.md).

> **Status (milestone M5, in progress).** Stage A becomes usable once the Android project lands
> (the local-mode reader). Stages B and C describe the planned sync. **Sync against a real Google
> Drive is unverified until gate G1** (spec 16 §13): the code is built and tested against an
> in-memory fake Drive first, and the cross-client checks with a real Cloud project come after.
> The desktop sync engine (push, primary claim, heartbeat, clean-up) is built and tested against
> that fake Drive only; its behaviour against a real Drive is also unverified until G1.
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

`printOAuthFingerprints` prints two lines like:

```
debug   io.github.eli5learner  SHA-1 AB:CD:...:12
release io.github.eli5learner  SHA-1 34:56:...:EF
```

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
- **Read offline:** both tabs (In depth and ELI5), glossary, charts, theme.
- **Capture:** sharing a link or photo to the app works, but the job waits in the Inbox as
  "Connect Google Drive to send".

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
2. **Enable the Drive API:** APIs & Services > Library > "Google Drive API" > Enable.
3. **Google Auth Platform > Branding:** app name "ELI5 Learner", your email as support and developer
   contact. Do **not** upload a logo (it triggers a brand review).
4. **Audience:** User type **External**. Publishing status stays **Testing** for now. Under Test
   users, add your own Gmail address.
5. **Data access:** Add scopes `openid`, `.../auth/userinfo.email` and
   `https://www.googleapis.com/auth/drive.appdata`. Nothing else. Never add the full `drive` scope.
6. **Clients > Create client** three times:

   | Application type | Fields | What you keep |
   | --- | --- | --- |
   | Desktop app | Name: "ELI5 Learner desktop" | Download the JSON (`client_secret_….json`). Keep it outside the repo. |
   | Android | Package name and SHA-1 from the **release** line of `printOAuthFingerprints` | Nothing; Google matches the app by package and key. |
   | Android | Package name and SHA-1 from the **debug** line | Nothing. Only needed if you install debug builds. |

   The Android app needs no client ID in its code or config. Google recognizes it by package name
   plus signing key.

### Testing vs In production

*(Unverified until G1.)*

In **Testing**, Google lets the desktop stay signed in for only 7 days, and the phone's permission
lapses after 7 days too. Sync then stops each week with "Sign in again to keep syncing". Once Stage C
works, go to Audience and click **Publish app** to move to **In production**. Because the app asks
only for non-sensitive scopes, no review is required. Google may still show a "Google hasn't verified
this app" notice on the consent screen; as the app's owner you can continue past it.

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
against a stand-in for Google so far. Library sync on the phone arrives in a later M5 slice.)*

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
4. Share a link or a photo from any app to ELI5 Learner, add an optional note, tap **Send to my
   Mac**. The Inbox shows its progress. The Mac must be running ELI5 Learner (the menu bar is enough)
   for the job to start.

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
| Phone: "Developer error" or error code 10 when connecting | Package name or SHA-1 doesn't match an Android client | Re-run `printOAuthFingerprints`; the APK you installed must match one Android client exactly (debug vs release). |
| Phone sees no Mac and no documents | Desktop and Android clients are in different Cloud projects, or different Google accounts | Put all clients in one project; use the same account on both. |
| Sync stops every 7 days | Project still in Testing | Publish the app (Stage B). |
| Desktop: "access_denied" in the browser | Your account isn't a test user | Add it under Audience > Test users. |
| `adb install` fails with "signatures do not match" | Installed app was signed with another key | Use the same keystore; or uninstall first (deletes the phone's cached data, not your library). |
| Inbox job stays "Waiting for your Mac" | ELI5 Learner isn't running on the Mac, "Accept jobs from phone" is off, or the Mac is asleep | Open the app on the Mac; check Settings > Sync. |
| `sdkmanager: command not found` | `PATH`/`ANDROID_HOME` not set in this shell | Open a new terminal after editing your profile. |
| Gradle says the Java version is unsupported | `JAVA_HOME` points to an old JDK | Point it at JDK 21 (A1). |

## Never commit

`android/local.properties`, `~/.gradle/gradle.properties` values, `*.jks`/`*.keystore`, the Desktop
client JSON, `.env`, APK files. The repository's hygiene check (`npm run check:hygiene`) fails if any
of these is tracked.
