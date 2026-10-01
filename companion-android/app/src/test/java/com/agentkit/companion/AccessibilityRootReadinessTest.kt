package com.agentkit.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessibilityRootReadinessTest {
    @Test
    fun `不可见空壳 root 不应被视为可读语义`() {
        assertFalse(
            isAccessibilityRootReady(
                AccessibilityRootSnapshot(
                    packageName = "com.tencent.mm",
                    className = "",
                    childCount = 0,
                    visibleToUser = false,
                ),
            ),
        )
    }

    @Test
    fun `可见且有 class 和子节点的 root 才可进入语义遍历`() {
        assertTrue(
            isAccessibilityRootReady(
                AccessibilityRootSnapshot(
                    packageName = "com.tencent.mm",
                    className = "android.widget.FrameLayout",
                    childCount = 3,
                    visibleToUser = true,
                ),
            ),
        )
    }

    @Test
    fun `普通 App 有子树时不应因 root 诊断字段不完整而被拒绝`() {
        assertTrue(
            isAccessibilityRootReady(
                AccessibilityRootSnapshot(
                    packageName = null,
                    className = null,
                    childCount = 2,
                    visibleToUser = false,
                ),
            ),
        )
    }

    @Test
    fun `不可见节点不能满足增强模式的有效语义门槛`() {
        assertFalse(
            hasVisibleSemanticContent(
                AccessibilityNodeSemanticSnapshot(
                    visibleToUser = false,
                    text = "微信",
                    clickable = true,
                ),
            ),
        )
    }

    @Test
    fun `只有焦点或 extras 的壳节点不能满足增强模式的有效语义门槛`() {
        assertFalse(
            hasVisibleSemanticContent(
                AccessibilityNodeSemanticSnapshot(
                    visibleToUser = true,
                    focusable = true,
                    hasExtras = true,
                ),
            ),
        )
    }

    @Test
    fun `可见文本或真实交互动作可以满足增强模式的有效语义门槛`() {
        assertTrue(
            hasVisibleSemanticContent(
                AccessibilityNodeSemanticSnapshot(
                    visibleToUser = true,
                    text = "聊天",
                ),
            ),
        )
        assertTrue(
            hasVisibleSemanticContent(
                AccessibilityNodeSemanticSnapshot(
                    visibleToUser = true,
                    clickable = true,
                ),
            ),
        )
    }
}
