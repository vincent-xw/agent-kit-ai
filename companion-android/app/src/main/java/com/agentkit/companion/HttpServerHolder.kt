package com.agentkit.companion

import com.agentkit.companion.LingxiLogger as Log

/**
 * 持有 CompanionHttpServer 单例。
 *
 * 服务器在无障碍服务连接时启动（onServiceConnected），MainActivity 只在
 * 服务未连接时引导用户开启权限。避免依赖 Activity 生命周期导致服务绑定
 * 异步时机下服务器不启动。
 */
object HttpServerHolder {
    private const val TAG = "LingxiHttp"
    private const val WATCHDOG_INTERVAL_MS = 1_000L
    private const val WATCHDOG_FAILURE_LOG_INTERVAL_MS = 10_000L
    /** 心跳超时后用真实 HTTP 请求复核，避免误杀仍可服务的监听器。 */
    private const val WATCHDOG_HTTP_PROBE_TIMEOUT_MS = 1_000
    @Volatile
    private var server: CompanionHttpServer? = null
    @Volatile
    private var watchdogThread: Thread? = null
    private var lastWatchdogFailureLogAt = 0L

    /** 启动服务器（幂等：已启动则忽略）。 */
    @Synchronized
    fun start() {
        val existing = server
        if (existing?.isAlive == true) {
            // 主界面状态刷新和服务回调都可能重复调用 start；正常幂等命中不写日志，避免刷屏。
            startWatchdogLocked()
            return
        }
        if (existing != null) {
            // 只保存 server 引用而不检查线程状态会留下“假活着”的服务器：服务重新授权后，
            // MainActivity 再次调用 start() 也不会重建监听线程，最终表现为所有 HTTP 请求超时。
            Log.w(TAG, "HTTP server reference is stale; rebuilding: alive=${existing.isAlive}")
            existing.stop()
            server = null
        }
        // 先启动看门狗，确保首次 bind 失败时仍有后台重试机会。
        startWatchdogLocked()
        try {
            startServerLocked()
            lastWatchdogFailureLogAt = 0L
        } catch (e: Exception) {
            // 启动失败时清空引用；看门狗会在端口恢复后继续尝试，不要求用户切到前台。
            server = null
            CompanionRuntimeHealth.state.setHttpListening(false, System.currentTimeMillis())
            Log.e(TAG, "HTTP server start failed", e)
            throw e
        }
    }

    /** 创建新的监听实例；调用方必须已经持有 Holder 的锁。 */
    private fun startServerLocked(logAttempt: Boolean = true) {
        if (logAttempt) Log.i(TAG, "Starting HTTP server on 127.0.0.1:7777")
        val candidate = CompanionHttpServer()
        // Android/MIUI 上 daemon listener 可能长期停在 accept() 而不消费转发连接；
        // 让监听线程保持非 daemon，交由 watchdog 监控并在异常退出后重建。
        candidate.start(CompanionHttpServer.SOCKET_READ_TIMEOUT_MS, false)
        server = candidate
        Log.i(TAG, "HTTP server started: alive=${candidate.isAlive}, port=${candidate.listeningPort}")
    }

    /** 只重启 HTTP 监听器，不销毁无障碍服务，也不改变 Touch Exploration 状态。 */
    @Synchronized
    fun restart() {
        Log.i(TAG, "Restarting HTTP server by user request")
        server?.stop()
        server = null
        watchdogThread?.interrupt()
        watchdogThread = null
        start()
    }

    /** 返回当前监听器状态，供主界面显示真实状态。 */
    @Synchronized
    fun isServerAlive(): Boolean = server?.isAlive == true

    /**
     * 后台看门狗：无障碍服务仍绑定时，如果监听线程异常退出或心跳停止，自动重建 7777。
     * 这能覆盖“server 引用还在但 /tree 一直 fetch failed”的失效状态，不需要用户重新授权。
     */
    private fun startWatchdogLocked() {
        if (watchdogThread?.isAlive == true) return
        watchdogThread = Thread({ watchdogLoop() }, "Lingxi HTTP Watchdog").apply {
            // 看门狗不能阻止 Android 进程在服务销毁后退出。
            isDaemon = true
            start()
        }
    }

    private fun watchdogLoop() {
        val currentThread = Thread.currentThread()
        try {
            while (!currentThread.isInterrupted) {
                try {
                    Thread.sleep(WATCHDOG_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    break
                }

                synchronized(this) {
                    val current = server
                    if (current == null) {
                        try {
                            // 首次启动失败时没有 server 可检查，仍必须继续尝试创建监听器。
                            startServerLocked(logAttempt = false)
                            lastWatchdogFailureLogAt = 0L
                        } catch (exception: Exception) {
                            CompanionRuntimeHealth.state.setHttpListening(false, System.currentTimeMillis())
                            logWatchdogFailureLocked("HTTP server watchdog retry failed", exception)
                        }
                    } else if (!current.isAlive) {
                        if (current.isResponsive(WATCHDOG_HTTP_PROBE_TIMEOUT_MS)) {
                            // 本地 health 已证明服务可用；accept 心跳只是瞬时滞后，不重建端口。
                            Log.w(TAG, "HTTP listener heartbeat stale but local health is responsive; skip rebuild")
                        } else {
                            Log.w(TAG, "HTTP server health check failed; rebuilding listener")
                            current.stop()
                            if (server === current) server = null
                            try {
                                startServerLocked(logAttempt = false)
                            } catch (exception: Exception) {
                                // 保留 server=null；下一轮继续尝试，避免一次端口瞬时冲突永久失联。
                                CompanionRuntimeHealth.state.setHttpListening(false, System.currentTimeMillis())
                                logWatchdogFailureLocked("HTTP server watchdog rebuild failed", exception)
                            }
                        }
                    }
                }
            }
        } finally {
            synchronized(this) {
                if (watchdogThread === currentThread) watchdogThread = null
            }
        }
    }

    /** 限制后台失败日志频率，避免端口持续不可用时刷屏干扰诊断。 */
    private fun logWatchdogFailureLocked(message: String, exception: Exception) {
        val now = System.currentTimeMillis()
        if (now - lastWatchdogFailureLogAt < WATCHDOG_FAILURE_LOG_INTERVAL_MS) return
        lastWatchdogFailureLogAt = now
        Log.e(TAG, message, exception)
    }

    /** 停止服务器。 */
    @Synchronized
    fun stop() {
        Log.i(TAG, "Stopping HTTP server")
        server?.stop()
        server = null
        watchdogThread?.interrupt()
        watchdogThread = null
        CompanionRuntimeHealth.state.setHttpListening(false, System.currentTimeMillis())
    }
}
