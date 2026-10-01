package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionProtocolTest {
    @Test
    fun `空壳 root 使用可重试的 TREE_ROOT_EMPTY 机器码`() {
        val error = CompanionProtocolFailures.treeRootEmpty()

        assertEquals(CompanionProtocolErrorCode.TREE_ROOT_EMPTY, error.code)
        assertEquals(CompanionProtocolStage.CAPTURE, error.stage)
        assertTrue(error.retryable)
    }

    /** 防止 HTTP 路由把抓树忙错误重新映射为泛化的节点树读取失败。 */
    @Test
    fun `抓树忙使用可重试的 TREE_CAPTURE_BUSY 映射`() {
        val error = CompanionProtocolFailures.treeCaptureBusy()

        assertEquals(CompanionProtocolErrorCode.TREE_CAPTURE_BUSY, error.code)
        assertEquals(CompanionProtocolStage.CAPTURE, error.stage)
        assertEquals("节点树正在读取，请稍后重试", error.message)
        assertTrue(error.retryable)
    }

    /** 防止 Android 端重新退回只有中文 message 的不可诊断错误。 */
    @Test
    fun `抓树超时返回包含机器码阶段与真实诊断的 v3 信封`() {
        val payload = companionErrorPayload(
            error = CompanionProtocolError(
                code = CompanionProtocolErrorCode.TREE_CAPTURE_TIMEOUT,
                stage = CompanionProtocolStage.CAPTURE,
                message = "节点树读取超时",
                retryable = true,
            ),
            diagnostics = CompanionProtocolDiagnostics(
                requestId = 31L,
                elapsedMs = 1000L,
                timeoutMs = 1000L,
                serviceConnected = true,
                httpListening = true,
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val error = payload.getValue("error") as Map<String, Any>
        @Suppress("UNCHECKED_CAST")
        val diagnostics = payload.getValue("diagnostics") as Map<String, Any>
        assertFalse(payload.getValue("ok") as Boolean)
        assertEquals("TREE_CAPTURE_TIMEOUT", error.getValue("code"))
        assertEquals("capture", error.getValue("stage"))
        assertEquals("节点树读取超时", error.getValue("message"))
        assertTrue(error.getValue("retryable") as Boolean)
        assertEquals(31L, diagnostics.getValue("requestId"))
        assertEquals(1000L, diagnostics.getValue("elapsedMs"))
        assertEquals(1000L, diagnostics.getValue("timeoutMs"))
        assertTrue(diagnostics.getValue("serviceConnected") as Boolean)
        assertTrue(diagnostics.getValue("httpListening") as Boolean)
    }

    @Test
    fun `空树诊断保留遍历失败统计`() {
        val payload = companionErrorPayload(
            error = CompanionProtocolFailures.treeDumpEmpty(),
            diagnostics = CompanionProtocolDiagnostics(
                requestId = 32L,
                elapsedMs = 300L,
                timeoutMs = 10_000L,
                serviceConnected = true,
                httpListening = true,
                visitedNodeCount = 1,
                childReadFailures = 20,
                interestingNodeCount = 0,
                visibleSemanticNodeCount = 0,
                truncated = false,
                dumpElapsedMs = 30L,
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val diagnostics = payload.getValue("diagnostics") as Map<String, Any>
        assertEquals(1, diagnostics.getValue("visitedNodeCount"))
        assertEquals(20, diagnostics.getValue("childReadFailures"))
        assertEquals(0, diagnostics.getValue("interestingNodeCount"))
        assertEquals(0, diagnostics.getValue("visibleSemanticNodeCount"))
        assertFalse(diagnostics.getValue("truncated") as Boolean)
        assertEquals(30L, diagnostics.getValue("dumpElapsedMs"))
    }

    @Test
    fun `锁屏返回 DEVICE_LOCKED 且诊断带上设备环境与恢复摘要`() {
        val payload = companionErrorPayload(
            error = CompanionProtocolFailures.deviceLocked(),
            diagnostics = CompanionProtocolDiagnostics(
                requestId = 33L,
                elapsedMs = 5L,
                timeoutMs = 10_000L,
                serviceConnected = true,
                httpListening = true,
                accessibilityCanRetrieveWindowContent = true,
                accessibilityTouchExploration = false,
                deviceLocked = true,
                batteryOptimizationIgnored = false,
                recoveries = recoverySummary(),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val error = payload.getValue("error") as Map<String, Any>
        @Suppress("UNCHECKED_CAST")
        val diagnostics = payload.getValue("diagnostics") as Map<String, Any>
        assertEquals("DEVICE_LOCKED", error.getValue("code"))
        assertEquals("capture", error.getValue("stage"))
        assertFalse(error.getValue("retryable") as Boolean)
        assertTrue(diagnostics.getValue("deviceLocked") as Boolean)
        assertFalse(diagnostics.getValue("batteryOptimizationIgnored") as Boolean)
        assertEquals("none", diagnostics.getValue("recoveries"))
        assertTrue(diagnostics.getValue("accessibilityCanRetrieveWindowContent") as Boolean)
        assertFalse(diagnostics.getValue("accessibilityTouchExploration") as Boolean)
    }

    /** 省电限制只做诊断提示：没有恢复动作时也要能读出真实状态。 */
    @Test
    fun `未豁免电池优化时失败信封保留可诊断字段`() {
        val payload = companionErrorPayload(
            error = CompanionProtocolFailures.treeRootUnavailable(),
            diagnostics = CompanionProtocolDiagnostics(
                requestId = 34L,
                elapsedMs = 1200L,
                timeoutMs = 10_000L,
                serviceConnected = true,
                httpListening = true,
                batteryOptimizationIgnored = false,
                recoveries = recoverySummary(rootAttempts = 5),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val diagnostics = payload.getValue("diagnostics") as Map<String, Any>
        assertFalse(diagnostics.getValue("batteryOptimizationIgnored") as Boolean)
        assertEquals("root_attempts=5", diagnostics.getValue("recoveries"))
    }
}
