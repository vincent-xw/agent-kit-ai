package com.agentkit.companion

import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * 共享的「有意义节点」判定：NodeTreeDumper（快照编号）与 CompanionHttpServer（点击/解析 ref）
 * 必须用同一个函数，否则 ref 序号在两端算出不同的结果 → 点击命中错位。
 * 必须包含 isFocusable：桌面/列表里存在仅 focusable 的容器，若只在快照端记数、点击端跳过，
 * 会让所有后续 ref 整体平移。
 */
internal fun accessibilityNodeInteresting(node: AccessibilityNodeInfo): Boolean {
    val hasText = !node.text.isNullOrBlank()
    val hasContentDesc = !node.contentDescription.isNullOrBlank()
    val hasHint = !node.hintText.isNullOrBlank()
    val hasTooltip = !node.tooltipText.isNullOrBlank()
    val hasStateDescription = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !node.stateDescription.isNullOrBlank()
    val hasActions = node.actionList.isNotEmpty()
    val hasExtras = node.extras.keySet().isNotEmpty()
    val isInteractive = node.isClickable || node.isLongClickable || node.isScrollable ||
        node.isEditable || node.isCheckable || node.isFocusable
    // 不以 visibleToUser 作为删除条件：微信的语义节点可能先标记为不可见，
    // 但仍然通过子节点、描述、action 或 extras 承载 TalkBack 可用的信息。
    return hasText || hasContentDesc || hasHint || hasTooltip || hasStateDescription ||
        isInteractive || hasActions || hasExtras
}

/**
 * 把 AccessibilityNodeInfo 树转成扁平 JSON 节点列表，与 BFF 的 DeviceNode 形状对齐。
 */
object NodeTreeDumper {

    /** 一次遍历的真实统计；用于区分 root 有内容但子节点不可读与语义过滤为空。 */
    data class DumpResult(
        val nodes: JSONArray,
        val visitedNodeCount: Int,
        val childReadFailures: Int,
        val interestingNodeCount: Int,
        val visibleSemanticNodeCount: Int,
        val truncated: Boolean,
    )

    fun dump(root: AccessibilityNodeInfo): JSONArray {
        return dumpWithDiagnostics(root).nodes
    }

    fun dumpWithDiagnostics(root: AccessibilityNodeInfo): DumpResult {
        val nodes = JSONArray()
        val state = DumpState()
        traverse(root, nodes, state)
        return DumpResult(
            nodes = nodes,
            visitedNodeCount = state.visitedNodeCount,
            childReadFailures = state.childReadFailures,
            interestingNodeCount = state.interestingNodeCount,
            visibleSemanticNodeCount = state.visibleSemanticNodeCount,
            truncated = state.truncated,
        )
    }

    private class DumpState {
        var nextRef = 0
        var visitedNodeCount = 0
        var childReadFailures = 0
        var interestingNodeCount = 0
        var visibleSemanticNodeCount = 0
        var truncated = false
    }

    private fun traverse(
        node: AccessibilityNodeInfo,
        result: JSONArray,
        state: DumpState,
    ) {
        state.visitedNodeCount += 1
        if (hasVisibleSemanticContent(node.toSemanticSnapshot())) {
            state.visibleSemanticNodeCount += 1
        }
        // 先记录当前节点（若 interesting），再无条件遍历子节点。
        // 不能因根节点不 interesting 就跳过整棵子树——根通常是容器无文本。
        if (accessibilityNodeInteresting(node)) {
            state.interestingNodeCount += 1
            val obj = JSONObject()
            val ref = state.nextRef++
            obj.put("ref", ref)
            obj.put("nodeId", "node:$ref")

            node.text?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("text", it) }
            node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("contentDescription", it) }
            node.hintText?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("hintText", it) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                node.stateDescription?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("stateDescription", it) }
            }
            node.tooltipText?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("tooltipText", it) }
            node.packageName?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("packageName", it) }
            node.className?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("className", it) }
            node.viewIdResourceName?.takeIf { it.isNotBlank() }?.let { obj.put("resourceId", it) }

            val bounds = android.graphics.Rect()
            node.getBoundsInScreen(bounds)
            val boundsObj = JSONObject().apply {
                put("left", bounds.left)
                put("top", bounds.top)
                put("right", bounds.right)
                put("bottom", bounds.bottom)
            }
            obj.put("bounds", boundsObj)
            obj.put("clickable", node.isClickable)
            obj.put("longClickable", node.isLongClickable)
            obj.put("focusable", node.isFocusable)
            obj.put("scrollable", node.isScrollable)
            obj.put("editable", node.isEditable)
            obj.put("checkable", node.isCheckable)
            obj.put("enabled", node.isEnabled)
            obj.put("focused", node.isFocused)
            obj.put("accessibilityFocused", node.isAccessibilityFocused)
            obj.put("checked", node.isChecked)
            obj.put("selected", node.isSelected)
            obj.put("visibleToUser", node.isVisibleToUser)
            obj.put("childCount", node.childCount)
            obj.put(
                "actions",
                JSONArray().apply {
                    node.actionList.forEach { action ->
                        put(
                            JSONObject().apply {
                                put("id", action.id)
                                put("label", action.label?.toString() ?: "")
                            },
                        )
                    }
                },
            )
            obj.put("extras", JSONArray().apply { node.extras.keySet().sorted().forEach { put(it) } })

            result.put(obj)
        }

        // 限制递归深度，避免过深节点
        if (result.length() < 500) {
            val childCount = try {
                node.childCount
            } catch (_: RuntimeException) {
                state.childReadFailures += 1
                return
            }
            for (i in 0 until childCount) {
                if (result.length() >= 500) {
                    state.truncated = true
                    return
                }
                val child = try {
                    node.getChild(i)
                } catch (_: RuntimeException) {
                    null
                }
                if (child == null) {
                    // getChild 返回 null 通常表示 provider 暂时无法读取该位置；这是
                    // 诊断重点，不能像旧实现一样静默吞掉。
                    state.childReadFailures += 1
                    continue
                }
                try {
                    traverse(child, result, state)
                } finally {
                    child.recycle()
                }
            }
        } else {
            state.truncated = true
        }
    }

    /** 只提取 Enhanced 就绪判断需要的字段，避免把 root 诊断与普通节点输出耦合。 */
    private fun AccessibilityNodeInfo.toSemanticSnapshot(): AccessibilityNodeSemanticSnapshot {
        return AccessibilityNodeSemanticSnapshot(
            visibleToUser = isVisibleToUser,
            text = text?.toString(),
            contentDescription = contentDescription?.toString(),
            hintText = hintText?.toString(),
            tooltipText = tooltipText?.toString(),
            stateDescription = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                stateDescription?.toString()
            } else {
                null
            },
            clickable = isClickable,
            longClickable = isLongClickable,
            scrollable = isScrollable,
            editable = isEditable,
            checkable = isCheckable,
            actionCount = actionList.size,
            focusable = isFocusable,
            hasExtras = extras.keySet().isNotEmpty(),
        )
    }
}
