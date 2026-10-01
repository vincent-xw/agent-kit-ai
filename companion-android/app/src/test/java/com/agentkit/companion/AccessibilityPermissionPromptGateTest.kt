package com.agentkit.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessibilityPermissionPromptGateTest {
    @Test
    fun `未授权状态连续刷新只允许显示一个引导弹窗`() {
        val gate = AccessibilityPermissionPromptGate()

        assertTrue(gate.tryShow())
        assertFalse(gate.tryShow())
    }

    @Test
    fun `弹窗关闭后下次未授权检测可以再次引导`() {
        val gate = AccessibilityPermissionPromptGate()
        gate.tryShow()

        gate.onDismissed()

        assertTrue(gate.tryShow())
    }
}
