package com.agentkit.companion

import java.util.ArrayDeque

/** 无障碍事件的轻量标记，避免把系统 AccessibilityEvent 对象跨线程或跨回调保存。 */
data class AccessibilityEventMarker(
    val sequence: Long = 0L,
    val packageName: String = "",
    val windowId: Int = -1,
    val eventTime: Long = 0L,
)

/**
 * 记录事件序号并支持按目标包等待新事件。
 *
 * 抓树线程只等待这个独立监视器，不再持有 AccessibilityService 的对象锁，事件回调可以
 * 在应用异步重建语义树期间持续进入并留下可核对的窗口 ID 与 eventTime。
 */
class AccessibilityEventTracker {
    private val monitor = java.lang.Object()
    private val events = ArrayDeque<AccessibilityEventMarker>()
    private var nextSequence = 0L

    fun snapshot(): AccessibilityEventMarker = synchronized(monitor) {
        events.peekLast() ?: AccessibilityEventMarker(sequence = nextSequence)
    }

    fun record(packageName: String, windowId: Int, eventTime: Long): AccessibilityEventMarker {
        synchronized(monitor) {
            nextSequence += 1
            val marker = AccessibilityEventMarker(
                sequence = nextSequence,
                packageName = packageName,
                windowId = windowId,
                eventTime = eventTime,
            )
            events.addLast(marker)
            while (events.size > 200) events.removeFirst()
            monitor.notifyAll()
            return marker
        }
    }

    fun findAfter(sinceSequence: Long, packageName: String?): AccessibilityEventMarker? =
        synchronized(monitor) {
            findAfterLocked(sinceSequence, packageName)
        }

    /** 在限定时间内等待目标包的新事件；超时返回 null，不伪造事件已到达。 */
    fun awaitAfter(
        sinceSequence: Long,
        packageName: String?,
        timeoutMs: Long,
    ): AccessibilityEventMarker? {
        val deadline = System.nanoTime() + timeoutMs.coerceAtLeast(0L) * 1_000_000L
        synchronized(monitor) {
            while (true) {
                findAfterLocked(sinceSequence, packageName)?.let { return it }
                val remainingNs = deadline - System.nanoTime()
                if (remainingNs <= 0L) return null
                val remainingMs = (remainingNs / 1_000_000L).coerceAtLeast(1L)
                monitor.wait(remainingMs)
            }
        }
    }

    private fun findAfterLocked(
        sinceSequence: Long,
        packageName: String?,
    ): AccessibilityEventMarker? {
        return events.firstOrNull { marker ->
            marker.sequence > sinceSequence &&
                (packageName == null || marker.packageName == packageName)
        }
    }
}
