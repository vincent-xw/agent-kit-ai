package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionDeviceEnvironmentTest {
    @Test
    fun `锁屏时直接返回不可重试的 DEVICE_LOCKED`() {
        val error = deviceLockedFailureOrNull(
            CompanionDeviceEnvironment(locked = true, batteryOptimizationIgnored = true),
        )

        assertEquals(CompanionProtocolErrorCode.DEVICE_LOCKED, error?.code)
        assertEquals(CompanionProtocolStage.CAPTURE, error?.stage)
        assertFalse(error!!.retryable)
        assertTrue(error.message.contains("锁屏"))
        assertTrue(error.message.contains("解锁设备后重试"))
    }

    @Test
    fun `未锁屏时不产生 DEVICE_LOCKED，继续正常抓树`() {
        assertNull(
            deviceLockedFailureOrNull(
                CompanionDeviceEnvironment(locked = false, batteryOptimizationIgnored = false),
            ),
        )
    }

    @Test
    fun `省电限制只做诊断提示，不进入失败码`() {
        assertNull(
            batteryOptimizationDiagnostic(
                CompanionDeviceEnvironment(locked = false, batteryOptimizationIgnored = true),
            ),
        )
        val diagnostic = batteryOptimizationDiagnostic(
            CompanionDeviceEnvironment(locked = false, batteryOptimizationIgnored = false),
        )
        assertTrue(diagnostic!!.contains("电池优化"))
        assertTrue(diagnostic.contains("不优化"))
    }

    @Test
    fun `recoveries 摘要只记录真实执行过的恢复动作`() {
        assertEquals("none", recoverySummary())
        assertEquals("root_attempts=5", recoverySummary(rootAttempts = 5))
        assertEquals(
            "root_attempts=5,dump_attempts=3",
            recoverySummary(rootAttempts = 5, dumpAttempts = 3),
        )
        assertEquals(
            "root_attempts=5,dump_attempts=1,accessibility_state_reconfirmed",
            recoverySummary(rootAttempts = 5, dumpAttempts = 1, accessibilityStateReconfirmed = true),
        )
    }
}
