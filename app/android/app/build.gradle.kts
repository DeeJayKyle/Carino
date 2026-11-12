// Carino for Android, Flutter edition. The screens are Flutter; Carino's engine (its server code,
// database and AI agent) is the same bundled web app as before, built into
// ../../../android/app/src/main/assets/www by `npm run build` in the repository root, and runs in
// one WebView (see MainActivity.java). Same app id, signing key and storage as the earlier app, so
// installing this over it keeps everything.
plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "app.carino.android"
    compileSdk = 36
    // The NDK already installed (the app has no native code of its own; Flutter asks for one).
    ndkVersion = "28.2.13676358"

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "app.carino"
        minSdk = 26
        targetSdk = 36
        // From pubspec.yaml (version: 1.7.0+10700); the code follows the earlier app's scheme
        // (major*10000 + minor*100 + patch) so updates install over it.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            val ks = System.getenv("CARINO_KEYSTORE_FILE")
            if (ks != null) {
                storeFile = file(ks)
                storeType = "pkcs12"
                storePassword = System.getenv("CARINO_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CARINO_KEY_ALIAS") ?: "carino"
                keyPassword = System.getenv("CARINO_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (System.getenv("CARINO_KEYSTORE_FILE") != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    // The engine's files (index.html, scripts, sqlite3.wasm) come from the shared web build.
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "../../../android/app/src/main/assets")
        }
    }

    // sqlite3.wasm must stay uncompressed-readable.
    androidResources {
        noCompress += listOf("wasm")
    }
}

// The engine must be built first; otherwise the app would open to an empty engine.
tasks.register("checkEngineAssets") {
    doLast {
        if (!file("../../../android/app/src/main/assets/www/index.html").exists()) {
            throw GradleException("Missing android/app/src/main/assets/www — run `npm run build` in the repository root first.")
        }
    }
}
tasks.named("preBuild") { dependsOn("checkEngineAssets") }

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.core:core:1.16.0")
}

flutter {
    source = "../.."
}
