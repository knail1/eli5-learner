// Plugins are declared here once and applied per module. AGP 9 has built-in Kotlin support, so the
// org.jetbrains.kotlin.android plugin is not applied (android/README.md, toolchain table).
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
