package com.agentkit.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionHealthStateTest {
    @Test
    fun `快照返回协议版本和最新运行指标`() {
        val health = CompanionHealthState(processStartedAt = 100L, appVersion = "test-version")
        health.setServiceConnected(true)
        health.setHttpListening(listening = true, heartbeatAt = 200L)
        health.setAccessibilityState(
            authorized = true,
            canRetrieveWindowContent = true,
            touchExploration = false,
        )
        health.recordAccessibilityEvent(300L)
        health.recordTreeSuccess(at = 400L, durationMs = 25L, nodeCount = 12)

        val snapshot = health.snapshot()

        assertEquals(3, snapshot.protocolVersion)
        assertEquals("test-version", snapshot.appVersion)
        assertEquals(100L, snapshot.processStartedAt)
        assertTrue(snapshot.serviceConnected)
        assertTrue(snapshot.httpServer.listening)
        assertEquals(200L, snapshot.httpServer.lastHeartbeatAt)
        assertTrue(snapshot.accessibility.authorized)
        assertTrue(snapshot.accessibility.canRetrieveWindowContent)
        assertFalse(snapshot.accessibility.touchExploration)
        assertEquals(300L, snapshot.accessibility.lastEventAt)
        assertEquals(400L, snapshot.treeCapture.lastSuccessAt)
        assertEquals(25L, snapshot.treeCapture.lastDurationMs)
        assertEquals(12, snapshot.treeCapture.lastNodeCount)
    }

    @Test
    fun `抓树失败保留最近一次成功指标`() {
        val health = CompanionHealthState(processStartedAt = 100L, appVersion = "test-version")
        health.recordTreeSuccess(at = 400L, durationMs = 25L, nodeCount = 12)
        health.recordTreeFailure(at = 500L, durationMs = 40L, error = "tree capture busy")

        val snapshot = health.snapshot()

        assertEquals(400L, snapshot.treeCapture.lastSuccessAt)
        assertEquals(40L, snapshot.treeCapture.lastDurationMs)
        assertEquals(12, snapshot.treeCapture.lastNodeCount)
        assertEquals("tree capture busy", snapshot.treeCapture.lastError)
    }

    @Test
    fun `抓树执行状态可以独立更新`() {
        val health = CompanionHealthState(processStartedAt = 100L, appVersion = "test-version")

        health.setTreeExecution(busy = true, stuck = true)

        assertTrue(health.snapshot().treeCapture.busy)
        assertTrue(health.snapshot().treeCapture.stuck)
    }

    @Test
    fun `协议载荷包含全部必填字段`() {
        val health = CompanionHealthState(processStartedAt = 100L, appVersion = "test-version")
        health.setServiceConnected(true)
        health.setHttpListening(listening = true, heartbeatAt = 200L)
        health.setAccessibilityState(
            authorized = true,
            canRetrieveWindowContent = true,
            touchExploration = true,
        )
        health.recordAccessibilityEvent(300L)
        health.setTreeExecution(busy = true, stuck = false)
        health.recordTreeFailure(at = 400L, durationMs = 25L, error = "busy")

        val payload = CompanionHealthPayload.from(health.snapshot())

        assertEquals(
            setOf(
                "protocolVersion",
                "appVersion",
                "processStartedAt",
                "serviceConnected",
                "deviceLocked",
                "batteryOptimizationIgnored",
                "httpServer",
                "accessibility",
                "treeCapture",
            ),
            payload.keys,
        )
        assertEquals(
            setOf("listening", "lastHeartbeatAt"),
            (payload.getValue("httpServer") as Map<*, *>).keys,
        )
        assertEquals(
            setOf("authorized", "canRetrieveWindowContent", "touchExploration", "lastEventAt"),
            (payload.getValue("accessibility") as Map<*, *>).keys,
        )
        assertEquals(
            setOf("busy", "stuck", "lastSuccessAt", "lastDurationMs", "lastNodeCount", "lastError"),
            (payload.getValue("treeCapture") as Map<*, *>).keys,
        )
    }

    /** 锁屏与省电豁免是设备环境事实，必须随 health 一起暴露给调用方。 */
    @Test
    fun `设备环境状态随 health 暴露且未读取时保持默认`() {
        val health = CompanionHealthState(processStartedAt = 100L, appVersion = "test-version")
        assertFalse(health.snapshot().deviceLocked)
        assertFalse(health.snapshot().batteryOptimizationIgnored)

        health.setDeviceEnvironment(locked = true, batteryOptimizationIgnored = false)

        val snapshot = health.snapshot()
        assertTrue(snapshot.deviceLocked)
        assertFalse(snapshot.batteryOptimizationIgnored)
        val payload = CompanionHealthPayload.from(snapshot)
        assertTrue(payload.getValue("deviceLocked") as Boolean)
        assertFalse(payload.getValue("batteryOptimizationIgnored") as Boolean)
    }
}
