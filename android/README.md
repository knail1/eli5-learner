# ELI5 Learner for Android

The optional Android companion: an offline reader for ELI5 documents, import of exported
`index.html` files, and (later in milestone M5) personal sync with the desktop app through your own
Google Drive and a share-sheet "Send to my Mac". The design is
[spec/tech/16-android-companion.md](../spec/tech/16-android-companion.md). To get from nothing to the
app on your phone, follow [SETUP.md](SETUP.md).

> **Status (M5, in progress).** This folder is being built in slices. The local-mode app is built:
> import (picker, share sheet, "Open with"), the library, the sandboxed reader and Settings > About.
> Google authorization (Connect, Disconnect, "Sign in again"), the Drive
> REST client and a debug-only Drive probe for gate G1 are built and tested against MockWebServer
> and a fake authorization client. Library sync is built: Room library and full-text search,
> pull from the Mac's manifest with an offline cache (policy, Wi-Fi rule, pins), folder chips, the
> sync icon and status sheet, pull-to-refresh, the Reader's "Updated on your Mac · Reload" banner and
> reading position, background sync through WorkManager, and the phone's device file; it is tested
> against an in-memory Drive and database. Capture is built: the share target ("Send to my Mac"
> for links, text, images, PDF and Office files), the outbox and its upload worker, Cancel, the
> Inbox with job statuses, Retry and Delete, the acks file and the opt-in "Learnings ready"
> notification; also tested against an in-memory Drive and database only. The desktop side that
> runs phone jobs (Settings > Sync > "Accept jobs from phone") is built and tested against the
> desktop's in-memory store. Everything against a real Google Drive is unverified until gate G1
> (spec 16 §13).

This is its own Gradle build with one `:app` module. It never touches the npm toolchain, and Prettier
ignores the folder.

## Toolchain (pinned)

Versions were resolved on 2026-11-07 against the official Maven metadata
(`dl.google.com/android/maven2`, Maven Central) and verified together in a smoke build. Library
versions live in `gradle/libs.versions.toml`.

| Item | Version | Notes |
| --- | --- | --- |
| JDK | 21 (`brew install openjdk@21`) | Run Gradle on 21. Robolectric on SDK 36+ needs it |
| Gradle (wrapper) | 9.8.2 | Wrapper pins `distributionSha256Sum` |
| Android Gradle Plugin | 9.5.1 | Built-in Kotlin: the `org.jetbrains.kotlin.android` plugin is not applied |
| Kotlin (Compose compiler plugin) | 2.4.21 | |
| SDK `platform-tools` | 37.0.1 | `adb` |
| SDK `platforms;android-37.0` | 37.0 | `compileSdk 37` |
| SDK `build-tools;37.0.0` | 37.0.0 | `apksigner`, `zipalign` |
| `minSdk` / `targetSdk` | 31 / 36 | `targetSdk` goes to 37 after a manual pass on a phone |

Shell setup (also in SETUP.md A1):

```sh
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;37.0.0"
```

## Build

From this folder:

```sh
cp local.properties.example local.properties   # set sdk.dir=/opt/homebrew/share/android-commandlinetools
./gradlew assembleDebug                         # app/build/outputs/apk/debug/
./gradlew :app:assembleRelease                  # signed with the release key, or the debug key as a fallback
./gradlew :app:printOAuthFingerprints           # application ID + SHA-1 for the debug and release keys
../scripts/android-dist.sh                      # copies the release APK to release/android/ and verifies it
```

Signing values come from `~/.gradle/gradle.properties` or the environment, never from the repository:
`ELI5_ANDROID_KEYSTORE`, `ELI5_ANDROID_KEYSTORE_PASSWORD`, `ELI5_ANDROID_KEY_ALIAS`,
`ELI5_ANDROID_KEY_PASSWORD`. Without them the release build is signed with the debug key, so a fresh
clone still builds. The application ID defaults to `io.github.eli5learner`; a fork overrides it with
the Gradle property `ELI5_APPLICATION_ID` and registers its own OAuth clients.

## Test

```sh
./gradlew lint testDebugUnitTest assembleDebug
```

All tests are JVM tests under `app/src/test/` (JUnit 4, Robolectric, Compose UI tests,
MockWebServer) and run headless; no emulator is needed. The sync wire-format tests read the shared
fixtures in `../test/contracts/sync/`, which the build adds as a test resource folder. CI runs the
same command on Linux with JDK 21 (spec 16 §11).

## Never commit

`local.properties`, `keystore.properties`, `*.jks`/`*.keystore`, `google-services.json`, the desktop
client JSON (`client_secret*.json`), APK and AAB files, `.gradle/`, `build/` and IDE files. They are
git-ignored, and `npm run check:hygiene` at the repository root fails if one is tracked.

## Sideload smoke checklist

Run this on a real phone (tested on a Pixel) before calling a release build good. Install with
`adb install -r release/android/eli5-learner-release.apk` from the repository root.

Reader and import (no Google setup):

- [ ] The app opens to the Library; the empty state offers Import.
- [ ] Import an exported ELI5 `index.html` from Files; it appears in the Library with its title.
- [ ] Open it: the In depth tab shows; switching to ELI5 works; a glossary note opens; a chart and
      the stepper render.
- [ ] Toggle the document theme; it sticks after leaving and reopening the document.
- [ ] Turn on airplane mode and reopen the document: it still opens and works.
- [ ] Tap an external link: it opens in a Custom Tab, not in the reader.
- [ ] Back goes back inside the document first, then to the Library.
- [ ] Import a non-ELI5 HTML file: it opens labelled "Foreign file · scripts off".
- [ ] Share an `index.html` to ELI5 Learner from another app, and "Open with" from Files: both
      import.
- [ ] Rotate the phone and use split screen: the layout adapts and nothing is lost.
- [ ] Without Google Drive, share a link from Chrome to "Send to my Mac": the sheet opens over
      Chrome, Send closes it at once, and the Inbox lists it as "Connect Google Drive to send".
      Cancel removes it.
- [ ] Share three photos from Photos and a PDF from Files: each is listed in the sheet; a video or
      a file over 20 MB is listed with a one-line reason instead.
- [ ] Settings > About shows "Sideloaded build", the version and the commit.

Google sign-in (needs Stage B of SETUP.md):

- [ ] Onboarding (first launch) or Settings > Connect Google Drive shows Google's consent for the
      account, then "Connected as <email>".
- [ ] Settings > Disconnect asks first, then shows "Disconnected from Google Drive"; documents stay.
- [ ] Debug build only: Settings > Diagnostics > Drive probe writes, lists and deletes
      `probe-phone.json` (the phone half of gate G1, SETUP.md).

Sync (after G1, Stages B and C of SETUP.md):

- [ ] Connect Google Drive on the phone; "Waiting for your Mac" until the Mac has synced.
- [ ] The Mac's library appears; a document opens offline afterwards.
- [ ] A document updated on the Mac shows "Updated on your Mac · Reload" and never reloads by
      itself.
- [ ] Share a link to ELI5 Learner, tap "Send to my Mac": the Inbox goes from "Waiting to upload"
      to "Waiting for your Mac" (turn on "Accept jobs from phone" on the Mac) to Generating to Ready,
      and the new document opens on the phone.
- [ ] After the first capture the app asks "Tell you when it's ready?"; with Notify me, a finished
      job posts "Learnings ready", and tapping it opens the Inbox.
- [ ] Cancel a job that is still waiting for the Mac: it shows "Cancelling…", then "Cancelled".
- [ ] Revoke access at myaccount.google.com/permissions: the phone shows "Sign in again to keep
      syncing", and reading still works.
