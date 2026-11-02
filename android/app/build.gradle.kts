plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The backend the phone talks to. The same Apps Script /exec URL the website
// uses (assets/js/config.js); override with -PapiUrl=... for a test copy.
val apiUrl = (findProperty("apiUrl") as String?)
    ?: "https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec"
// CI passes its run number so every build installs over the last one.
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "com.mwakete.sms"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mwakete.sms"
        minSdk = 24
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
        buildConfigField("String", "API_URL", "\"$apiUrl\"")
    }

    // Release signing only when the owner's key is supplied (GitHub secrets on
    // CI). Never commit a keystore or its passwords.
    val ks = System.getenv("MWAKETE_KEYSTORE")
    if (!ks.isNullOrBlank() && file(ks).exists()) {
        signingConfigs.create("release") {
            storeFile = file(ks)
            storePassword = System.getenv("MWAKETE_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("MWAKETE_KEY_ALIAS")
            keyPassword = System.getenv("MWAKETE_KEY_PASSWORD")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        // SEND_SMS / RECEIVE_SMS are the point of this app (sideloaded, not Play).
        disable += setOf("ProtectedPermissions")
        abortOnError = false
    }
}

dependencies {
    implementation(project(":sms-core"))
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
