package com.agentkit.companion

/**
 * 约束无障碍授权引导弹窗的生命周期。
 *
 * 主界面每秒刷新一次状态；未授权时若没有这个门闩，会在一个 Activity 上叠加多个弹窗。
 */
class AccessibilityPermissionPromptGate {
    private var showing = false

    /** 仅在当前没有正在显示的引导弹窗时允许创建新的弹窗。 */
    fun tryShow(): Boolean {
        if (showing) return false
        showing = true
        return true
    }

    /** Dialog 关闭后释放门闩，使用户下次主动回到主界面时可以再次获得引导。 */
    fun onDismissed() {
        showing = false
    }
}
