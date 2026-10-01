package com.agentkit.companion

import com.agentkit.companion.LingxiLogger as Log

import android.accessibilityservice.AccessibilityGestureEvent
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.Display
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.TextView
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * 持有当前窗口的无障碍节点树引用，并在后台根据页面事件预热短时快照。
 * 事件回调不读取 root/source；真正的节点读取在去抖后的后台任务中进行，
 * 避免微信/抖音的事件风暴占用无障碍回调线程。
 */
class CompanionAccessibilityService : AccessibilityService() {

    /** Debug 接口返回的窗口元信息与 fresh root；root 的生命周期由调用方负责回收。 */
    data class DebugWindowRoot(
        val id: Int,
        val type: Int,
        val layer: Int,
        val title: String,
        val active: Boolean,
        val focused: Boolean,
        val root: AccessibilityNodeInfo?,
    )

    /** Debug 接口使用的轻量事件快照，避免跨回调保存 AccessibilityEvent 原对象。 */
    data class DebugEvent(
        val type: Int,
        val time: Long,
        val packageName: String,
        val className: String,
        val windowId: Int,
        val contentChangeTypes: Int,
        val action: Int,
        val text: String,
    )

    companion object {
        private const val TAG = "CompanionAccessibilityService"
        /** 服务实例，供 HttpServer 访问节点树。 */
        var instance: CompanionAccessibilityService? = null
            private set

        /** 事件环形缓冲，最近 200 条。 */
        private val eventBuffer = ConcurrentLinkedQueue<AccessibilityEvent>()
        /** Debug 事件摘要缓冲，最近 200 条。 */
        private val debugEventBuffer = ConcurrentLinkedQueue<DebugEvent>()
        private const val MAX_EVENTS = 200
        private const val TREE_PREPARATION_DEBOUNCE_MS = 120L
        private const val TREE_PREPARATION_MIN_INTERVAL_MS = 350L
        private const val TOUCH_EXPLORATION_PREFS = "touch_exploration_state"
        private const val TOUCH_EXPLORATION_REQUESTED_KEY = "requested"
    }

