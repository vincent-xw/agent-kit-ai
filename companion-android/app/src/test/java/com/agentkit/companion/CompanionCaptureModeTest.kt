package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionCaptureModeTest {
    @Test
    fun `未指定抓取模式保持普通模式以兼容旧客户端`() {
        assertEquals(CompanionCaptureMode.NORMAL, CompanionCaptureMode.fromWire(null))
        assertEquals(CompanionCaptureMode.NORMAL, CompanionCaptureMode.fromWire("normal"))
    }

    @Test
    fun `旧增强客户端映射到 deep 抓取等级`() {
        assertEquals(CompanionCaptureMode.ENHANCED, CompanionCaptureMode.fromWire("enhanced"))
        assertEquals(CompanionCaptureLevel.FAST, CompanionCaptureMode.NORMAL.legacyCaptureLevel)
        assertEquals(CompanionCaptureLevel.DEEP, CompanionCaptureMode.ENHANCED.legacyCaptureLevel)
    }

    @Test
    fun `Touch Exploration 状态独立决定可见语义节点要求`() {
        assertTrue(CompanionCaptureMode.ENHANCED.requiresVisibleSemanticNodes)
        assertFalse(CompanionCaptureMode.NORMAL.requiresVisibleSemanticNodes)
    }
}
