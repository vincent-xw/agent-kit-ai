package com.agentkit.companion

/** 当前系统 Touch Exploration 状态；不再决定本次抓树的等待预算。 */
enum class CompanionCaptureMode(
    val wireValue: String,
    val requiresVisibleSemanticNodes: Boolean,
    val legacyCaptureLevel: CompanionCaptureLevel,
) {
    NORMAL("normal", false, CompanionCaptureLevel.FAST),
    ENHANCED("enhanced", true, CompanionCaptureLevel.DEEP),
    ;

    companion object {
        /** 解析协议中的模式；未知值拒绝请求，避免把调用方的拼写错误静默降级。 */
        fun fromWire(value: String?): CompanionCaptureMode = when (value) {
            null -> NORMAL
            "normal" -> NORMAL
            "enhanced" -> ENHANCED
            else -> throw IllegalArgumentException("未知 Companion 抓取模式：$value")
        }
    }
}

/** LLM 可选的抓树等级；deep 只延长同一帧 root/tree 探测，始终受 5 秒预算限制。 */
enum class CompanionCaptureLevel(
    val wireValue: String,
    val maxWaitMs: Long,
    val rootCaptureAttempts: Int,
    val rootCaptureRetryDelayMs: Long,
    val dumpRetryAttempts: Int,
    val dumpRetryDelayMs: Long,
    val requiresVisibleSemanticNodes: Boolean,
    val requestTimeoutMs: Long,
) {
    FAST("fast", 0L, 1, 0L, 1, 0L, false, 10_000L),
    // coordinator 多留 1 秒收尾/序列化；额外 root 重探本身仍严格受 maxWaitMs 限制。
    DEEP("deep", 5_000L, 20, 250L, 1, 0L, true, 6_000L),
    ;

    /** fast 只做首次读取；deep 的重探同时受尝试次数与绝对时间预算约束。 */
    fun allowsAttempt(attempt: Int, elapsedMs: Long): Boolean =
        attempt in 1..rootCaptureAttempts && (attempt == 1 || elapsedMs < maxWaitMs)

    fun canRetry(attempt: Int, elapsedMs: Long): Boolean =
        attempt < rootCaptureAttempts && elapsedMs < maxWaitMs

    /** 最后一段等待会被裁到剩余预算内，避免固定间隔越过 deadline。 */
    fun nextRetryDelayMs(elapsedMs: Long): Long =
        (maxWaitMs - elapsedMs).coerceAtLeast(0L).coerceAtMost(rootCaptureRetryDelayMs)

    companion object {
        /** 未指定等级的新请求走 fast；mode=enhanced 的旧客户端保留原有深探行为。 */
        fun fromWire(value: String?): CompanionCaptureLevel = when (value) {
            null, "fast" -> FAST
            "deep" -> DEEP
            else -> throw IllegalArgumentException("未知 Companion 抓取等级：$value")
        }
    }
}
