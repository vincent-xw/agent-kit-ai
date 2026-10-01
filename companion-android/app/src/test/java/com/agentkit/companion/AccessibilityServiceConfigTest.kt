package com.agentkit.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AccessibilityServiceConfigTest {
    @Test
    fun `Touch Exploration 开启时必须把双击交给无障碍服务`() {
        // 这是服务元数据的回归守卫：没有该 flag，系统会自行消费双击，onGesture 永远收不到退出手势。
        val config = File("src/main/res/xml/accessibility_service_config.xml").readText()
        val service = File("src/main/java/com/agentkit/companion/CompanionAccessibilityService.kt").readText()

        assertTrue(config.contains("flagServiceHandlesDoubleTap"))
        // 动态 setServiceInfo 也必须维护该 flag，防止旧服务配置覆盖元数据配置。
        assertTrue(service.contains("FLAG_SERVICE_HANDLES_DOUBLE_TAP"))
        // Android 30+ 的系统回调走 AccessibilityGestureEvent，不能只依赖已废弃的 Int 重载。
        assertTrue(service.contains("override fun onGesture(gestureEvent: AccessibilityGestureEvent)"))
    }

    @Test
    fun `服务重连不能无条件清除正在使用的 Touch Exploration`() {
        val service = File("src/main/java/com/agentkit/companion/CompanionAccessibilityService.kt").readText()
        val connectedBody = service.substringAfter("override fun onServiceConnected()")
            .substringBefore("@Synchronized\n    override fun onDestroy()")

        assertFalse(connectedBody.contains("setTouchExplorationRequested(false)"))
        assertTrue(service.contains("touchExplorationRequested"))
    }
}
