plugins {
    id("com.android.application")
}

android {
    namespace = "com.agentkit.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.agentkit.companion"
        minSdk = 28
        targetSdk = 36
        versionCode = 13
        versionName = "1.2.10"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        // Debug 诊断路由通过 BuildConfig.DEBUG 控制，显式开启 BuildConfig 生成。
        buildConfig = true
        viewBinding = true
    }
    testOptions {
        unitTests {
            // 本地 JVM 测试会触发 Android 日志调用，返回默认值即可让测试聚焦监听恢复逻辑。
            isReturnDefaultValues = true
        }
    }
}

// AGP 9 的 VariantOutput 不公开输出文件名 setter；标准打包任务完成后复制一份版本化 APK，
// 保持 assembleDebug 入口不变，同时保留 Gradle 管理的原始 APK，避免破坏增量构建状态。
tasks.configureEach {
    if (name == "packageDebug") doLast {
        val outputDirectory = layout.buildDirectory.dir("outputs/apk/debug").get().asFile
        val defaultApk = outputDirectory.resolve("app-debug.apk")
        val versionedApk = outputDirectory.resolve(
            "lingxi-v${android.defaultConfig.versionName}-debug.apk",
        )
        if (defaultApk.exists()) {
            defaultApk.copyTo(versionedApk, overwrite = true)
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.10.0")
    // NanoHTTPD — 轻量 HTTP 服务器，单文件无依赖
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    testImplementation("junit:junit:4.13.2")
}