    /** 当前活跃窗口的根节点。 */
    private var currentRoot: AccessibilityNodeInfo? = null
    /** 缓存 root 只在成功快照后更新，使用独立锁避免阻塞事件回调和抓树重试。 */
    private val rootCacheLock = Any()
    /** 记录事件序号，Enhanced 抓树可据此确认抓取期间目标应用是否产生新事件。 */
    private val accessibilityEventTracker = AccessibilityEventTracker()
    /** 只因窗口/内容相关事件推进；普通播报等无关事件不让短时树缓存失效。 */
    private val preparedTreeEventSequence = AtomicLong(0L)
    /** 只缓存一份短时、已序列化的树，减少请求到来时再次遍历 AccessibilityNodeInfo。 */
    private val preparedTreeCache = PreparedTreeObservationCache()
    /** 事件预热与 HTTP 请求之间的短等待条件；不持有 AccessibilityNodeInfo。 */
    @Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")
    private val treePreparationLock = java.lang.Object()
    /** 单线程合并事件，抓树本身仍统一经过 CompanionTreeCapture.coordinator。 */
    private val treePreparationExecutor = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "Lingxi Tree Preparation").apply { isDaemon = true }
    }
    private var pendingTreePreparation: TreePreparationTrigger? = null
    private var pendingTreePreparationFuture: ScheduledFuture<*>? = null
    private var activeTreePreparation: TreePreparationTrigger? = null
    private var lastTreePreparationEventElapsedMs = 0L
    private var lastTreePreparationStartedElapsedMs = 0L
    @Volatile
    private var serviceDestroying = false

    private data class TreePreparationTrigger(
        val event: AccessibilityEvent,
        val marker: AccessibilityEventMarker,
        val treeSequence: Long,
    )

    /** Touch Exploration 开启时覆盖在状态栏位置的可见安全提示。 */
    private var touchExplorationBanner: TextView? = null
    /** 所有 WindowManager 操作都切回主线程，避免 HTTP 线程直接操作 View。 */
    private val mainHandler = Handler(Looper.getMainLooper())
    /** 事件风暴时过滤系统噪声并聚合重复摘要，避免诊断日志反过来影响无障碍回调。 */
    private val eventLogPolicy = AccessibilityEventLogPolicy()

    override fun onCreate() {
        super.onCreate()
        Log.initialize(this)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceDestroying = false
        instance = this
        CompanionRuntimeHealth.state.setServiceConnected(true)
        val requestFlag = AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
        val preferences = getSharedPreferences(TOUCH_EXPLORATION_PREFS, MODE_PRIVATE)
        // 服务可能因系统回收、无障碍配置刷新而重连。只要最近一次请求仍是开启，
        // 就恢复同一状态；不能在这里无条件关闭，否则微信语义树会在下一次抓取前失效。
        val shouldRestoreTouch = preferences.getBoolean(TOUCH_EXPLORATION_REQUESTED_KEY, false)
            || serviceInfo.flags and requestFlag != 0
        if (shouldRestoreTouch) {
            preferences.edit().putBoolean(TOUCH_EXPLORATION_REQUESTED_KEY, true).apply()
            applyTouchExplorationRequest(true)
            Log.i(TAG, "无障碍服务已连接，恢复之前请求的 Touch Exploration")
        } else {
            refreshAccessibilityHealth()
            Log.i(TAG, "无障碍服务已连接，当前保持普通系统手势")
        }
        // 启动前台通知，防止退到后台时被系统（尤其 MIUI）冻结并销毁 socket
        startAsForeground()
        // 服务连接后立即启动 HTTP 服务器，不依赖 MainActivity 的 onResume。
        // onResume 可能在服务异步绑定前执行，导致 instance 仍为 null 而跳过启动。
        try {
            HttpServerHolder.start()
        } catch (exception: Exception) {
            // 端口可能因旧进程尚未退出而瞬时冲突；保持无障碍服务存活，交给 Holder 后台重试。
            Log.w(TAG, "HTTP 服务首次启动失败，后台将自动重试", exception)
        }
    }

    @Synchronized
    override fun onDestroy() {
        serviceDestroying = true
        // 只清理旧 Service 实例持有的 overlay；持久化请求不在这里清除，
        // 这样系统短暂重连时不会把仍在使用的 Touch Exploration 意外降回普通模式。
        Log.i(TAG, "无障碍服务正在销毁，保留 Touch Exploration 请求状态")
        CompanionRuntimeHealth.state.setServiceConnected(false)
        // 服务销毁时同步停止监听线程，否则旧 socket 可能继续占用 7777，新的服务实例
        // 即使已经重新授权也只能看到一个失效的 server 引用。
        HttpServerHolder.stop()
        clearPreparedTreeObservations()
        treePreparationExecutor.shutdownNow()
        updateTouchExplorationBanner(false)
        synchronized(rootCacheLock) {
            currentRoot?.recycle()
            currentRoot = null
        }
        while (eventBuffer.isNotEmpty()) {
            eventBuffer.poll()?.recycle()
        }
        debugEventBuffer.clear()
        super.onDestroy()
        instance = null
    }

    /** 前台通知，保持进程活跃不被冻结。 */
    private fun startAsForeground() {
        try {
            val channelId = "companion_server"
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(channelId, "灵犀服务", NotificationManager.IMPORTANCE_MIN),
            )
            val notification: Notification = Notification.Builder(this, channelId)
                .setContentTitle("灵犀")
                .setContentText("无障碍服务运行中，等待 adb 连接")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .build()
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } catch (_: Exception) {
            // 前台通知失败不阻塞服务器启动
        }
    }

    /** 返回系统状态栏高度，提示条只覆盖状态栏区域，不遮挡应用内容。 */
    private fun getStatusBarHeight(): Int {
        val resourceId = resources.getIdentifier("status_bar_height", "dimen", "android")
        if (resourceId > 0) return resources.getDimensionPixelSize(resourceId)
        return (24 * resources.displayMetrics.density).toInt()
    }

    /** 在主线程显示或移除 Touch Exploration 状态栏提示。 */
    private fun updateTouchExplorationBanner(visible: Boolean) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            if (visible) showTouchExplorationBanner() else hideTouchExplorationBanner()
        } else {
            mainHandler.post {
                if (visible) showTouchExplorationBanner() else hideTouchExplorationBanner()
            }
        }
    }

    /** 显示红色状态栏提示；退出手势由无障碍服务全屏监听。 */
    private fun showTouchExplorationBanner() {
        if (touchExplorationBanner != null) return

        val windowManager = getSystemService(WindowManager::class.java)
        val banner = TextView(this).apply {
            text = "灵犀读屏模式已开启 · 双击屏幕任意位置退出"
            textSize = 11f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(190, 24, 24))
            gravity = Gravity.CENTER
            setPadding(12, 0, 12, 0)
            // 提示条只承担视觉告知，不把自身注册为业务无障碍节点，避免污染 Companion 树。
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            getStatusBarHeight(),
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // 明确以整块显示器左上角为原点，避免被应用的状态栏 inset 推到微信内容区。
            x = 0
            y = 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // 禁止 WindowManager 默认把系统栏 inset 应用到 Overlay，确保 y=0 就是物理屏幕顶部。
                setFitInsetsTypes(0)
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
            title = "灵犀 Touch Exploration 提示"
        }

        try {
            windowManager.addView(banner, layoutParams)
            touchExplorationBanner = banner
            Log.i(TAG, "Touch Exploration 状态栏提示已显示: height=${layoutParams.height}px, y=${layoutParams.y}")
        } catch (exception: Exception) {
            // 提示条失败不阻断无障碍读取；HTTP 状态仍会准确返回 Touch Exploration 已开启。
            Log.w(TAG, "无法显示 Touch Exploration 状态栏提示", exception)
        }
    }

    /** 移除状态栏提示，恢复用户可见的普通界面。 */
    private fun hideTouchExplorationBanner() {
        val banner = touchExplorationBanner ?: return
        touchExplorationBanner = null
        try {
            getSystemService(WindowManager::class.java).removeViewImmediate(banner)
            Log.i(TAG, "Touch Exploration 状态栏提示已移除")
        } catch (exception: Exception) {
            Log.w(TAG, "移除 Touch Exploration 状态栏提示失败", exception)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // Companion 自己刷新日志窗口时也会产生无障碍事件；如果继续记录这些事件，
        // 就会形成“日志写入 -> TextView 刷新 -> 无障碍事件 -> 日志写入”的死循环。
        // 只忽略自身包名的事件，目标应用（包括微信）的事件仍按原流程监听和缓存。
        if (event.packageName?.toString() == packageName) return

        CompanionRuntimeHealth.state.recordAccessibilityEvent(event.eventTime)
        refreshAccessibilityHealth()
        val eventPackageName = event.packageName?.toString() ?: ""
        val eventMarker = accessibilityEventTracker.record(
            packageName = eventPackageName,
            windowId = event.windowId,
            eventTime = event.eventTime,
        )

        scheduleTreePreparation(event, eventMarker)

        // 不在事件回调线程读取 rootInActiveWindow；去抖后的后台任务才会预热整棵树。
        // currentRoot 仍只作为旧节点操作路径的兜底缓存，不在事件回调中更新。

        // 记录事件摘要但不记录 event.text，避免聊天正文进入诊断日志；事件完整摘要仍可
        // 通过 /debug/accessibility/capture 查看，日志主要用于确认服务是否持续收到事件。
        val eventKey = "${event.eventType}|${event.packageName ?: ""}|${event.className ?: ""}|" +
            "${event.windowId}|${event.contentChangeTypes}|${event.action}"
        val now = System.currentTimeMillis()
        if (eventLogPolicy.shouldLog(eventPackageName, eventKey, now)) {
            Log.d(
                TAG,
                "Accessibility event: $eventKey, sequence=${eventMarker.sequence}, " +
                    "eventTime=${eventMarker.eventTime}",
            )
        }

        // 存入独立副本，不能跨回调保存系统传入的 event 原对象。
        eventBuffer.add(AccessibilityEvent.obtain(event))
        while (eventBuffer.size > MAX_EVENTS) {
            eventBuffer.poll()?.recycle()
        }

        debugEventBuffer.add(
            DebugEvent(
                type = event.eventType,
                time = event.eventTime,
                packageName = event.packageName?.toString() ?: "",
                className = event.className?.toString() ?: "",
                windowId = event.windowId,
                contentChangeTypes = event.contentChangeTypes,
                action = event.action,
                text = event.text.joinToString(""),
            ),
        )
        while (debugEventBuffer.size > MAX_EVENTS) {
            debugEventBuffer.poll()
        }
    }

    override fun onInterrupt() {}

    /**
     * Touch Exploration 开启时，全屏双击是用户恢复普通手机操作的紧急出口。
     * 这里使用系统无障碍手势回调，不需要把红色提示条扩展成全屏触摸层，
     * 因此不会拦截 Companion 对微信节点的点击、输入和滚动。
     * GESTURE_DOUBLE_TAP 从 Android 11（API 30）开始提供；旧系统没有该手势常量。
     */
    @Suppress("DEPRECATION")
    override fun onGesture(gestureId: Int): Boolean {
        if (handleEmergencyExitGesture(gestureId, Display.DEFAULT_DISPLAY)) return true
        return super.onGesture(gestureId)
    }

    /** Android 30+ 的手势回调必须显式返回处理结果，避免基类旧重载固定返回 false。 */
    override fun onGesture(gestureEvent: AccessibilityGestureEvent): Boolean {
        if (handleEmergencyExitGesture(gestureEvent.gestureId, gestureEvent.displayId)) return true
        return super.onGesture(gestureEvent)
    }

    /** 只在服务实际请求 Touch Exploration 且发生全屏双击时关闭增强读屏。 */
    private fun handleEmergencyExitGesture(gestureId: Int, displayId: Int): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
            displayId != Display.DEFAULT_DISPLAY ||
            gestureId != AccessibilityService.GESTURE_DOUBLE_TAP ||
            serviceInfo.flags and AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE == 0
        ) return false

        Log.i(TAG, "检测到全屏双击，关闭 Touch Exploration")
        setTouchExplorationRequested(false)
        return true
    }

    /** 获取当前根节点（调用方负责回收）。 */
    fun getRootCopy(
        preferredPackage: String? = null,
        mode: CompanionCaptureMode = CompanionCaptureMode.NORMAL,
        captureLevel: CompanionCaptureLevel = CompanionCaptureLevel.FAST,
        allowCachedFallback: Boolean = true,
        attemptLimit: Int = captureLevel.rootCaptureAttempts,
    ): AccessibilityNodeInfo? {
        val captureAttempts = attemptLimit.coerceIn(1, captureLevel.rootCaptureAttempts)
        val startedAt = System.currentTimeMillis()
        val startedElapsedMs = SystemClock.elapsedRealtime()
        val requiresVisibleSemanticNodes = mode.requiresVisibleSemanticNodes ||
            captureLevel.requiresVisibleSemanticNodes
        Log.i(
            TAG,
            "getRootCopy started: mode=${mode.wireValue}, level=${captureLevel.wireValue}, attempts=$captureAttempts, " +
                "preferredPackage=${preferredPackage ?: "(none)"}, allowCachedFallback=$allowCachedFallback",
        )
        var emptyRoot: AccessibilityNodeInfo? = null
        val eventBaseline = if (requiresVisibleSemanticNodes) {
            accessibilityEventTracker.snapshot()
        } else {
            null
        }
        var observedEventSequence = eventBaseline?.sequence ?: 0L
        eventBaseline?.let { marker ->
            Log.i(
                TAG,
                "getRootCopy event baseline: sequence=${marker.sequence}, " +
                    "lastPackage=${marker.packageName.ifBlank { "(none)" }}, " +
                    "lastWindowId=${marker.windowId}, lastEventTime=${marker.eventTime}",
            )
        }

        for (attempt in 1..captureAttempts) {
            val elapsedMs = SystemClock.elapsedRealtime() - startedElapsedMs
            if (!captureLevel.allowsAttempt(attempt, elapsedMs)) break
            // getWindows() 才能同时提供窗口类型、active/focused 和窗口层级。
            // 不能先信任 rootInActiveWindow 的 packageName 再用它给窗口评分：部分 MIUI
            // 场景下 rootInActiveWindow 会返回 SystemUI 的 root，但 getWindows() 仍包含
            // 前台应用窗口；若把 SystemUI 包名作为 preferredPackage，反而会稳定选错窗口。
            val windowRoot = getBestWindowRootCopy(preferredPackage)
            if (windowRoot != null) {
                refreshRoot(windowRoot)
                val readiness = evaluateRootForCapture(windowRoot, requiresVisibleSemanticNodes)
                if (readiness.isReady(requiresVisibleSemanticNodes)) {
                    Log.i(
                        TAG,
                        "getRootCopy selected window root: attempt=$attempt, package=${windowRoot.packageName}, " +
                            "childCount=${windowRoot.childCount}, " +
                            "visibleSemanticNodeCount=${readiness.visibleSemanticNodeCount ?: 0}, " +
                            "elapsedMs=${System.currentTimeMillis() - startedAt}",
                    )
                    emptyRoot?.recycle()
                    return windowRoot
                }
                Log.w(
                    TAG,
                    "getRootCopy found window root not ready: attempt=$attempt, " +
                        "rootHasContent=${readiness.rootHasContent}, " +
                        "visibleSemanticNodeCount=${readiness.visibleSemanticNodeCount ?: 0}, " +
                        "interestingNodeCount=${readiness.interestingNodeCount ?: 0}, " +
                        "package=${windowRoot.packageName}, " +
                        "class=${windowRoot.className}, childCount=${windowRoot.childCount}, " +
                        "visible=${windowRoot.isVisibleToUser}, windowId=${windowRoot.windowId}",
                )
                if (emptyRoot == null) emptyRoot = windowRoot else windowRoot.recycle()
            }

            // 只有窗口列表没有可遍历 root 时，才读取 rootInActiveWindow；两条路径都必须
            // 经过 rootHasContent，不能把空壳 root 直接交给 NodeTreeDumper。
            Log.i(TAG, "getRootCopy reading rootInActiveWindow: attempt=$attempt")
            val freshRoot = rootInActiveWindow
            if (freshRoot != null) {
                val freshCopy = try {
                    AccessibilityNodeInfo.obtain(freshRoot)
                } finally {
                    freshRoot.recycle()
                }
                refreshRoot(freshCopy)
                val matchesPreferredPackage = preferredPackage.isNullOrBlank() ||
                    freshCopy.packageName?.toString() == preferredPackage
                val readiness = if (matchesPreferredPackage) {
                    evaluateRootForCapture(freshCopy, requiresVisibleSemanticNodes)
                } else {
                    null
                }
                if (matchesPreferredPackage && readiness?.isReady(requiresVisibleSemanticNodes) == true) {
                    Log.i(
                        TAG,
                        "getRootCopy selected rootInActiveWindow: attempt=$attempt, package=${freshCopy.packageName}, " +
                            "childCount=${freshCopy.childCount}, " +
                            "visibleSemanticNodeCount=${readiness.visibleSemanticNodeCount ?: 0}, " +
                            "elapsedMs=${System.currentTimeMillis() - startedAt}",
                    )
                    emptyRoot?.recycle()
                    return freshCopy
                }
                if (matchesPreferredPackage) {
                    Log.w(
                        TAG,
                        "getRootCopy found active root not ready: attempt=$attempt, " +
                            "rootHasContent=${readiness?.rootHasContent == true}, " +
                            "visibleSemanticNodeCount=${readiness?.visibleSemanticNodeCount ?: 0}, " +
                            "interestingNodeCount=${readiness?.interestingNodeCount ?: 0}, " +
                            "package=${freshCopy.packageName}, " +
                            "class=${freshCopy.className}, childCount=${freshCopy.childCount}, " +
                            "visible=${freshCopy.isVisibleToUser}, windowId=${freshCopy.windowId}",
                    )
                    if (emptyRoot == null) emptyRoot = freshCopy else freshCopy.recycle()
                } else {
                    Log.w(
                        TAG,
                        "getRootCopy ignored active root from another package: attempt=$attempt, " +
                            "expected=$preferredPackage, actual=${freshCopy.packageName}, windowId=${freshCopy.windowId}",
                    )
                    freshCopy.recycle()
                }
            }

            val retryElapsedMs = SystemClock.elapsedRealtime() - startedElapsedMs
            if (attempt < captureAttempts && captureLevel.canRetry(attempt, retryElapsedMs)) {
                val retryDelayMs = captureLevel.nextRetryDelayMs(retryElapsedMs)
                if (retryDelayMs <= 0L) break
                if (requiresVisibleSemanticNodes) {
                    try {
                        val marker = accessibilityEventTracker.awaitAfter(
                            sinceSequence = observedEventSequence,
                            packageName = preferredPackage,
                            timeoutMs = retryDelayMs,
                        )
                        if (marker != null) {
                            observedEventSequence = marker.sequence
                            Log.i(
                                TAG,
                                "getRootCopy observed accessibility event while waiting: " +
                                    "sequence=${marker.sequence}, package=${marker.packageName}, " +
                                    "windowId=${marker.windowId}, eventTime=${marker.eventTime}",
                            )
                        }
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        break
                    }
                } else {
                    try {
                        Thread.sleep(retryDelayMs)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        break
                    }
                }
            }
        }

        // 空壳 root 是当前观测到的事实，优先交给 HTTP 层生成 TREE_ROOT_EMPTY 诊断；
        // 只有完全没有 root 时才回退到最近一次成功缓存。
        val cachedRootAvailable = synchronized(rootCacheLock) { currentRoot != null }
        val cachedFallback = if (emptyRoot == null && allowCachedFallback) {
            synchronized(rootCacheLock) {
                currentRoot?.let { AccessibilityNodeInfo.obtain(it) }
            }
        } else {
            null
        }
        val fallback = emptyRoot ?: cachedFallback
        Log.w(
            TAG,
            "getRootCopy finished without usable root: emptyRoot=${emptyRoot != null}, " +
                "cachedRoot=$cachedRootAvailable, usedCachedRoot=${fallback != null && emptyRoot == null}, " +
                "elapsedMs=${System.currentTimeMillis() - startedAt}",
        )
        return fallback
    }

    /** HTTP 查询时先读事件驱动的短时观察；预热正在运行时只等待有限时间。 */
    internal fun awaitPreparedTreeObservation(
        targetPackage: String?,
        mode: CompanionCaptureMode,
        waitMs: Long = 600L,
    ): PreparedTreeObservation? {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs.coerceAtLeast(0L))
        synchronized(treePreparationLock) {
            while (true) {
                findPreparedTreeObservation(targetPackage, mode)?.let { observation ->
                    if (activeTreePreparation == null) return observation
                }
                // 尚未开始的预热不应拖慢显式请求；请求会直接取得共享 coordinator。
                if (activeTreePreparation == null) return null

                val remainingNs = deadline - System.nanoTime()
                if (remainingNs <= 0L) return null
                val remainingMs = TimeUnit.NANOSECONDS.toMillis(remainingNs).coerceAtLeast(1L)
                treePreparationLock.wait(remainingMs)
            }
        }
    }

    internal fun isPreparedTreeObservationCurrent(
        observation: PreparedTreeObservation,
        targetPackage: String?,
        mode: CompanionCaptureMode,
    ): Boolean = findPreparedTreeObservation(targetPackage, mode) == observation

    private fun findPreparedTreeObservation(
        targetPackage: String?,
        mode: CompanionCaptureMode,
    ): PreparedTreeObservation? = preparedTreeCache.find(
        targetPackage = targetPackage,
        mode = mode,
        nowElapsedMs = SystemClock.elapsedRealtime(),
        currentEventSequence = preparedTreeEventSequence.get(),
    )

    /** 事件回调只复制轻量事件对象并合并任务，不在回调线程读取 source 或 root。 */
    private fun scheduleTreePreparation(event: AccessibilityEvent, marker: AccessibilityEventMarker) {
        if (!isTreeAffectingEvent(event.eventType)) return
        synchronized(treePreparationLock) {
            if (serviceDestroying) return
            val now = SystemClock.elapsedRealtime()
            val trigger = TreePreparationTrigger(
                event = AccessibilityEvent.obtain(event),
                marker = marker,
                treeSequence = preparedTreeEventSequence.incrementAndGet(),
            )
            pendingTreePreparation?.event?.recycle()
            pendingTreePreparation = trigger
            lastTreePreparationEventElapsedMs = now
            if (pendingTreePreparationFuture == null) {
                schedulePendingTreePreparationLocked(treePreparationDelay(now))
            }
            treePreparationLock.notifyAll()
        }
    }

    private fun treePreparationDelay(nowElapsedMs: Long): Long = treePreparationDelayMs(
        nowElapsedMs = nowElapsedMs,
        lastEventElapsedMs = lastTreePreparationEventElapsedMs,
        lastStartedElapsedMs = lastTreePreparationStartedElapsedMs,
        debounceMs = TREE_PREPARATION_DEBOUNCE_MS,
        minimumIntervalMs = TREE_PREPARATION_MIN_INTERVAL_MS,
    )

    /** 调用方持有 treePreparationLock；拒绝调度时释放排队的 AccessibilityEvent 副本。 */
    private fun schedulePendingTreePreparationLocked(delayMs: Long) {
        pendingTreePreparationFuture = try {
            treePreparationExecutor.schedule(
                { runPendingTreePreparation() },
                delayMs,
                TimeUnit.MILLISECONDS,
            )
        } catch (_: RejectedExecutionException) {
            pendingTreePreparation?.event?.recycle()
            pendingTreePreparation = null
            null
        }
    }

    private fun isTreeAffectingEvent(eventType: Int): Boolean {
        val treeEventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
            AccessibilityEvent.TYPE_WINDOWS_CHANGED or
            AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED or
            AccessibilityEvent.TYPE_VIEW_FOCUSED or
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED or
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED or
            AccessibilityEvent.TYPE_VIEW_SCROLLED or
            AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED or
            AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED or
            AccessibilityEvent.TYPE_VIEW_CLICKED or
            AccessibilityEvent.TYPE_VIEW_SELECTED
        return eventType and treeEventTypes != 0
    }

    private fun runPendingTreePreparation() {
        val trigger = synchronized(treePreparationLock) {
            pendingTreePreparationFuture = null
            val next = pendingTreePreparation
            if (next == null) {
                treePreparationLock.notifyAll()
                return@synchronized null
            }
            val now = SystemClock.elapsedRealtime()
            val delayMs = treePreparationDelay(now)
            if (delayMs > 0L) {
                schedulePendingTreePreparationLocked(delayMs)
                treePreparationLock.notifyAll()
                return@synchronized null
            }
            pendingTreePreparation = null
            activeTreePreparation = next
            lastTreePreparationStartedElapsedMs = now
            treePreparationLock.notifyAll()
            next
        } ?: return

        try {
            CompanionTreeCapture.coordinator.capture(CompanionHttpServer.TREE_CAPTURE_TIMEOUT_MS) {
                capturePreparedTreeObservation(trigger)
            }?.let { observation ->
                Log.i(
                    TAG,
                    "Prepared tree published: package=${observation.payload.packageName}, " +
                        "mode=${observation.mode.wireValue}, eventSequence=${observation.eventSequence}, " +
                        "nodeCount=${observation.nodeCount}",
                )
            }
        } catch (_: TreeCaptureBusyException) {
            Log.d(TAG, "Prepared tree skipped: tree capture coordinator is busy")
        } catch (_: TreeCaptureTimeoutException) {
            Log.w(TAG, "Prepared tree timed out; the shared tree capture coordinator remains guarded")
        } catch (exception: Exception) {
            Log.w(TAG, "Prepared tree failed: ${exception.message}", exception)
        } finally {
            trigger.event.recycle()
            synchronized(treePreparationLock) {
                if (activeTreePreparation === trigger) activeTreePreparation = null
                treePreparationLock.notifyAll()
            }
        }
    }

    /** 在 coordinator 工作线程校验事件 source，再单次读取、遍历并序列化整棵树。 */
    private fun capturePreparedTreeObservation(
        trigger: TreePreparationTrigger,
    ): PreparedTreeObservation? {
        val startedAt = System.currentTimeMillis()
        val targetPackage = trigger.marker.packageName.takeIf { it.isNotBlank() }
        if (serviceDestroying || trigger.treeSequence != preparedTreeEventSequence.get()) return null
        if (!eventSourceMatches(trigger, targetPackage)) return null

        val mode = currentCaptureMode()
        val root = getRootCopy(
            preferredPackage = targetPackage,
            // 预热只采一帧，不在后台执行 Enhanced 的长时间 root 重试；语义有效性会在本次 dump 后校验。
            mode = CompanionCaptureMode.NORMAL,
            captureLevel = CompanionCaptureLevel.FAST,
            allowCachedFallback = false,
            attemptLimit = 1,
        ) ?: return null

        try {
            if (!hasRootContent(root)) return null
            val dump = NodeTreeDumper.dumpWithDiagnostics(root)
            if (dump.nodes.length() == 0 ||
                (mode.requiresVisibleSemanticNodes && dump.visibleSemanticNodeCount == 0)
            ) return null

            val packageName = root.packageName?.toString().orEmpty()
            val screenSize = getScreenSize()
            val observation = PreparedTreeObservation(
                payload = PreparedTreeSnapshotPayload(
                    packageName = packageName,
                    screenWidth = screenSize.first,
                    screenHeight = screenSize.second,
                    nodesJson = dump.nodes.toString(),
                    accessibilityMode = if (mode == CompanionCaptureMode.ENHANCED) {
                        "touch_exploration"
                    } else {
                        "normal"
                    },
                    rootWindowId = root.windowId,
                    rootClassName = root.className?.toString().orEmpty(),
                    rootChildCount = root.childCount,
                    rootVisibleToUser = root.isVisibleToUser,
                ),
                mode = mode,
                eventSequence = trigger.treeSequence,
                capturedAtElapsedMs = SystemClock.elapsedRealtime(),
                nodeCount = dump.nodes.length(),
                visibleSemanticNodeCount = dump.visibleSemanticNodeCount,
            )
            val published = synchronized(treePreparationLock) {
                val currentSequence = preparedTreeEventSequence.get()
                !serviceDestroying && currentCaptureMode() == mode &&
                    preparedTreeCache.publishIfCurrent(observation, currentSequence, targetPackage)
            }
            if (!published) return null

            CompanionRuntimeHealth.state.recordTreeSuccess(
                at = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - startedAt,
                nodeCount = dump.nodes.length(),
            )
            return observation
        } finally {
            root.recycle()
        }
    }

    private fun eventSourceMatches(trigger: TreePreparationTrigger, targetPackage: String?): Boolean {
        val source = try {
            trigger.event.source
        } catch (exception: Exception) {
            Log.d(TAG, "Prepared tree event source unavailable: ${exception.message}")
            null
        } ?: return true

        return try {
            val sourcePackage = source.packageName?.toString().orEmpty()
            sourcePackage.isBlank() || targetPackage.isNullOrBlank() || sourcePackage == targetPackage
        } finally {
            source.recycle()
        }
    }

    private fun currentCaptureMode(): CompanionCaptureMode =
        if (getSystemService(AccessibilityManager::class.java).isTouchExplorationEnabled) {
            CompanionCaptureMode.ENHANCED
        } else {
            CompanionCaptureMode.NORMAL
        }

    private fun clearPreparedTreeObservations() {
        synchronized(treePreparationLock) {
            preparedTreeCache.clear()
            pendingTreePreparation?.event?.recycle()
            pendingTreePreparation = null
            pendingTreePreparationFuture?.cancel(false)
            pendingTreePreparationFuture = null
            treePreparationLock.notifyAll()
        }
    }

    /** 当前 Touch 状态或 deep 请求要求可见语义；fast 且 Touch 关闭时只要求 root 可遍历。 */
    private data class RootCaptureReadiness(
        val rootHasContent: Boolean,
        val visibleSemanticNodeCount: Int? = null,
        val interestingNodeCount: Int? = null,
    ) {
        fun isReady(requiresVisibleSemanticNodes: Boolean): Boolean {
            return rootHasContent &&
                (!requiresVisibleSemanticNodes || (visibleSemanticNodeCount ?: 0) > 0)
        }
    }

    private fun evaluateRootForCapture(
        root: AccessibilityNodeInfo,
        requiresVisibleSemanticNodes: Boolean,
    ): RootCaptureReadiness {
        val rootHasContent = rootHasContent(root)
        if (!rootHasContent || !requiresVisibleSemanticNodes) {
            return RootCaptureReadiness(rootHasContent = rootHasContent)
        }

        val dump = NodeTreeDumper.dumpWithDiagnostics(root)
        Log.i(
            TAG,
            "getRootCopy semantic readiness checked: package=${root.packageName}, " +
                "windowId=${root.windowId}, nodeCount=${dump.nodes.length()}, " +
                "visitedNodeCount=${dump.visitedNodeCount}, childReadFailures=${dump.childReadFailures}, " +
                "interestingNodeCount=${dump.interestingNodeCount}, " +
                "visibleSemanticNodeCount=${dump.visibleSemanticNodeCount}, truncated=${dump.truncated}",
        )
        return RootCaptureReadiness(
            rootHasContent = true,
            visibleSemanticNodeCount = dump.visibleSemanticNodeCount,
            interestingNodeCount = dump.interestingNodeCount,
        )
    }

    /**
     * 判断 root 是否包含可继续遍历的内容。
     * childCount 比只看 text 更可靠：应用根节点通常没有自己的文本，但有完整子树。
     */
    private fun rootHasContent(root: AccessibilityNodeInfo): Boolean {
        return isAccessibilityRootReady(
            AccessibilityRootSnapshot(
                packageName = root.packageName?.toString(),
                className = root.className?.toString(),
                childCount = root.childCount,
                visibleToUser = root.isVisibleToUser,
                text = root.text?.toString(),
                contentDescription = root.contentDescription?.toString(),
                clickable = root.isClickable,
                scrollable = root.isScrollable,
                editable = root.isEditable,
            ),
        )
    }

    /** 请求系统刷新节点快照；失败时保留原节点，交给上层按空 root 事实诊断。 */
    private fun refreshRoot(root: AccessibilityNodeInfo): Boolean {
        return try {
            root.refresh()
        } catch (exception: Exception) {
            Log.w(TAG, "refresh accessibility root failed: windowId=${root.windowId}", exception)
            false
        }
    }

    /** HTTP 层复用同一 root 判定，避免“服务认为为空”和“服务器认为可抓取”不一致。 */
    fun hasRootContent(root: AccessibilityNodeInfo): Boolean = rootHasContent(root)

    /** 仅缓存已经成功 dump 出节点的 root；调用方不转移传入 root 的所有权。 */
    @Synchronized
    fun rememberSuccessfulRoot(root: AccessibilityNodeInfo) {
        val replacement = AccessibilityNodeInfo.obtain(root)
        synchronized(rootCacheLock) {
            currentRoot?.recycle()
            currentRoot = replacement
        }
        Log.i(
            TAG,
            "remembered successful root: package=${root.packageName}, childCount=${root.childCount}, " +
                "windowId=${root.windowId}",
        )
    }

    /**
     * 从所有交互窗口中挑选最可能包含页面语义的 root。
     * active/focused 只作为辅助条件；有子树的窗口必须优先于“active 但空壳”的窗口。
     */
    private fun getBestWindowRootCopy(preferredPackage: String? = null): AccessibilityNodeInfo? {
        var bestRoot: AccessibilityNodeInfo? = null
        var bestScore = Int.MIN_VALUE
        Log.i(TAG, "getBestWindowRootCopy getWindows started")
        val windows = getWindows()
        Log.i(TAG, "getBestWindowRootCopy getWindows returned: count=${windows.size}")
        windows.forEachIndexed { index, window ->
            try {
                val rootStartedAt = System.currentTimeMillis()
                Log.i(
                    TAG,
                    "getBestWindowRootCopy window root started: index=$index, id=${window.id}, type=${window.type}, " +
                        "layer=${window.layer}, active=${window.isActive}, focused=${window.isFocused}",
                )
                val root = window.root ?: return@forEachIndexed
                Log.i(
                    TAG,
                    "getBestWindowRootCopy window root returned: index=$index, id=${window.id}, " +
                        "present=true, elapsedMs=${System.currentTimeMillis() - rootStartedAt}",
                )
                if (!preferredPackage.isNullOrBlank() && root.packageName?.toString() != preferredPackage) {
                    Log.w(
                        TAG,
                        "getBestWindowRootCopy ignored root from another package: index=$index, " +
                            "expected=$preferredPackage, actual=${root.packageName}, windowId=${root.windowId}",
                    )
                    root.recycle()
                    return@forEachIndexed
                }
                val score = rootScore(root, window, preferredPackage)
                if (score > bestScore) {
                    bestRoot?.recycle()
                    bestRoot = AccessibilityNodeInfo.obtain(root)
                    bestScore = score
                }
                root.recycle()
            } finally {
                window.recycle()
            }
        }
        return bestRoot
    }

    private fun rootScore(
        root: AccessibilityNodeInfo,
        window: AccessibilityWindowInfo,
        preferredPackage: String?,
    ): Int {
        // TYPE_ACCESSIBILITY_OVERLAY 只用于视觉提示或辅助浮层，不属于当前应用页面；
        // 明确跳过它，避免灵犀自己的状态栏提示在异常窗口时序下成为 /tree 根节点。
        if (window.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) return Int.MIN_VALUE

        var score = 0
        // 前台应用窗口必须压过状态栏/导航栏等系统窗口；系统窗口即使有子树，
        // 也不能替代当前 App 的空壳 root，否则微信永远无法进入语义租约流程。
        if (window.type == AccessibilityWindowInfo.TYPE_APPLICATION) score += 100_000
        if (window.isActive) score += 30_000
        if (window.isFocused) score += 15_000
        // active root 为空壳时，系统可能同时返回输入法/系统窗口；优先同包名窗口，
        // 避免把这些窗口的节点误当成微信页面。
        if (!preferredPackage.isNullOrBlank() && root.packageName?.toString() == preferredPackage) score += 50_000
        if (!root.packageName.isNullOrBlank()) score += 1_000
        // 空壳 root 常带 active/focused 标记；有实际内容时必须压过同类空壳窗口，
        // 但应用窗口的基础分仍高于输入法等系统窗口，避免把输入法树当成目标页面。
        if (rootHasContent(root)) score += 50_000
        score += minOf(root.childCount, 500)
        return score
    }

    /** 当前显示器尺寸，供 /tree 返回真实坐标系大小。 */
    fun getScreenSize(): Pair<Int, Int> {
        val metrics = resources.displayMetrics
        return metrics.widthPixels to metrics.heightPixels
    }

    /** 获取自 sinceTs 以来的事件列表（JSON 序列化用）。 */
    @Synchronized
    fun getEventsSince(sinceTs: Long): List<AccessibilityEvent> {
        // 返回副本，让 HTTP 层可以安全 recycle，不影响环形缓冲中的原始副本。
        return eventBuffer.filter { it.eventTime > sinceTs }.map { AccessibilityEvent.obtain(it) }
    }

    /** Debug：获取当前缓存 root 的副本，用于和 fresh root 对比。 */
    @Synchronized
    fun getCachedRootCopy(): AccessibilityNodeInfo? {
        return synchronized(rootCacheLock) {
            currentRoot?.let { AccessibilityNodeInfo.obtain(it) }
        }
    }

    /** Debug：每次请求直接读取当前 active window，不复用事件回调时的缓存。 */
    @Synchronized
    fun getFreshActiveRoot(): AccessibilityNodeInfo? {
        return rootInActiveWindow
    }

    /** Debug：读取全部交互窗口，并把每个窗口的 root 所有权交给调用方。 */
    @Synchronized
    fun getFreshWindowRoots(): List<DebugWindowRoot> {
        val result = mutableListOf<DebugWindowRoot>()
        getWindows().forEach { window ->
            try {
                result += DebugWindowRoot(
                    id = window.id,
                    type = window.type,
                    layer = window.layer,
                    title = window.title?.toString() ?: "",
                    active = window.isActive,
                    focused = window.isFocused,
                    root = window.root,
                )
            } finally {
                window.recycle()
            }
        }
        return result
    }

    /** Debug：导出服务实际生效的配置和系统无障碍状态。 */
    fun getDebugServiceState(): Map<String, Any> {
        val info = serviceInfo
        val manager = getSystemService(AccessibilityManager::class.java)
        val capabilities = info.capabilities
        return mapOf(
            "eventTypes" to info.eventTypes,
            "feedbackType" to info.feedbackType,
            "feedbackTypeName" to AccessibilityServiceInfo.feedbackTypeToString(info.feedbackType),
            "flags" to info.flags,
            "flagsHex" to "0x${info.flags.toString(16)}",
            "packageNames" to (info.packageNames?.toList() ?: emptyList<String>()),
            "notificationTimeout" to info.notificationTimeout,
            "capabilities" to capabilities,
            "canRetrieveWindowContent" to (
                capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT != 0
            ),
            "canRequestTouchExplorationMode" to (
                capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_REQUEST_TOUCH_EXPLORATION != 0
            ),
            "isAccessibilityTool" to info.isAccessibilityTool,
            "accessibilityEnabled" to manager.isEnabled,
            "touchExplorationEnabled" to manager.isTouchExplorationEnabled,
            "touchExplorationRequested" to (
                info.flags and AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE != 0
            ),
            "accessibilityMode" to if (manager.isTouchExplorationEnabled) "touch_exploration" else "normal",
        )
    }

    /** 返回系统实际是否已经启用 Touch Exploration，调用方不能把 requested 当成生效状态。 */
    @Synchronized
    fun isTouchExplorationEnabled(): Boolean {
        return getSystemService(AccessibilityManager::class.java).isTouchExplorationEnabled
    }

    /**
     * Debug：按需申请或释放 Touch Exploration。
     *
     * 该模式会改变系统触摸手势，不能在服务启动时永久打开；微信读屏专项测试
     * 结束后应调用 disabled 恢复系统默认的边缘返回和底部回桌面行为。
     */
    @Synchronized
    fun setTouchExplorationRequested(enabled: Boolean): Map<String, Any> {
        getSharedPreferences(TOUCH_EXPLORATION_PREFS, MODE_PRIVATE).edit()
            .putBoolean(TOUCH_EXPLORATION_REQUESTED_KEY, enabled)
            .apply()
        return applyTouchExplorationRequest(enabled)
    }

    /** 将 Touch 请求应用到当前 serviceInfo，并刷新 overlay 与 health。 */
    @Synchronized
    private fun applyTouchExplorationRequest(enabled: Boolean): Map<String, Any> {
        synchronized(treePreparationLock) {
            preparedTreeCache.clear()
            treePreparationLock.notifyAll()
        }
        val info = serviceInfo
        val requestFlag = AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
        // 仅申请 Touch Exploration 不会把双击交给服务；该 flag 是用户紧急退出的关键。
        // API 30 以下没有双击手势能力，不能访问不存在的 framework 字段。
        val doubleTapFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            AccessibilityServiceInfo.FLAG_SERVICE_HANDLES_DOUBLE_TAP
        } else {
            0
        }
        val managedFlags = requestFlag or doubleTapFlag
        info.flags = if (enabled) info.flags or managedFlags else info.flags and managedFlags.inv()
        setServiceInfo(info)
        // 状态栏提示与请求状态同步；关闭时立即移除，避免用户继续误以为手势仍被接管。
        updateTouchExplorationBanner(enabled)
        refreshAccessibilityHealth()
        Log.i(TAG, "Touch Exploration 请求已更新: enabled=$enabled, flags=0x${info.flags.toString(16)}")
        return getDebugServiceState()
    }

    /** 把系统实际生效的能力与读屏状态写入统一 health，不能只记录请求值。 */
    private fun refreshAccessibilityHealth() {
        val info = serviceInfo
        val manager = getSystemService(AccessibilityManager::class.java)
        CompanionRuntimeHealth.state.setAccessibilityState(
            authorized = instance === this,
            canRetrieveWindowContent =
                info.capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT != 0,
            touchExploration = manager.isTouchExplorationEnabled,
        )
    }

    /**
     * 失败信封生成前重新确认无障碍能力与读屏状态。
     * 只读系统状态，不重启 Service、不改 Touch Exploration，供诊断与 Level 1 判断使用。
     */
    fun refreshHealthSnapshot() {
        refreshAccessibilityHealth()
    }

    /** Debug：复制事件摘要，避免 HTTP 层接触 AccessibilityEvent 生命周期。 */
    @Synchronized
    fun getDebugEvents(): List<DebugEvent> = debugEventBuffer.toList()

    /** Debug：当前是否已经收到过事件并建立过缓存 root。 */
    @Synchronized
    fun hasCachedRoot(): Boolean = synchronized(rootCacheLock) { currentRoot != null }
}
