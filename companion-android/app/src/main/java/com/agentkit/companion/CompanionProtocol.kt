package com.agentkit.companion

/** Companion HTTP v3 对外暴露的稳定错误码，BFF 不再依赖中文文案判断失败原因。 */
enum class CompanionProtocolErrorCode {
    ACCESSIBILITY_SERVICE_UNAVAILABLE,
    TREE_CAPTURE_BUSY,
    TREE_CAPTURE_TIMEOUT,
    TREE_ROOT_UNAVAILABLE,
    TREE_ROOT_EMPTY,
    TREE_DUMP_EMPTY,
    TREE_DUMP_FAILED,
    NODE_REF_STALE,
    NODE_ACTION_UNSUPPORTED,
    TOUCH_EXPLORATION_UNAVAILABLE,
    /** 锁屏：无障碍不可用的确定性原因，不做任何自动恢复。 */
    DEVICE_LOCKED,
    INVALID_REQUEST,
}

/** 错误发生的协议阶段，用于让调用方选择安全的下一步。 */
enum class CompanionProtocolStage(val wireValue: String) {
    CAPTURE("capture"),
    NODE_ACTION("node_action"),
    TOUCH_EXPLORATION("touch_exploration"),
    PROTOCOL("protocol"),
}

/** 单个失败的机器可读语义，message 仅用于展示给用户和日志。 */
data class CompanionProtocolError(
    val code: CompanionProtocolErrorCode,
    val stage: CompanionProtocolStage,
    val message: String,
    val retryable: Boolean,
)

/** 根节点诊断摘要；只记录结构和状态，不记录业务文本。 */
data class CompanionRootDiagnostics(
    val windowId: Int,
    val packageName: String,
    val className: String,
    val childCount: Int,
    val visibleToUser: Boolean,
) {
    fun toPayload(): Map<String, Any> = linkedMapOf(
        "windowId" to windowId,
        "packageName" to packageName,
        "className" to className,
        "childCount" to childCount,
        "visibleToUser" to visibleToUser,
    )
}

/** 每次失败都记录请求当时真实的运行状态，禁止由上层猜测补造。 */
data class CompanionProtocolDiagnostics(
    val requestId: Long,
    val elapsedMs: Long,
    val timeoutMs: Long,
    val serviceConnected: Boolean,
    val httpListening: Boolean,
    /** 失败当刻重新确认过的无障碍能力，避免用过期 health 值解释失败。 */
    val accessibilityCanRetrieveWindowContent: Boolean? = null,
    val accessibilityTouchExploration: Boolean? = null,
    val root: CompanionRootDiagnostics? = null,
    val visitedNodeCount: Int? = null,
    val childReadFailures: Int? = null,
    val interestingNodeCount: Int? = null,
    val visibleSemanticNodeCount: Int? = null,
    val truncated: Boolean? = null,
    val dumpElapsedMs: Long? = null,
    /** 设备是否处于锁屏；只在真的读取过系统状态后写入。 */
    val deviceLocked: Boolean? = null,
    /** 是否已豁免电池优化；false 表示受系统省电限制，只做诊断提示。 */
    val batteryOptimizationIgnored: Boolean? = null,
    /** 本次请求已经尝试过的恢复动作摘要，供调用方判断还能做什么。 */
    val recoveries: String? = null,
) {
    /** 使用 JVM 可测试的 Map 表示载荷，HTTP 层在 Android 运行时负责 JSON 序列化。 */
    fun toPayload(): Map<String, Any> = linkedMapOf<String, Any>(
        "requestId" to requestId,
        "elapsedMs" to elapsedMs,
        "timeoutMs" to timeoutMs,
        "serviceConnected" to serviceConnected,
        "httpListening" to httpListening,
    ).apply {
        accessibilityCanRetrieveWindowContent?.let { put("accessibilityCanRetrieveWindowContent", it) }
        accessibilityTouchExploration?.let { put("accessibilityTouchExploration", it) }
        // root 只有 Android 实际拿到 root 后才存在，禁止用空值伪造“已拿到 root”。
        root?.let { put("root", it.toPayload()) }
        // 遍历统计只在实际执行过 dump 时写入，避免把未执行阶段误报成 0。
        visitedNodeCount?.let { put("visitedNodeCount", it) }
        childReadFailures?.let { put("childReadFailures", it) }
        interestingNodeCount?.let { put("interestingNodeCount", it) }
        visibleSemanticNodeCount?.let { put("visibleSemanticNodeCount", it) }
        truncated?.let { put("truncated", it) }
        dumpElapsedMs?.let { put("dumpElapsedMs", it) }
        deviceLocked?.let { put("deviceLocked", it) }
        batteryOptimizationIgnored?.let { put("batteryOptimizationIgnored", it) }
        recoveries?.let { put("recoveries", it) }
    }
}

