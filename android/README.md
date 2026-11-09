# ELI5 Learner for Android

The optional Android companion: an offline reader for ELI5 documents, import of exported
`index.html` files, and (later in milestone M5) personal sync with the desktop app through your own
Google Drive and a share-sheet "Send to my Mac". The design is
[spec/tech/16-android-companion.md](../spec/tech/16-android-companion.md). To get from nothing to the
app on your phone, follow [SETUP.md](SETUP.md).

> **Status (M5, built; G1 smoke passed, see below).** All slices are built, CI covers this
> folder, and the release APK is signed and secret-scanned by `scripts/android-dist.sh`; the smoke
> checklist below has not yet been run on a phone. The local-mode app is built:
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
> desktop's in-memory store. Versions are built: the Reader's version chip opens a read-only tree
> (the Kotlin port of the desktop's lane layout, checked against the shared fixtures), previews of
> versions the Mac uploaded (downloaded on demand), "Not available on this phone" for the rest, and
> "Make current on your Mac", which sends a `checkout` job. The Ask sheet (a section from the
> outline and a one-line question) is built and appears only once the Mac lists `ask` among the jobs
> it accepts; the desktop does not run phone questions yet, so it stays hidden for now. Everything
> against a real Google Drive was smoke-tested at gate G1 (spec 16 §13). The G1 smoke test passed against a real Google Drive in November 2026: sign-in on the Mac and on a Pixel, desktop push, primary claim, and the phone pulling and listing the library. Phone jobs (Ask) and conflict paths are still unverified against a real Drive.
>
> **0.4.0 (versionCode 3): reads everything the desktop now writes.** The reader opens three-tab
> documents (In depth, ELI5 and the optional ASD-STE100 tab with its one-line hint, plus section ELI5
> tabs), the model-written animations (each in an `<iframe sandbox="allow-scripts" srcdoc>` whose two
> scripts the reader's CSP header pins by hash; `connect-src` and `frame-src` stay `'none'` and the
> WebView client answers nothing but `/docs/`, so an animation has no HTTP, fetch or WebSocket
> access), the shared chart palette and dark mode (the document follows the phone's dark theme;
> algorithmic darkening is off). WebRTC is the one channel neither CSP nor the WebView client covers,
> and Android's WebView has no switch for it (the desktop turns off non-proxied UDP); on the phone it
> rests on the frame shell, which removes `RTCPeerConnection` and its relatives before the
> animation's code runs, and on the desktop's lint, which rejects animation code that names them.
> A document the Mac rebuilt arrives as a new version: Versions lists "Rebuilt with prompt set …"
> under the first version, indented as its child and marked current; the first version stays
> readable. The phone accepts the `ste` tab key in the manifest from 0.4.0 on; the Mac still leaves
> it out while 0.3.0 phones may be syncing, and the phone reads the tab labels from the document
> itself.

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
fixtures in `../test/contracts/sync/`, which the build adds as a test resource folder. The round
trip (`sync/RoundTripTest.kt`) imports `../test/contracts/sync/roundtrip/library.json`: every file the
desktop engine wrote to its fake Drive for a library with a rebuilt three-tab document with
animations (regenerate it with `ELI5_UPDATE_GOLDENS=1 npx vitest run test/unit/main/sync/roundtrip.test.ts`
at the repository root). The phone syncs it, checks History and serves the document through the
reader. Robolectric does not run a real WebView, so JavaScript inside the animation frames, the
chart palette and dark-mode rendering are covered by the desktop's Playwright and visual suites
(the phone gets the same bytes, checked byte for byte) and the smoke checklist below, not here; the
unit tests only pin the WebView settings, such as algorithmic darkening off. CI runs the
same command on Linux with JDK 21 in `.github/workflows/android.yml` whenever `android/`,
`test/contracts/` or the built test documents change (spec 16 §11). That workflow reads no secrets
and never builds a release; release builds happen only on your Mac with your key.

## Never commit

`local.properties`, `keystore.properties`, `*.jks`/`*.keystore`, `google-services.json`, the desktop
client JSON (`client_secret*.json`), APK and AAB files, `.gradle/`, `build/` and IDE files. They are
git-ignored, and `npm run check:hygiene` at the repository root fails if one is tracked.

## Sideload smoke checklist

Run this on a real phone (tested on a Pixel) before calling a release build good. Sections run in
order; stop at the first one your setup does not reach (the sync sections need Stages B and C of
SETUP.md, and are meaningful only after gate G1). Copy the list into the release notes or an issue
and tick it there; this file stays unticked.

Build and install (on the Mac, from the repository root):

- [ ] `git status` is clean apart from files you meant to change, and `npm run check:hygiene`
      passes.
- [ ] `(cd android && ./gradlew lint testDebugUnitTest assembleDebug :app:assembleRelease)` passes.
- [ ] `scripts/android-dist.sh` exits 0 (it runs `apksigner verify`) and prints `CN=ELI5 Learner`
      (not `CN=Android Debug`) and "No secret-shaped content".
- [ ] `./gradlew :app:printOAuthFingerprints` (in `android/`) shows a `Release SHA-1` that matches
      the release Android client in your Cloud project.
- [ ] `adb install -r release/android/eli5-learner-release.apk` succeeds over the previous install
      (no "signatures do not match"; that means another key signed one of them).

Reader and import (no Google setup):

- [ ] The app opens to the Library; the empty state offers Import.
- [ ] Import an exported ELI5 `index.html` from Files; it appears in the Library with its title.
- [ ] Open it: the In depth tab shows; switching to ELI5 works; a glossary note opens; a chart and
      the stepper render.
- [ ] Toggle the document theme; it sticks after leaving and reopening the document.
- [ ] A document with an ASD-STE100 tab shows it with its one-line hint under the tab; a section
      ELI5 tab opens too.
- [ ] An animation runs: drag its control and the readout and drawing change. In airplane mode it
      still runs. Its poster shows before it loads.
- [ ] With the phone in dark theme, an "Auto" document and its animations are dark, and chart
      labels stay readable.
- [ ] Turn on airplane mode and reopen the document: it still opens and works.
- [ ] Tap an external link: it opens in a Custom Tab, not in the reader.
- [ ] Back goes back inside the document first, then to the Library.
- [ ] Import a non-ELI5 HTML file: it opens labelled "Foreign file · scripts off".
- [ ] Share an `index.html` to ELI5 Learner from another app, and "Open with" from Files: both
      import.
- [ ] Rotate the phone and use split screen: the layout adapts and nothing is lost.
- [ ] In portrait no page scrolls sideways; a wide chart or table scrolls inside its own box. Text
      size at the system's largest font setting still fits.
- [ ] Dark theme on the phone: the Library, the Reader chrome and an "Auto" document follow it.
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
- [ ] Open a document with several versions and tap its version chip: the tree matches the Mac's
      Versions panel (lanes, branches, the current one marked). A version the Mac did not upload
      reads "Not available on this phone".
- [ ] A document the Mac rebuilt shows "Rebuilt with prompt set …" as the current version, listed
      under the first version (rows run oldest first) and indented as its child.
- [ ] Tap an older uploaded version: it downloads and opens as "Earlier version"; Back returns to
      the current one, and the reading position of the current one is unchanged.
- [ ] "Make current on your Mac" on an older version: the Inbox lists it, the Mac switches to that
      version, and after the next sync the phone shows "Updated on your Mac · Reload".
- [ ] The Reader's overflow has no "Ask your Mac" while the Mac does not accept questions.
- [ ] Revoke access at myaccount.google.com/permissions: the phone shows "Sign in again to keep
      syncing", and reading still works.
