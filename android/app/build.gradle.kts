// The :app module (spec/tech/16-android-companion.md §6.1, §11).
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

/** A Gradle property (e.g. from ~/.gradle/gradle.properties) or, failing that, an environment variable. */
fun setting(name: String): String? =
    providers.gradleProperty(name).orElse(providers.environmentVariable(name)).orNull?.takeIf { it.isNotBlank() }

// A fork registers its own OAuth clients under its own application ID (16 §6.1).
val eli5ApplicationId: String = setting("ELI5_APPLICATION_ID") ?: "io.github.eli5learner"

// Release signing (16 §11): values come only from Gradle properties or the environment, never from the
// repository. Without all four, the release build falls back to the debug key so a fresh clone builds.
val releaseKeystorePath: String? = setting("ELI5_ANDROID_KEYSTORE")
val releaseKeystore: File? = releaseKeystorePath?.let { if (it.startsWith("~/")) File(System.getProperty("user.home"), it.substring(2)) else File(it) }
val releaseStorePassword: String? = setting("ELI5_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias: String? = setting("ELI5_ANDROID_KEY_ALIAS")
val releaseKeyPassword: String? = setting("ELI5_ANDROID_KEY_PASSWORD")
val hasReleaseSigning: Boolean =
    releaseKeystore?.isFile == true && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null

// The commit shown in Settings > About. "unknown" outside a git checkout (e.g. a source tarball).
val gitCommit: String =
    runCatching {
        providers
            .exec {
                commandLine("git", "rev-parse", "--short=12", "HEAD")
                isIgnoreExitValue = true
            }.standardOutput.asText
            .get()
            .trim()
    }.getOrNull()?.takeIf { Regex("^[0-9a-f]{7,40}$").matches(it) } ?: "unknown"

android {
    namespace = "io.github.eli5learner"
    compileSdk { version = release(37) }

    defaultConfig {
        applicationId = eli5ApplicationId
        minSdk = 31
        // One below compileSdk until a manual pass on a phone (16 §6.1).
        targetSdk = 36
        versionCode = 4
        versionName = "0.5.0"
        buildConfigField("String", "GIT_COMMIT", "\"$gitCommit\"")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/LICENSE*", "/META-INF/NOTICE*")
    }

    sourceSets {
        // Shared fixtures (16 §12): the sync contract folder and the desktop's built documents, read
        // by the JVM tests from the classpath. Read-only; nothing here is packaged into the APK.
        getByName("test") {
            resources.directories.add("../../test/contracts")
            resources.directories.add("../../test/fixtures/documents/build")
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            // Robolectric 4.17 on SDK 36 under JDK 21.
            it.jvmArgs(
                "--add-opens=java.base/java.io=ALL-UNNAMED",
                "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
            )
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        checkDependencies = false
        // Versions are pinned on purpose (16 §6.1) and resolved by hand; targetSdk stays one below
        // compileSdk until a manual pass on a phone.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.navsuite)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.viewmodel.navigation3)
    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)
    implementation(libs.webkit)
    implementation(libs.browser)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    // Sync (16 §3.3, §6.1): AuthorizationClient only, Drive REST v3 over OkHttp, DataStore preferences.
    implementation(libs.play.services.auth)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.okhttp)
    implementation(libs.datastore.preferences)
    // Library sync (16 §6.4, §4.8): Room as a rebuildable cache, WorkManager for background pulls.
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime.ktx)

    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver3)
    testImplementation(libs.work.testing)
}

/**
 * Prints the application ID and the SHA-1 of the debug and release signing certificates: the values
 * an Android OAuth client is registered with (android/SETUP.md). Prints no passwords or paths.
 */
tasks.register("printOAuthFingerprints") {
    group = "help"
    description = "Prints the application ID and signing-certificate SHA-1 fingerprints for OAuth clients."
    val appId = eli5ApplicationId
    val debugKeystore = File(System.getProperty("user.home"), ".android/debug.keystore")
    val release = if (hasReleaseSigning) Triple(releaseKeystore!!, releaseStorePassword!!, releaseKeyAlias!!) else null
    doLast {
        fun sha1(store: File, password: String, alias: String): String {
            val ks = KeyStore.getInstance(store, password.toCharArray())
            val cert = ks.getCertificate(alias) as? X509Certificate ?: error("alias not found in keystore")
            return MessageDigest
                .getInstance("SHA-1")
                .digest(cert.encoded)
                .joinToString(":") { "%02X".format(it) }
        }
        println("Application ID: $appId")
        if (debugKeystore.isFile) {
            println("Debug SHA-1:    ${sha1(debugKeystore, "android", "androiddebugkey")}")
        } else {
            println("Debug SHA-1:    (no ~/.android/debug.keystore yet; run assembleDebug once)")
        }
        if (release != null) {
            println("Release SHA-1:  ${sha1(release.first, release.second, release.third)}")
        } else {
            println("Release SHA-1:  (release signing not configured; release builds use the debug key)")
        }
    }
}
