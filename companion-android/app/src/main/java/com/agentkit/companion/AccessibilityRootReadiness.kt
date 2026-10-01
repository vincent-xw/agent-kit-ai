package com.agentkit.companion

/**
 * 用于判断无障碍 root 是否已经具备可遍历资格。
 *
 * package/class/visible 字段保留为诊断信息，不能作为普通 App 的硬门槛；部分应用
 * 能提供可遍历子树，但 root 的这些元信息暂时为空或标记不完整。这里保持旧的内容
 * 判定兼容条件，同时让空壳 root（没有子树也没有自身语义）继续被识别出来。
 */
data class AccessibilityRootSnapshot(
    val packageName: String?,
    val className: String?,
    val childCount: Int,
    val visibleToUser: Boolean,
    val text: String? = null,
    val contentDescription: String? = null,
    val clickable: Boolean = false,
    val scrollable: Boolean = false,
    val editable: Boolean = false,
)

/** 节点是否已经具备用户可读或可操作的语义；focusable/extras 单独存在时仍视为壳节点。 */
data class AccessibilityNodeSemanticSnapshot(
    val visibleToUser: Boolean,
    val text: String? = null,
    val contentDescription: String? = null,
    val hintText: String? = null,
    val tooltipText: String? = null,
    val stateDescription: String? = null,
    val clickable: Boolean = false,
    val longClickable: Boolean = false,
    val scrollable: Boolean = false,
    val editable: Boolean = false,
    val checkable: Boolean = false,
    val actionCount: Int = 0,
    val focusable: Boolean = false,
    val hasExtras: Boolean = false,
)

fun isAccessibilityRootReady(snapshot: AccessibilityRootSnapshot): Boolean {
    return snapshot.childCount > 0 ||
        !snapshot.text.isNullOrBlank() ||
        !snapshot.contentDescription.isNullOrBlank() ||
        snapshot.clickable ||
        snapshot.scrollable ||
        snapshot.editable
}

/**
 * 判断节点是否足以证明语义树已经建立。
 *
 * focusable 和 extras 经常出现在应用的空容器或内部壳节点上，不能单独作为 Enhanced
 * 成功条件；可见文本、描述、提示、状态、真实交互能力或动作才是有效信号。
 */
fun hasVisibleSemanticContent(snapshot: AccessibilityNodeSemanticSnapshot): Boolean {
    if (!snapshot.visibleToUser) return false
    val hasReadableLabel = !snapshot.text.isNullOrBlank() ||
        !snapshot.contentDescription.isNullOrBlank() ||
        !snapshot.hintText.isNullOrBlank() ||
        !snapshot.tooltipText.isNullOrBlank() ||
        !snapshot.stateDescription.isNullOrBlank()
    val hasInteraction = snapshot.clickable ||
        snapshot.longClickable ||
        snapshot.scrollable ||
        snapshot.editable ||
        snapshot.checkable ||
        snapshot.actionCount > 0
    return hasReadableLabel || hasInteraction
}
