package com.agentkit.companion

/**
 * 控制无障碍事件是否进入可见诊断日志。
 *
 * 事件原文仍保存在 CompanionAccessibilityService 的 Debug 缓冲中；这里仅过滤
 * 系统空闲噪声和短时间内重复事件，避免日志窗口持续滚动影响用户判断。
 */
internal class AccessibilityEventLogPolicy(
    private val minimumRepeatIntervalMs: Long = 5_000L,
    private val noisyPackages: Set<String> = setOf("com.android.systemui"),
) {
    private var lastLoggedEventKey = ""
    private var lastLoggedEventAt = 0L

    /** 返回 true 表示该事件应追加到可见日志，并记录本次事件作为聚合基准。 */
    fun shouldLog(packageName: String, eventKey: String, now: Long): Boolean {
        if (packageName in noisyPackages) return false
        if (eventKey == lastLoggedEventKey && now - lastLoggedEventAt < minimumRepeatIntervalMs) return false
        lastLoggedEventKey = eventKey
        lastLoggedEventAt = now
        return true
    }
}
