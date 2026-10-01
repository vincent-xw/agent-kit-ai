package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AccessibilityEventTrackerTest {
    @Test
    fun `基线之后的目标包事件可以被识别`() {
        val tracker = AccessibilityEventTracker()
        val baseline = tracker.snapshot()
        tracker.record(packageName = "com.android.systemui", windowId = 1, eventTime = 10L)
        tracker.record(packageName = "com.tencent.mm", windowId = 42, eventTime = 20L)

        val event = tracker.findAfter(
            sinceSequence = baseline.sequence,
            packageName = "com.tencent.mm",
        )

        assertNotNull(event)
        assertEquals("com.tencent.mm", event?.packageName)
        assertEquals(42, event?.windowId)
        assertEquals(20L, event?.eventTime)
    }

    @Test
    fun `目标包没有新事件时不能误报事件已经到达`() {
        val tracker = AccessibilityEventTracker()
        val baseline = tracker.snapshot()
        tracker.record(packageName = "com.android.systemui", windowId = 1, eventTime = 10L)

        assertNull(
            tracker.findAfter(
                sinceSequence = baseline.sequence,
                packageName = "com.tencent.mm",
            ),
        )
    }
}
