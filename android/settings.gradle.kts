// Mwakete SMS - the Android sender app (docs/contacts-sms-architecture.md).
//  sms-core: the shared rules (plain Kotlin), tested against tests/sms-core-cases.json
//  app:      the Android app that pairs with a store and sends its queued SMS
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    // Versions in one place; a plugin is only downloaded where a module applies it,
    // so -PcoreOnly builds sms-core without the Android plugin (Google's Maven).
    plugins {
        id("com.android.application") version "8.5.2"
        id("org.jetbrains.kotlin.android") version "1.9.24"
        id("org.jetbrains.kotlin.jvm") version "1.9.24"
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Mirrors Maven Central; a fallback when Central rate-limits a build machine.
        gradlePluginPortal()
    }
}
rootProject.name = "mwakete-sms"
include(":sms-core")
// The Android module needs the Android SDK; the GitHub Actions runner has it.
// Without one (-PcoreOnly), only sms-core is built and tested.
if (!providers.gradleProperty("coreOnly").isPresent) include(":app")
