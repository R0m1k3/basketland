import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signature : variables d'environnement (CI) ou `android/keystore.properties` (local, jamais
// versionné). Sans elles, l'APK release n'est pas signé (seul le debug l'est, clé de debug).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(env: String, prop: String): String? =
    System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProps.getProperty(prop)

val storePath = signingValue("ANDROID_KEYSTORE_PATH", "storeFile")

// Version : `BL_VERSION_NAME` / `BL_VERSION_CODE` (CI, tag `android-vX.Y.Z`), sinon valeurs de dev.
val blVersionName = System.getenv("BL_VERSION_NAME")?.takeIf { it.isNotBlank() } ?: "0.1.0-dev"
val blVersionCode = System.getenv("BL_VERSION_CODE")?.toIntOrNull() ?: 1

android {
    namespace = "app.basketland"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.basketland"
        // Fire OS 7 (Fire TV Cube 2e gén.) = Android 9.
        minSdk = 28
        targetSdk = 35
        versionCode = blVersionCode
        versionName = blVersionName
        buildConfigField("String", "SITE_URL", "\"https://land.vonrodbox.eu\"")
        buildConfigField("String", "RELEASES_API", "\"https://api.github.com/repos/R0m1k3/basketland/releases?per_page=30\"")
    }

    signingConfigs {
        if (storePath != null) {
            create("release") {
                storeFile = file(storePath)
                storePassword = signingValue("ANDROID_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = signingValue("ANDROID_KEY_ALIAS", "keyAlias")
                // Magasin PKCS12 : même mot de passe pour la clé, sauf indication contraire.
                keyPassword = signingValue("ANDROID_KEY_PASSWORD", "keyPassword")
                    ?: signingValue("ANDROID_KEYSTORE_PASSWORD", "storePassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (storePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = true
        // Appli installée à la main (pas de Play Store) : l'avertissement sur la version cible ne s'applique pas.
        disable += listOf("OldTargetApi", "IconMissingDensityFolder", "DataExtractionRules", "ObsoleteSdkInt")
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
