# ELI5 Learner for Android

The optional Android companion: an offline reader for ELI5 documents, import of exported
`index.html` files, and (later in milestone M5) personal sync with the desktop app through your own
Google Drive and a share-sheet "Send to my Mac". The design is
[spec/tech/16-android-companion.md](../spec/tech/16-android-companion.md). To get from nothing to the
app on your phone, follow [SETUP.md](SETUP.md).

> **Status (M5, in progress).** This folder is being built in slices. The Gradle project and the
> local-mode reader come first; sync follows. Sync against a real Google Drive is unverified until
> gate G1 (spec 16 §13).

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
- [ ] Settings > About shows "Sideloaded build", the version and the commit.

Sync (after G1, Stages B and C of SETUP.md):

- [ ] Connect Google Drive on the phone; "Waiting for your Mac" until the Mac has synced.
- [ ] The Mac's library appears; a document opens offline afterwards.
- [ ] A document updated on the Mac shows "Updated on your Mac · Reload" and never reloads by
      itself.
- [ ] Share a link to ELI5 Learner, tap "Send to my Mac": the Inbox goes from "Waiting for your Mac"
      to Generating to Ready, and the new document opens on the phone.
- [ ] Revoke access at myaccount.google.com/permissions: the phone shows "Sign in again to keep
      syncing", and reading still works.
