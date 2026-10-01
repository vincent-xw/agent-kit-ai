package com.agentkit.companion

import com.agentkit.companion.LingxiLogger as Log

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory

/**
 * 监听设备默认网络，只用于诊断 Companion 连接问题。
 *
 * Companion HTTP 服务绑定在 127.0.0.1，网络切换本身不会让监听 socket 失效；
 * 但无线 ADB 或上层网络连接可能因为切换网卡而断开，所以把状态明确展示给用户。
 */
class NetworkStatusMonitor(
    context: Context,
    private val onStatusChanged: (NetworkStatus) -> Unit,
) {
    private val connectivityManager = context.getSystemService(ConnectivityManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var registered = false

    /** 监听回调可能运行在 Binder 线程，统一切到主线程读取当前默认网络。 */
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = notifyCurrentStatus()

        override fun onLost(network: Network) = notifyCurrentStatus()

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) =
            notifyCurrentStatus()
    }

    /** 开始监听；重复调用不会重复注册系统回调。 */
    fun start() {
        if (registered) return
        registered = true
        try {
            connectivityManager.registerDefaultNetworkCallback(callback)
            publishCurrentStatus()
        } catch (exception: Exception) {
            registered = false
            Log.e(TAG, "注册网络状态监听失败", exception)
            publishCurrentStatus()
        }
    }

    /** 停止监听，避免 Activity 离开前台后继续持有系统回调。 */
    fun stop() {
        if (!registered) return
        registered = false
        runCatching { connectivityManager.unregisterNetworkCallback(callback) }
        mainHandler.removeCallbacksAndMessages(null)
    }

    /** 将网络变化事件合并到主线程，避免在系统回调线程直接触碰界面。 */
    private fun notifyCurrentStatus() {
        mainHandler.post {
            if (registered) publishCurrentStatus()
        }
    }

    /** 读取当前默认网络并通知界面。 */
    private fun publishCurrentStatus() {
        onStatusChanged(readCurrentStatus())
    }

    /** 生成当前默认网络的可读状态，不读取 Wi-Fi 名称等额外敏感信息。 */
    private fun readCurrentStatus(): NetworkStatus {
        val network = connectivityManager.activeNetwork
            ?: return NetworkStatus.disconnected()
        val capabilities = connectivityManager.getNetworkCapabilities(network)
            ?: return NetworkStatus.unknownConnected()
        return NetworkStatus.from(capabilities)
    }

    companion object {
        private const val TAG = "LingxiNetwork"
    }
}

/** 默认网络的最小诊断信息。 */
data class NetworkStatus(
    val label: String,
    val connected: Boolean,
    val validated: Boolean,
    val transports: List<String>,
) {
    /** 用于判断状态是否真的变化，避免同一网络的重复 callback 反复提示用户。 */
    val key: String
        get() = "$label|$connected|$validated|${transports.joinToString(",")}"

    /** 给主界面显示的状态文本。 */
    fun displayText(): String {
        val reachability = when {
            !connected -> "未连接"
            validated -> "已验证可上网"
            else -> "已连接，未验证可上网"
        }
        return "$label（$reachability）"
    }

    companion object {
        /** 从 Android 网络能力提取不依赖具体网卡地址的传输类型。 */
        fun from(capabilities: NetworkCapabilities): NetworkStatus {
            val transports = buildList {
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) add("Wi-Fi")
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) add("移动网络")
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) add("以太网")
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) add("VPN")
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) add("蓝牙")
            }
            return NetworkStatus(
                label = transports.joinToString("+").ifBlank { "其他网络" },
                connected = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
                transports = transports,
            )
        }

        /** 没有默认网络时的状态。 */
        fun disconnected(): NetworkStatus = NetworkStatus(
            label = "无网络",
            connected = false,
            validated = false,
            transports = emptyList(),
        )

        /** 系统有默认网络但暂时拿不到能力信息时的状态。 */
        fun unknownConnected(): NetworkStatus = NetworkStatus(
            label = "网络检测中",
            connected = true,
            validated = false,
            transports = emptyList(),
        )
    }
}

/** 一条可同时用于界面、HTTP Debug 接口和 ADB 文件读取的灵犀日志。 */
data class LingxiLogEntry(
    val timestamp: Long,
    val level: String,
    val tag: String,
    val message: String,
    val formatted: String,
)

/**
 * 灵犀统一日志入口。
 *
 * 每次写日志都会继续写入 Android logcat，同时写入应用私有文件并通知主界面。
 * 文件位于 files/logs/lingxi.log，Debug APK 可通过 run-as 读取，不需要存储权限。
 */
object LingxiLogger {
    const val LOG_FILE_RELATIVE_PATH = "files/logs/lingxi.log"
    private const val TAG = "LingxiLog"
    private const val LOG_DIRECTORY = "logs"
    private const val LOG_FILE_NAME = "lingxi.log"
    private const val MAX_ENTRIES = 300
    private const val MAX_FILE_BYTES = 512 * 1024L

