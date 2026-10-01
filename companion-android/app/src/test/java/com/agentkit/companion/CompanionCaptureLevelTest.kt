package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionCaptureLevelTest {
    @Test
    fun `未指定抓取等级立即使用 fast 且不安排额外重试`() {
        assertEquals(CompanionCaptureLevel.FAST, CompanionCaptureLevel.fromWire(null))
        assertFalse(CompanionCaptureLevel.FAST.canRetry(attempt = 1, elapsedMs = 0L))
        assertEquals(0L, CompanionCaptureLevel.FAST.nextRetryDelayMs(elapsedMs = 0L))
    }

    @Test
    fun `deep 允许有限重探且不会越过五秒预算`() {
        assertEquals(CompanionCaptureLevel.DEEP, CompanionCaptureLevel.fromWire("deep"))
        assertTrue(CompanionCaptureLevel.DEEP.canRetry(attempt = 1, elapsedMs = 4_900L))
        assertTrue(CompanionCaptureLevel.DEEP.allowsAttempt(attempt = 19, elapsedMs = 4_999L))
        assertEquals(100L, CompanionCaptureLevel.DEEP.nextRetryDelayMs(elapsedMs = 4_900L))
        assertFalse(CompanionCaptureLevel.DEEP.allowsAttempt(attempt = 20, elapsedMs = 5_000L))
        assertFalse(CompanionCaptureLevel.DEEP.canRetry(attempt = 20, elapsedMs = 5_000L))
        assertEquals(0L, CompanionCaptureLevel.DEEP.nextRetryDelayMs(elapsedMs = 5_000L))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `未知抓取等级不会静默降级`() {
        CompanionCaptureLevel.fromWire("automatic")
    }
}