/** 统一维护每类失败的可读文案与可重试性，路由层只选择已定义的真实失败类型。 */
object CompanionProtocolFailures {
    fun accessibilityServiceUnavailable() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.ACCESSIBILITY_SERVICE_UNAVAILABLE,
        stage = CompanionProtocolStage.CAPTURE,
        message = "无障碍服务未就绪",
        retryable = true,
    )

    fun treeCaptureBusy() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TREE_CAPTURE_BUSY,
        stage = CompanionProtocolStage.CAPTURE,
        message = "节点树正在读取，请稍后重试",
        retryable = true,
    )

    fun treeCaptureTimeout() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TREE_CAPTURE_TIMEOUT,
        stage = CompanionProtocolStage.CAPTURE,
        message = "节点树读取超时",
        retryable = true,
    )

    fun treeRootUnavailable() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TREE_ROOT_UNAVAILABLE,
        stage = CompanionProtocolStage.CAPTURE,
        message = "无法获取节点树根节点",
        retryable = true,
    )

    fun treeRootEmpty() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TREE_ROOT_EMPTY,
        stage = CompanionProtocolStage.CAPTURE,
        message = "已获取无障碍 root，但 root 当前没有可遍历内容",
        retryable = true,
    )

    fun treeDumpEmpty() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TREE_DUMP_EMPTY,
        stage = CompanionProtocolStage.CAPTURE,
        message = "已获取无障碍 root，但遍历后没有可用语义节点",
        retryable = true,
    )

    fun treeDumpFailed() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TREE_DUMP_FAILED,
        stage = CompanionProtocolStage.CAPTURE,
        message = "节点树读取失败",
        retryable = false,
    )

    fun nodeRefStale(ref: Int) = CompanionProtocolError(
        code = CompanionProtocolErrorCode.NODE_REF_STALE,
        stage = CompanionProtocolStage.NODE_ACTION,
        message = "节点引用已失效：ref=$ref",
        retryable = false,
    )

    fun nodeActionUnsupported(action: String) = CompanionProtocolError(
        code = CompanionProtocolErrorCode.NODE_ACTION_UNSUPPORTED,
        stage = CompanionProtocolStage.NODE_ACTION,
        message = "节点不支持操作：$action",
        retryable = false,
    )

    fun touchExplorationUnavailable() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.TOUCH_EXPLORATION_UNAVAILABLE,
        stage = CompanionProtocolStage.TOUCH_EXPLORATION,
        message = "Touch Exploration 服务不可用或未切换成功",
        retryable = true,
    )

    /**
     * 锁屏：无障碍在锁屏下不可靠，且不属于任何可自动恢复的故障。
     * 明确标记为不可重试，调用方应提示用户解锁而不是反复抓树或重启组件。
     */
    fun deviceLocked() = CompanionProtocolError(
        code = CompanionProtocolErrorCode.DEVICE_LOCKED,
        stage = CompanionProtocolStage.CAPTURE,
        message = "设备当前处于锁屏状态，Companion 无法保证 Accessibility 操作可靠，请解锁设备后重试",
        retryable = false,
    )

    fun invalidRequest(message: String) = CompanionProtocolError(
        code = CompanionProtocolErrorCode.INVALID_REQUEST,
        stage = CompanionProtocolStage.PROTOCOL,
        message = message,
        retryable = false,
    )
}

/** 统一生成 v3 非成功载荷，避免路由重新退回仅含 message 的旧协议。 */
fun companionErrorPayload(
    error: CompanionProtocolError,
    diagnostics: CompanionProtocolDiagnostics,
): Map<String, Any> = linkedMapOf(
    "ok" to false,
    "error" to linkedMapOf(
        "code" to error.code.name,
        "stage" to error.stage.wireValue,
        "message" to error.message,
        "retryable" to error.retryable,
    ),
    "diagnostics" to diagnostics.toPayload(),
)
