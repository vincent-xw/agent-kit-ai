package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PreparedTreeObservationCacheTest {
    @Test
    fun `只向相同设备页面模式返回新鲜且未被新事件覆盖的观察`() {
        val cache = PreparedTreeObservationCache(maxAgeMs = 1_000L)
        val observation = observation()
        assertTrue(cache.publish(observation))

        assertEquals(observation, cache.find("com.tencent.mm", CompanionCaptureMode.NORMAL, 1_500L, 7L))
        assertNull(cache.find("com.other.app", CompanionCaptureMode.NORMAL, 1_500L, 7L))
        assertNull(cache.find("com.tencent.mm", CompanionCaptureMode.ENHANCED, 1_500L, 7L))
        assertNull(cache.find("com.tencent.mm", CompanionCaptureMode.NORMAL, 2_001L, 7L))
        assertNull(cache.find("com.tencent.mm", CompanionCaptureMode.NORMAL, 1_500L, 8L))
    }

    @Test
    fun `空树或缺少增强语义的结果不会覆盖最后一次有效观察`() {
        val cache = PreparedTreeObservationCache(maxAgeMs = 1_000L)
        val valid = observation()
        assertTrue(cache.publish(valid))

        assertFalse(cache.publish(observation(nodesJson = "[]", nodeCount = 0)))
        assertFalse(
            cache.publish(
                observation(
                    mode = CompanionCaptureMode.ENHANCED,
                    eventSequence = 8L,
                    visibleSemanticNodeCount = 0,
                ),
            ),
        )

        assertEquals(valid, cache.find("com.tencent.mm", CompanionCaptureMode.NORMAL, 1_500L, 7L))
    }

    @Test
    fun `预热期间出现新事件时旧页面结果不会发布`() {
        val cache = PreparedTreeObservationCache(maxAgeMs = 1_000L)

        assertFalse(
            cache.publishIfCurrent(
                observation(eventSequence = 7L),
                currentEventSequence = 8L,
                targetPackage = "com.tencent.mm",
            ),
        )
        assertNull(cache.find("com.tencent.mm", CompanionCaptureMode.NORMAL, 1_500L, 8L))
        assertFalse(
            cache.publishIfCurrent(
                observation(eventSequence = 8L),
                currentEventSequence = 8L,
                targetPackage = "com.other.app",
            ),
        )
        assertTrue(
            cache.publishIfCurrent(
                observation(eventSequence = 8L),
                currentEventSequence = 8L,
                targetPackage = "com.tencent.mm",
            ),
        )
    }

    @Test
    fun `事件预热等待静默窗口并限制连续抓取频率`() {
        assertEquals(
            70L,
            treePreparationDelayMs(
                nowElapsedMs = 1_000L,
                lastEventElapsedMs = 950L,
                lastStartedElapsedMs = 700L,
                debounceMs = 120L,
                minimumIntervalMs = 350L,
            ),
        )
        assertEquals(
            250L,
            treePreparationDelayMs(
                nowElapsedMs = 1_000L,
                lastEventElapsedMs = 850L,
                lastStartedElapsedMs = 900L,
                debounceMs = 120L,
                minimumIntervalMs = 350L,
            ),
        )
    }

    private fun observation(
        mode: CompanionCaptureMode = CompanionCaptureMode.NORMAL,
        eventSequence: Long = 7L,
        nodesJson: String = "[{\"ref\":0}]",
        nodeCount: Int = 1,
        visibleSemanticNodeCount: Int = 1,
    ) = PreparedTreeObservation(
        payload = PreparedTreeSnapshotPayload(
            packageName = "com.tencent.mm",
            screenWidth = 1080,
            screenHeight = 1920,
            nodesJson = nodesJson,
            accessibilityMode = if (mode == CompanionCaptureMode.ENHANCED) "touch_exploration" else "normal",
            rootWindowId = 142,
            rootClassName = "android.view.View",
            rootChildCount = 4,
            rootVisibleToUser = true,
        ),
        mode = mode,
        eventSequence = eventSequence,
        capturedAtElapsedMs = 1_000L,
        nodeCount = nodeCount,
        visibleSemanticNodeCount = visibleSemanticNodeCount,
    )
}