    private val lock = Any()
    private val entries = ArrayDeque<LingxiLogEntry>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    /** 日志文件异步串行写入，避免 HTTP 或无障碍事件线程被磁盘 I/O 阻塞。 */
    private val fileWriter = Executors.newSingleThreadExecutor(object : ThreadFactory {
        override fun newThread(runnable: Runnable): Thread {
            return Thread(runnable, "Lingxi Log Writer").apply { isDaemon = true }
        }
    })
    private val dateFormat = ThreadLocal.withInitial {
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
    }
    private var applicationContext: android.content.Context? = null

    /** 初始化持久化目录；服务比 Activity 更早启动时也可以安全调用。 */
    fun initialize(context: android.content.Context) {
        synchronized(lock) {
            if (applicationContext != null) return
            applicationContext = context.applicationContext
            loadExistingLogsLocked()
        }
    }

    /** 订阅新日志；返回取消订阅函数，避免 Activity 重建后重复刷新。 */
    fun subscribe(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    /** 获取最近日志，供 Debug HTTP 接口和主界面使用。 */
    fun snapshot(limit: Int = MAX_ENTRIES): List<LingxiLogEntry> {
        synchronized(lock) {
            return entries.takeLast(limit.coerceIn(1, MAX_ENTRIES))
        }
    }

    /** 获取最近日志的纯文本表示，保证复制、HTTP raw 接口和文件内容格式一致。 */
    fun formattedText(limit: Int = MAX_ENTRIES): String {
        return snapshot(limit).joinToString("\n") { it.formatted }
    }

    /** 返回给 ADB 使用的稳定相对路径，不暴露设备上的用户目录。 */
    fun adbFilePath(): String = LOG_FILE_RELATIVE_PATH

    fun d(tag: String, message: String, throwable: Throwable? = null) = write("D", tag, message, throwable)
    fun i(tag: String, message: String, throwable: Throwable? = null) = write("I", tag, message, throwable)
    fun w(tag: String, message: String, throwable: Throwable? = null) = write("W", tag, message, throwable)
    fun e(tag: String, message: String, throwable: Throwable? = null) = write("E", tag, message, throwable)

    private fun write(level: String, tag: String, message: String, throwable: Throwable?) {
        // 先写系统日志，保证即使文件初始化或 UI 进程异常，ADB logcat 仍能看到记录。
        when (level) {
            "D" -> if (throwable == null) android.util.Log.d(tag, message) else android.util.Log.d(tag, message, throwable)
            "I" -> if (throwable == null) android.util.Log.i(tag, message) else android.util.Log.i(tag, message, throwable)
            "W" -> if (throwable == null) android.util.Log.w(tag, message) else android.util.Log.w(tag, message, throwable)
            else -> if (throwable == null) android.util.Log.e(tag, message) else android.util.Log.e(tag, message, throwable)
        }

        val timestamp = System.currentTimeMillis()
        val stack = throwable?.let { "\n${android.util.Log.getStackTraceString(it)}" }.orEmpty()
        val formatted = "[${dateFormat.get().format(Date(timestamp))}] $level/$tag: $message$stack"
        synchronized(lock) {
            entries.addLast(LingxiLogEntry(timestamp, level, tag, message + stack, formatted))
            while (entries.size > MAX_ENTRIES) entries.removeFirst()
        }
        // 文件写入按产生顺序串行排队，内存快照和 UI 通知不等待磁盘完成。
        runCatching { fileWriter.execute { appendToFile(formatted) } }
        listeners.forEach { listener -> runCatching { listener() } }
    }

    /** 从上一次运行留下的文件加载尾部，方便用户打开主界面立即看到启动前的失败原因。 */
    private fun loadExistingLogsLocked() {
        val file = logFileLocked() ?: return
        if (!file.exists()) return
        runCatching {
            file.readLines().takeLast(MAX_ENTRIES).forEach { line ->
                entries.addLast(LingxiLogEntry(0L, "", "", line, line))
            }
        }.onFailure { exception ->
            android.util.Log.e(TAG, "读取持久化日志失败", exception)
        }
    }

    private fun appendToFile(line: String) {
        val file = logFileLocked() ?: return
        runCatching {
            file.parentFile?.mkdirs()
            file.appendText(line + "\n", Charsets.UTF_8)
            if (file.length() > MAX_FILE_BYTES) trimFile(file)
        }.onFailure { exception ->
            // 不能再次调用 LingxiLogger.e，否则文件写失败会递归产生日志。
            android.util.Log.e(TAG, "写入持久化日志失败", exception)
        }
    }

    /** 超过上限时保留尾部，避免日志文件无限增长。 */
    private fun trimFile(file: File) {
        val content = file.readText(Charsets.UTF_8)
        val start = (content.length - (MAX_FILE_BYTES / 2).toInt()).coerceAtLeast(0)
        val firstLineEnd = content.indexOf('\n', start)
        val retained = if (firstLineEnd >= 0) content.substring(firstLineEnd + 1) else content.substring(start)
        file.writeText(retained, Charsets.UTF_8)
    }

    private fun logFileLocked(): File? {
        val context = applicationContext ?: return null
        return File(File(context.filesDir, LOG_DIRECTORY), LOG_FILE_NAME)
    }
}
