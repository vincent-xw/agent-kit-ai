package com.agentkit.companion

import org.json.JSONArray
import org.json.JSONObject

internal data class PreparedTreeSnapshotPayload(
    val packageName: String,
    val screenWidth: Int,
    val screenHeight: Int,
    val nodesJson: String,
    val accessibilityMode: String,
    val rootWindowId: Int,
    val rootClassName: String,
    val rootChildCount: Int,
    val rootVisibleToUser: Boolean,
) {
    fun toJson(snapshotId: String): JSONObject = JSONObject().apply {
        put("snapshotId", snapshotId)
        put("packageName", packageName)
        put("screenWidth", screenWidth)
        put("screenHeight", screenHeight)
        put("nodes", JSONArray(nodesJson))
        put("accessibilityMode", accessibilityMode)
        put(
            "root",
            JSONObject().apply {
                put("windowId", rootWindowId)
                put("packageName", packageName)
                put("className", rootClassName)
                put("childCount", rootChildCount)
                put("visibleToUser", rootVisibleToUser)
            },
        )
    }
}

internal data class PreparedTreeObservation(
    val payload: PreparedTreeSnapshotPayload,
    val mode: CompanionCaptureMode,
    val eventSequence: Long,
    val capturedAtElapsedMs: Long,
    val nodeCount: Int,
    val visibleSemanticNodeCount: Int,
)

internal fun treePreparationDelayMs(
    nowElapsedMs: Long,
    lastEventElapsedMs: Long,
    lastStartedElapsedMs: Long,
    debounceMs: Long,
    minimumIntervalMs: Long,
): Long {
    val quietWindowRemaining = debounceMs - (nowElapsedMs - lastEventElapsedMs)
    val intervalRemaining = if (lastStartedElapsedMs == 0L) {
        0L
    } else {
        minimumIntervalMs - (nowElapsedMs - lastStartedElapsedMs)
    }
    return maxOf(0L, quietWindowRemaining, intervalRemaining)
}

/** 只保留一份短时快照；事件推进、模式变化、目标变化或过期都会让缓存失去可读性。 */
internal class PreparedTreeObservationCache(
    private val maxAgeMs: Long = DEFAULT_MAX_AGE_MS,
) {
    @Volatile
    private var latest: PreparedTreeObservation? = null

    /** 空节点或 Enhanced 缺少可见语义的结果不得覆盖上一份有效观察。 */
    fun publish(observation: PreparedTreeObservation): Boolean {
        if (observation.nodeCount == 0) return false
        if (observation.mode.requiresVisibleSemanticNodes && observation.visibleSemanticNodeCount == 0) return false
        latest = observation
        return true
    }

    /** 只有捕获期间没有新事件、且页面仍匹配触发包名时，才提交预热结果。 */
    fun publishIfCurrent(
        observation: PreparedTreeObservation,
        currentEventSequence: Long,
        targetPackage: String?,
    ): Boolean {
        if (observation.eventSequence != currentEventSequence) return false
        if (!targetPackage.isNullOrBlank() && observation.payload.packageName != targetPackage) return false
        return publish(observation)
    }

    fun find(
        targetPackage: String?,
        mode: CompanionCaptureMode,
        nowElapsedMs: Long,
        currentEventSequence: Long,
    ): PreparedTreeObservation? {
        val observation = latest ?: return null
        if (observation.mode != mode) return null
        if (!targetPackage.isNullOrBlank() && observation.payload.packageName != targetPackage) return null
        if (nowElapsedMs < observation.capturedAtElapsedMs) return null
        if (nowElapsedMs - observation.capturedAtElapsedMs > maxAgeMs) return null
        if (observation.eventSequence != currentEventSequence) return null
        return observation
    }

    fun clear() {
        latest = null
    }

    companion object {
        const val DEFAULT_MAX_AGE_MS = 1_000L
    }
}
