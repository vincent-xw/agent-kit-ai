package com.agentkit.companion

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager

/**
 * 与 Android 系统策略直接相关的设备环境事实。
 *
 * 这里只读取系统状态：锁屏直接判定不可执行，省电限制只做诊断提示，
 * 不实现保活、唤醒或任何绕过系统策略的手段。
 */
data class CompanionDeviceEnvironment(
    val locked: Boolean,
    val batteryOptimizationIgnored: Boolean,
)

/** 用标准 API 读取锁屏与电池优化豁免状态；不引入厂商私有 API。 */
object CompanionDeviceEnvironmentReader {
    fun read(context: Context): CompanionDeviceEnvironment {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        val power = context.getSystemService(PowerManager::class.java)
        return CompanionDeviceEnvironment(
            locked = keyguard?.isKeyguardLocked == true,
            batteryOptimizationIgnored =
                power?.isIgnoringBatteryOptimizations(context.packageName) == true,
        )
    }
}

/**
 * 锁屏时直接给出不可重试的 DEVICE_LOCKED；未锁屏返回 null 继续正常抓树。
 * 单独抽成纯函数，保证这条产品边界可以被单测锁定。
 */
fun deviceLockedFailureOrNull(environment: CompanionDeviceEnvironment): CompanionProtocolError? =
    if (environment.locked) CompanionProtocolFailures.deviceLocked() else null

/**
 * 省电限制只作为 setup 诊断，不参与失败码判定：
 * 返回 null 表示已豁免，否则给出引导用户关闭限制的文案。
 */
fun batteryOptimizationDiagnostic(environment: CompanionDeviceEnvironment): String? =
    if (environment.batteryOptimizationIgnored) {
        null
    } else {
        "Companion 未豁免电池优化，后台可能被系统限制；请在系统设置里把灵犀加入「不优化」名单"
    }

/** 已尝试的恢复动作摘要；用于失败信封里的 recoveries 字段。 */
fun recoverySummary(
    rootAttempts: Int? = null,
    dumpAttempts: Int? = null,
    accessibilityStateReconfirmed: Boolean = false,
): String = buildList {
    if (rootAttempts != null) add("root_attempts=$rootAttempts")
    if (dumpAttempts != null) add("dump_attempts=$dumpAttempts")
    if (accessibilityStateReconfirmed) add("accessibility_state_reconfirmed")
}.joinToString(",").ifBlank { "none" }
