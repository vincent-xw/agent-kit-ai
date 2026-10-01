package com.agentkit.companion

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import com.agentkit.companion.LingxiLogger as Log
import android.view.View
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * 引导用户开启无障碍权限，并启动 HTTP 服务器。
 * 服务器绑定 127.0.0.1:7777，仅 BFF 通过 adb forward 连接。
 * 服务器由 CompanionAccessibilityService.onServiceConnected 启动，
 * 此 Activity 仅在服务未连接时引导开启权限。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var serverText: TextView
    private lateinit var restartServerButton: Button
    private lateinit var logScrollView: ScrollView
    private lateinit var logText: TextView
    private lateinit var copyLogsButton: Button
    private var logSubscription: (() -> Unit)? = null
    private var enableDialog: AlertDialog? = null
    private val permissionPromptGate = AccessibilityPermissionPromptGate()
    private val statusHandler = Handler(Looper.getMainLooper())
    private val statusRefresh = object : Runnable {
        override fun run() {
            refreshStatus()
            statusHandler.postDelayed(this, STATUS_REFRESH_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.initialize(this)
        setContentView(R.layout.activity_main)
        statusText = findViewById(R.id.status_text)
        serverText = findViewById(R.id.server_text)
        restartServerButton = findViewById(R.id.restart_server_button)
        logScrollView = findViewById(R.id.log_scroll_view)
        logText = findViewById(R.id.log_text)
        copyLogsButton = findViewById(R.id.copy_logs_button)
        restartServerButton.setOnClickListener { restartHttpServer() }
        copyLogsButton.setOnClickListener { copyLogs() }
        renderLogs()
    }

    override fun onResume() {
        super.onResume()
        statusHandler.removeCallbacks(statusRefresh)
        statusHandler.post(statusRefresh)
    }

    override fun onStart() {
        super.onStart()
        logSubscription = Log.subscribe {
            runOnUiThread { renderLogs() }
        }
    }

    override fun onStop() {
        logSubscription?.invoke()
        logSubscription = null
        statusHandler.removeCallbacks(statusRefresh)
        super.onStop()
    }

    /** 将最近日志刷新到主界面，并把滚动位置保持在最新一条。 */
    private fun renderLogs() {
        val text = Log.formattedText()
        logText.text = if (text.isBlank()) "暂无日志" else text
        logScrollView.post { logScrollView.fullScroll(View.FOCUS_DOWN) }
    }

    /** 将与 ADB 读取内容一致的日志复制到系统剪贴板。 */
    private fun copyLogs() {
        val clipboard = getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("灵犀诊断日志", Log.formattedText()))
        Toast.makeText(this, "日志已复制，可直接粘贴给开发者或 AI", Toast.LENGTH_SHORT).show()
        Log.i(TAG, "用户复制诊断日志: count=${Log.snapshot().size}")
    }

    private fun refreshStatus() {
        val enabled = isAccessibilityEnabled()
        val serviceConnected = CompanionAccessibilityService.instance != null
        val health = CompanionRuntimeHealth.state.snapshot()
        statusText.text = buildString {
            append(if (enabled) "已授权" else "未授权")
            append(if (health.serviceConnected) " · 服务已连接" else " · 服务未连接")
            append(if (health.accessibility.canRetrieveWindowContent) " · 可读取窗口" else " · 不可读取窗口")
            append(if (health.accessibility.touchExploration) " · 增强读屏已开启" else " · 普通手势")
        }
        serverText.text = buildString {
            append("协议 v${health.protocolVersion} · App ${health.appVersion}")
            append(if (health.httpServer.listening) " · HTTP 127.0.0.1:7777 正常" else " · HTTP 未监听")
            append("\n最近事件：${formatTimestamp(health.accessibility.lastEventAt)}")
            append(" · 最近抓树：${formatTimestamp(health.treeCapture.lastSuccessAt)}")
            append(" · 节点 ${health.treeCapture.lastNodeCount}")
            if (health.treeCapture.busy) append(if (health.treeCapture.stuck) " · 抓树卡住" else " · 正在抓树")
            health.treeCapture.lastError?.let { append("\n最近错误：$it") }
        }
        restartServerButton.isEnabled = serviceConnected
        restartServerButton.visibility = if (serviceConnected) View.VISIBLE else View.GONE
        if (!enabled) {
            showEnableDialog()
        } else {
            // 设置页返回时服务可能已先于 Activity 状态刷新完成授权；此时必须立即收起旧引导。
            enableDialog?.dismiss()
        }
    }

    private fun formatTimestamp(timestamp: Long): String = if (timestamp > 0L) timestamp.toString() else "暂无"

    /** 手动重建 Companion HTTP 监听，不触碰无障碍授权和系统手势。 */
    private fun restartHttpServer() {
        if (CompanionAccessibilityService.instance == null) {
            serverText.text = "重启失败：无障碍服务未连接"
            return
        }
        try {
            HttpServerHolder.restart()
            refreshStatus()
            Toast.makeText(this, "Companion HTTP 服务已重启", Toast.LENGTH_SHORT).show()
        } catch (exception: Exception) {
            Log.e(TAG, "手动重启 HTTP 服务失败", exception)
            serverText.text = "服务器重启失败：${exception.message ?: "未知错误"}"
            Toast.makeText(this, "Companion HTTP 服务重启失败", Toast.LENGTH_LONG).show()
        }
    }

    /** 已启用判定：服务实例已连接（重装/后台常驻时最可靠）或系统已授权列表包含本服务。 */
    private fun isAccessibilityEnabled(): Boolean {
        if (CompanionAccessibilityService.instance != null) return true
        return enabledInSettings()
    }

    /** 查系统已授权的无障碍服务列表是否包含本应用服务。 */
    private fun enabledInSettings(): Boolean {
        val expected = ComponentName(this, CompanionAccessibilityService::class.java).flattenToString()
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabledServices)
        while (splitter.hasNext()) {
            if (splitter.next().equals(expected, ignoreCase = true)) return true
        }
        return false
    }

    private fun showEnableDialog() {
        if (isFinishing || isDestroyed || !permissionPromptGate.tryShow()) return
        val dialog = AlertDialog.Builder(this)
            .setTitle("启用无障碍服务")
            .setMessage("灵犀 需要无障碍服务权限才能读取屏幕内容。\n\n请在「已安装的应用」列表中找到并启用。")
            .setPositiveButton("去设置") { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton("退出") { _, _ -> finish() }
            .setCancelable(false)
            .create()
        dialog.setOnDismissListener {
            if (enableDialog === dialog) enableDialog = null
            permissionPromptGate.onDismissed()
        }
        enableDialog = dialog
        dialog.show()
    }

    companion object {
        private const val TAG = "LingxiMain"
        private const val STATUS_REFRESH_INTERVAL_MS = 1_000L
    }
}
