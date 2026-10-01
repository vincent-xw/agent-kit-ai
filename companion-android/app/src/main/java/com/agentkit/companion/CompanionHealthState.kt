package com.agentkit.companion

const val COMPANION_PROTOCOL_VERSION = 3

data class CompanionHttpHealth(
    val listening: Boolean,
    val lastHeartbeatAt: Long,
)

data class CompanionAccessibilityHealth(
    val authorized: Boolean,
    val canRetrieveWindowContent: Boolean,
    val touchExploration: Boolean,
    val lastEventAt: Long,
)

data class CompanionTreeHealth(
    val busy: Boolean,
    val stuck: Boolean,
    val lastSuccessAt: Long,
    val lastDurationMs: Long,
    val lastNodeCount: Int,
    val lastError: String?,
)

data class CompanionHealthSnapshot(
    val protocolVersion: Int,
    val appVersion: String,
    val processStartedAt: Long,
    val serviceConnected: Boolean,
    /** 锁屏与电池优化只暴露事实，由调用方决定提示什么。 */
    val deviceLocked: Boolean,
    val batteryOptimizationIgnored: Boolean,
    val httpServer: CompanionHttpHealth,
    val accessibility: CompanionAccessibilityHealth,
    val treeCapture: CompanionTreeHealth,
)

/**
 * Companion 进程内唯一的健康状态源。
 *
 * HTTP、无障碍回调和抓树执行器来自不同线程，因此所有读写都通过同一把实例锁完成，
 * snapshot 始终返回一组时间上自洽的不可变值。
 */
class CompanionHealthState(
    private val processStartedAt: Long = System.currentTimeMillis(),
    private val appVersion: String = BuildConfig.VERSION_NAME,
) {
    private var serviceConnected = false
    private var deviceLocked = false
    private var batteryOptimizationIgnored = false
    private var httpListening = false
    private var lastHeartbeatAt = 0L
    private var accessibilityAuthorized = false
    private var canRetrieveWindowContent = false
    private var touchExploration = false
    private var lastAccessibilityEventAt = 0L
    private var treeBusy = false
    private var treeStuck = false
    private var lastTreeSuccessAt = 0L
    private var lastTreeAttemptAt = 0L
    private var lastTreeDurationMs = 0L
    private var lastTreeNodeCount = 0
    private var lastTreeError: String? = null

    @Synchronized
    fun setServiceConnected(connected: Boolean) {
        serviceConnected = connected
    }

    /** 设备环境事实由标准 API 读取后写入；未读取过时保持上一次已知值。 */
    @Synchronized
    fun setDeviceEnvironment(locked: Boolean, batteryOptimizationIgnored: Boolean) {
        deviceLocked = locked
        this.batteryOptimizationIgnored = batteryOptimizationIgnored
    }

    @Synchronized
    fun setHttpListening(listening: Boolean, heartbeatAt: Long) {
        httpListening = listening
        lastHeartbeatAt = heartbeatAt
    }

    @Synchronized
    fun setAccessibilityState(
        authorized: Boolean,
        canRetrieveWindowContent: Boolean,
        touchExploration: Boolean,
    ) {
        accessibilityAuthorized = authorized
        this.canRetrieveWindowContent = canRetrieveWindowContent
        this.touchExploration = touchExploration
    }

    @Synchronized
    fun recordAccessibilityEvent(at: Long) {
        lastAccessibilityEventAt = at
    }

    @Synchronized
    fun recordTreeSuccess(at: Long, durationMs: Long, nodeCount: Int) {
        lastTreeAttemptAt = at
        lastTreeSuccessAt = at
        lastTreeDurationMs = durationMs
        lastTreeNodeCount = nodeCount
        lastTreeError = null
    }

    @Synchronized
    fun recordTreeFailure(at: Long, durationMs: Long, error: String) {
        lastTreeAttemptAt = at
        lastTreeDurationMs = durationMs
        lastTreeError = error
    }

    @Synchronized
    fun setTreeExecution(busy: Boolean, stuck: Boolean) {
        treeBusy = busy
        treeStuck = stuck
    }

    @Synchronized
    fun snapshot(): CompanionHealthSnapshot = CompanionHealthSnapshot(
        protocolVersion = COMPANION_PROTOCOL_VERSION,
        appVersion = appVersion,
        processStartedAt = processStartedAt,
        serviceConnected = serviceConnected,
        deviceLocked = deviceLocked,
        batteryOptimizationIgnored = batteryOptimizationIgnored,
        httpServer = CompanionHttpHealth(
            listening = httpListening,
            lastHeartbeatAt = lastHeartbeatAt,
        ),
        accessibility = CompanionAccessibilityHealth(
            authorized = accessibilityAuthorized,
            canRetrieveWindowContent = canRetrieveWindowContent,
            touchExploration = touchExploration,
            lastEventAt = lastAccessibilityEventAt,
        ),
        treeCapture = CompanionTreeHealth(
            busy = treeBusy,
            stuck = treeStuck,
            lastSuccessAt = lastTreeSuccessAt,
            lastDurationMs = lastTreeDurationMs,
            lastNodeCount = lastTreeNodeCount,
            lastError = lastTreeError,
        ),
    )
}

object CompanionRuntimeHealth {
    val state = CompanionHealthState()
}

/** 严格生成 protocol v3 health 载荷；字段集合由单元测试锁定，HTTP 层不得自行增删。 */
object CompanionHealthPayload {
    fun from(snapshot: CompanionHealthSnapshot): Map<String, Any?> = linkedMapOf(
        "protocolVersion" to snapshot.protocolVersion,
        "appVersion" to snapshot.appVersion,
        "processStartedAt" to snapshot.processStartedAt,
        "serviceConnected" to snapshot.serviceConnected,
        "deviceLocked" to snapshot.deviceLocked,
        "batteryOptimizationIgnored" to snapshot.batteryOptimizationIgnored,
        "httpServer" to linkedMapOf(
            "listening" to snapshot.httpServer.listening,
            "lastHeartbeatAt" to snapshot.httpServer.lastHeartbeatAt,
        ),
        "accessibility" to linkedMapOf(
            "authorized" to snapshot.accessibility.authorized,
            "canRetrieveWindowContent" to snapshot.accessibility.canRetrieveWindowContent,
            "touchExploration" to snapshot.accessibility.touchExploration,
            "lastEventAt" to snapshot.accessibility.lastEventAt,
        ),
        "treeCapture" to linkedMapOf(
            "busy" to snapshot.treeCapture.busy,
            "stuck" to snapshot.treeCapture.stuck,
            "lastSuccessAt" to snapshot.treeCapture.lastSuccessAt,
            "lastDurationMs" to snapshot.treeCapture.lastDurationMs,
            "lastNodeCount" to snapshot.treeCapture.lastNodeCount,
            "lastError" to snapshot.treeCapture.lastError,
        ),
    )
}
