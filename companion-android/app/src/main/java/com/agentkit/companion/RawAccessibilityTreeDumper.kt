package com.agentkit.companion

import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Debug 专用的完整 AccessibilityNodeInfo 导出器。
 *
 * 这里不使用生产快照的 interesting 过滤，目的是观察 Android 实际交给服务的原始树。
 * 节点上限只是防止异常 AccessibilityNodeProvider 拖垮服务；达到上限时会明确返回 truncated。
 */
object RawAccessibilityTreeDumper {

    private const val MAX_NODES = 10_000

    data class DumpResult(
        val nodes: JSONArray,
        val truncated: Boolean,
    )

    fun dump(root: AccessibilityNodeInfo): DumpResult {
        val nodes = JSONArray()
        val state = TraverseState()
        traverse(root, nodes, state, depth = 0, index = 0, path = "0")
        return DumpResult(nodes = nodes, truncated = state.truncated)
    }

    private class TraverseState {
        var count = 0
        var truncated = false
    }

    private fun traverse(
        node: AccessibilityNodeInfo,
        result: JSONArray,
        state: TraverseState,
        depth: Int,
        index: Int,
        path: String,
    ) {
        if (state.count >= MAX_NODES) {
            state.truncated = true
            return
        }
        state.count += 1

        val obj = JSONObject().apply {
            put("depth", depth)
            put("index", index)
            put("path", path)
            put("windowId", node.windowId)
            put("packageName", node.packageName?.toString() ?: "")
            put("className", node.className?.toString() ?: "")
            put("viewId", node.viewIdResourceName ?: "")
            put("text", node.text?.toString() ?: "")
            put("contentDescription", node.contentDescription?.toString() ?: "")
            put("hintText", node.hintText?.toString() ?: "")
            put("tooltipText", node.tooltipText?.toString() ?: "")
            put(
                "stateDescription",
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    node.stateDescription?.toString() ?: ""
                } else {
                    ""
                },
            )
            put("clickable", node.isClickable)
            put("longClickable", node.isLongClickable)
            put("focusable", node.isFocusable)
            put("focused", node.isFocused)
            put("accessibilityFocused", node.isAccessibilityFocused)
            put("screenReaderFocusable", node.isScreenReaderFocusable)
            put("editable", node.isEditable)
            put("checkable", node.isCheckable)
            put("checked", node.isChecked)
            put("selected", node.isSelected)
            put("enabled", node.isEnabled)
            put("visibleToUser", node.isVisibleToUser)
            put("importantForAccessibility", node.isImportantForAccessibility)
            put("childCount", node.childCount)
            put("bounds", boundsToJson(node))
            put("actions", actionsToJson(node))
            put("extras", extrasToJson(node))
        }
        result.put(obj)

        for (childIndex in 0 until node.childCount) {
            if (state.count >= MAX_NODES) {
                state.truncated = true
                return
            }
            val child = node.getChild(childIndex) ?: continue
            try {
                traverse(
                    node = child,
                    result = result,
                    state = state,
                    depth = depth + 1,
                    index = childIndex,
                    path = "$path.$childIndex",
                )
            } finally {
                child.recycle()
            }
        }
    }

    private fun boundsToJson(node: AccessibilityNodeInfo): JSONObject {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return JSONObject().apply {
            put("left", bounds.left)
            put("top", bounds.top)
            put("right", bounds.right)
            put("bottom", bounds.bottom)
        }
    }

    private fun actionsToJson(node: AccessibilityNodeInfo): JSONArray {
        return JSONArray().apply {
            node.actionList.forEach { action ->
                put(
                    JSONObject().apply {
                        put("id", action.id)
                        put("label", action.label?.toString() ?: "")
                    },
                )
            }
        }
    }

    private fun extrasToJson(node: AccessibilityNodeInfo): JSONArray {
        return JSONArray().apply {
            node.extras.keySet().sorted().forEach { key -> put(key) }
        }
    }
}
