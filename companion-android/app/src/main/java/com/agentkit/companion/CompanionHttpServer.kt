package com.agentkit.companion

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityEvent
import com.agentkit.companion.LingxiLogger as Log
import org.json.JSONObject
import org.json.JSONArray
import java.io.BufferedInputStream
import java.io.BufferedWriter
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 绑定 127.0.0.1:7777 的 HTTP 服务器，提供无障碍树和操作接口。
 * 只有 BFF 通过 adb forward 连接，因此无需鉴权。
 */
class CompanionHttpServer(private val port: Int = 7777) {

    companion object {
        const val TAG = "LingxiHttp"
        const val SOCKET_READ_TIMEOUT_MS = 5_000
        const val ACCEPT_TIMEOUT_MS = 1_000
        const val LISTENER_HEARTBEAT_TIMEOUT_MS = 3_000L
        const val MAX_REQUEST_LINE_BYTES = 8 * 1024
        const val MAX_HEADER_BYTES = 64 * 1024
        const val MAX_BODY_BYTES = 2 * 1024 * 1024
        const val TREE_CAPTURE_TIMEOUT_MS = 10_000L
        private const val MAX_ACTIVE_REQUESTS = 4
    }

    /** HTTP 方法的最小集合；当前 Companion API 只需要 GET 和 POST。 */
    enum class Method {
        GET,
        POST,
        PUT,
        DELETE,
        PATCH,
        HEAD,
        OPTIONS,
    }

    /** 路由层需要的请求接口，替代 NanoHTTPD 的 IHTTPSession。 */
    interface IHTTPSession {
        val uri: String
        val method: Method
        val parameters: Map<String, List<String>>

        /** 将请求体放入 NanoHTTPD 兼容的 postData 字段。 */
        fun parseBody(files: MutableMap<String, String>)
    }

    /** HTTP 响应状态和正文。 */
    class Response(
        val status: Status,
        val mimeType: String,
        val body: String,
    ) {
        enum class Status(val code: Int, val reason: String) {
            OK(200, "OK"),
            BAD_REQUEST(400, "Bad Request"),
            NOT_FOUND(404, "Not Found"),
            INTERNAL_ERROR(500, "Internal Server Error"),
            SERVICE_UNAVAILABLE(503, "Service Unavailable"),
            GATEWAY_TIMEOUT(504, "Gateway Timeout"),
        }

        /** 写出固定长度响应并主动关闭连接，避免坏客户端长期占用工作线程。 */
        fun writeTo(output: OutputStream) {
            val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
            val writer = BufferedWriter(OutputStreamWriter(output, StandardCharsets.UTF_8))
            writer.write("HTTP/1.1 ${status.code} ${status.reason}\r\n")
            writer.write("Content-Type: $mimeType; charset=utf-8\r\n")
            writer.write("Content-Length: ${bodyBytes.size}\r\n")
            writer.write("Connection: close\r\n")
            writer.write("\r\n")
            writer.flush()
            output.write(bodyBytes)
            output.flush()
        }
    }

    private class RequestSession(
        override val uri: String,
        override val method: Method,
        override val parameters: Map<String, List<String>>,
        private val body: String,
    ) : IHTTPSession {
        override fun parseBody(files: MutableMap<String, String>) {
            files["postData"] = body
        }
    }

    private val requestCount = AtomicLong(0)
    private val activeRequests = AtomicInteger(0)
    /** 监听循环最近一次成功运行的时间，用于识别线程“还活着但已不再消费连接”。 */
    private val lastListenerHeartbeat = AtomicLong(0)
    private val clientExecutor: ExecutorService = Executors.newFixedThreadPool(MAX_ACTIVE_REQUESTS, object : ThreadFactory {
        override fun newThread(runnable: Runnable): Thread {
            return Thread(runnable, "Lingxi HTTP Request ${requestCount.incrementAndGet()}").apply {
                // 客户端请求不能阻止 AccessibilityService 进程退出。
                isDaemon = true
            }
        }
    })

    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null
    private var listenerThread: Thread? = null

    /** 与旧 NanoHTTPD API 保持相同的启动签名，调用方不需要感知 HTTP 实现变化。 */
    @Synchronized
    fun start(@Suppress("UNUSED_PARAMETER") socketReadTimeoutMs: Int = SOCKET_READ_TIMEOUT_MS, daemon: Boolean = true) {
        if (running) {
            Log.i(TAG, "HTTP server already exists: alive=$isAlive, port=$listeningPort")
            return
        }

        val socket = ServerSocket()
        try {
            // 仅绑定 loopback；ADB forward 是唯一的外部访问路径。
            socket.reuseAddress = true
            socket.bind(
                InetSocketAddress(InetAddress.getByName("127.0.0.1"), port),
                50,
            )
            // 周期性超时让监听线程刷新心跳，并能及时响应 stop() 的生命周期变化。
            socket.soTimeout = ACCEPT_TIMEOUT_MS
            serverSocket = socket
            lastListenerHeartbeat.set(System.currentTimeMillis())
            CompanionRuntimeHealth.state.setHttpListening(
                listening = true,
                heartbeatAt = lastListenerHeartbeat.get(),
            )
            running = true
            listenerThread = Thread({ acceptLoop(socket) }, "Lingxi HTTP Listener").apply {
                isDaemon = daemon
                start()
            }
            Log.i(TAG, "HTTP server started: alive=$isAlive, port=$listeningPort, implementation=server-socket")
        } catch (exception: Exception) {
            runCatching { socket.close() }
            serverSocket = null
            running = false
            throw exception
        }
    }

    @Synchronized
    fun stop() {
        if (!running && serverSocket == null) return
        Log.i(TAG, "Stopping HTTP server")
        running = false
        runCatching { serverSocket?.close() }
        serverSocket = null
        listenerThread?.interrupt()
        listenerThread = null
        lastListenerHeartbeat.set(0)
        CompanionRuntimeHealth.state.setHttpListening(
            listening = false,
            heartbeatAt = System.currentTimeMillis(),
        )
        // 结束仍在等待请求头或响应的客户端，避免服务重启后旧请求继续占用资源。
        clientExecutor.shutdownNow()
    }

    val isAlive: Boolean
        get() {
            val heartbeat = lastListenerHeartbeat.get()
            return running && listenerThread?.isAlive == true && serverSocket?.isBound == true &&
                serverSocket?.isClosed == false &&
                (heartbeat == 0L || System.currentTimeMillis() - heartbeat <= LISTENER_HEARTBEAT_TIMEOUT_MS)
        }

    val listeningPort: Int
        get() = serverSocket?.localPort ?: -1

    /**
     * 通过真实 loopback 请求确认监听器能够接收并完成 HTTP 响应。
     *
     * Android/MIUI 上 ServerSocket.accept 的超时心跳偶尔不会按预期刷新；不能只因心跳过期
     * 就关闭正在工作的监听器，否则会让 BFF 的请求在重建窗口中被错误中断。
     */
    fun isResponsive(timeoutMs: Int): Boolean {
        val socket = serverSocket ?: return false
        if (!running || socket.isClosed || !socket.isBound) return false
        return LoopbackHealthProbe.isResponsive(socket.localPort, timeoutMs)
    }

    /** 带超时的标准 accept：可靠消费 ADB forward backlog，并周期性刷新监听心跳。 */
    private fun acceptLoop(socket: ServerSocket) {
        try {
            while (running && !socket.isClosed) {
                lastListenerHeartbeat.set(System.currentTimeMillis())
                CompanionRuntimeHealth.state.setHttpListening(
                    listening = true,
                    heartbeatAt = lastListenerHeartbeat.get(),
                )
                val client = try {
                    socket.accept()
                } catch (_: SocketTimeoutException) {
                    continue
                }
                try {
                    clientExecutor.execute { handleClient(client) }
                } catch (rejected: RejectedExecutionException) {
                    // 服务停止期间或达到并发上限时，必须关闭已 accept 的连接，不能让它进入
                    // CLOSE_WAIT 并继续占用 ADB forward 的连接队列。
                    Log.w(TAG, "HTTP request rejected; closing client", rejected)
                    runCatching { client.close() }
                }
            }
        } catch (exception: Exception) {
            if (running) Log.e(TAG, "HTTP listener stopped unexpectedly", exception)
        } finally {
            Log.i(TAG, "HTTP listener exited: running=$running")
        }
    }

    /** 解析一个短 HTTP 请求并把路由响应写回客户端。 */
    private fun handleClient(socket: Socket) {
        val requestId = requestCount.incrementAndGet()
        val startedAt = System.currentTimeMillis()
        val currentRequests = activeRequests.incrementAndGet()
        Log.i(TAG, "HTTP client accepted: id=$requestId, active=$currentRequests")
        socket.use { client ->
            client.soTimeout = SOCKET_READ_TIMEOUT_MS
            try {
                val input = BufferedInputStream(client.getInputStream())
                // 请求头和 body 必须从同一个字节流读取；不能混用 BufferedReader 与底层 input，
                // 否则 BufferedReader 可能预读 body，导致后续读取 Content-Length 个字节时拿到 EOF。
                val requestLine = readHttpLine(input, MAX_REQUEST_LINE_BYTES) ?: return
                if (requestLine.toByteArray(StandardCharsets.UTF_8).size > MAX_REQUEST_LINE_BYTES) {
                    protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.invalidRequest("请求行过长"),
                        requestId,
                        startedAt,
                    ).writeTo(client.getOutputStream())
                    return
                }
                val requestParts = requestLine.split(' ', limit = 3)
                if (requestParts.size != 3) {
                    protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.invalidRequest("请求行格式错误"),
                        requestId,
                        startedAt,
                    ).writeTo(client.getOutputStream())
                    return
                }

                val headers = linkedMapOf<String, String>()
                var headerBytes = 0
                while (true) {
                    val line = readHttpLine(input, MAX_HEADER_BYTES) ?: return
                    if (line.isEmpty()) break
                    headerBytes += line.toByteArray(StandardCharsets.UTF_8).size + 2
                    if (headerBytes > MAX_HEADER_BYTES) {
                        protocolError(
                            Response.Status.BAD_REQUEST,
                            CompanionProtocolFailures.invalidRequest("请求头过长"),
                            requestId,
                            startedAt,
                        ).writeTo(client.getOutputStream())
                        return
                    }
                    val separator = line.indexOf(':')
                    if (separator > 0) {
                        headers[line.substring(0, separator).lowercase()] = line.substring(separator + 1).trim()
                    }
                }

                val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                if (contentLength < 0 || contentLength > MAX_BODY_BYTES) {
                    protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.invalidRequest("请求体过大"),
                        requestId,
                        startedAt,
                    ).writeTo(client.getOutputStream())
                    return
                }
                val bodyBytes = ByteArray(contentLength)
                var offset = 0
                while (offset < bodyBytes.size) {
                    val read = input.read(bodyBytes, offset, bodyBytes.size - offset)
                    if (read <= 0) return
                    offset += read
                }

                val target = requestParts[1]
                val queryStart = target.indexOf('?')
                val path = if (queryStart >= 0) target.substring(0, queryStart) else target
                val query = if (queryStart >= 0) target.substring(queryStart + 1) else ""
                val session = RequestSession(
                    uri = path,
                    method = Method.values().firstOrNull { it.name == requestParts[0] } ?: Method.GET,
                    parameters = parseParameters(query),
                    body = bodyBytes.toString(StandardCharsets.UTF_8),
                )
                Log.i(TAG, "HTTP request parsed: id=$requestId, method=${session.method}, uri=${session.uri}")
                val response = serve(session, requestId)
                response.writeTo(client.getOutputStream())
                Log.i(
                    TAG,
                    "HTTP response sent: id=$requestId, status=${response.status.code}, " +
                        "elapsedMs=${System.currentTimeMillis() - startedAt}",
                )
            } catch (exception: Exception) {
                Log.e(TAG, "HTTP client handling failed: id=$requestId, elapsedMs=${System.currentTimeMillis() - startedAt}", exception)
            } finally {
                val remaining = activeRequests.decrementAndGet()
                Log.i(TAG, "HTTP client closed: id=$requestId, active=$remaining")
            }
        }
    }

    /**
     * 从字节流读取一行 HTTP 文本，并保留 body 的边界。
     *
     * HTTP 的 Content-Length 按字节计算，因此请求头可以按 UTF-8 解码，body 仍必须
     * 继续从同一个 BufferedInputStream 按字节读取，避免字符缓冲跨过 header/body 分界。
     */
    private fun readHttpLine(input: BufferedInputStream, maxBytes: Int): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val value = input.read()
            if (value < 0) {
                return if (line.size() == 0) null else line.toString(StandardCharsets.UTF_8.name())
            }
            if (value == '\n'.code) {
                val bytes = line.toByteArray()
                val contentLength = if (bytes.lastOrNull() == '\r'.code.toByte()) bytes.size - 1 else bytes.size
                return String(bytes, 0, contentLength, StandardCharsets.UTF_8)
            }
            line.write(value)
            if (line.size() > maxBytes) throw IllegalArgumentException("HTTP line too long")
        }
    }

    private fun parseParameters(query: String): Map<String, List<String>> {
        if (query.isBlank()) return emptyMap()
        val result = linkedMapOf<String, MutableList<String>>()
        query.split('&').forEach { item ->
            if (item.isBlank()) return@forEach
            val separator = item.indexOf('=')
            val rawKey = if (separator >= 0) item.substring(0, separator) else item
            val rawValue = if (separator >= 0) item.substring(separator + 1) else ""
            val key = URLDecoder.decode(rawKey, StandardCharsets.UTF_8.name())
            val value = URLDecoder.decode(rawValue, StandardCharsets.UTF_8.name())
            result.getOrPut(key) { mutableListOf() }.add(value)
        }
        return result
    }

    /** 保持原有路由代码的响应构造方式，统一输出 UTF-8 固定长度响应。 */
    private fun newFixedLengthResponse(status: Response.Status, mimeType: String, body: String): Response {
        return Response(status = status, mimeType = mimeType, body = body)
    }

    private fun serve(session: IHTTPSession, requestId: Long): Response {
        val startedAt = System.currentTimeMillis()
        val uri = session.uri
        val method = session.method
        Log.i(TAG, "HTTP request: $method $uri")
        return when {
            uri == "/health" && method == Method.GET -> handleHealth()
            BuildConfig.DEBUG && uri == "/debug/logs" && method == Method.GET -> handleDebugLogs(session)
            BuildConfig.DEBUG && uri == "/debug/logs/raw" && method == Method.GET -> handleDebugLogsRaw(session)
            BuildConfig.DEBUG && uri == "/debug/accessibility/capture" && method == Method.GET -> handleDebugAccessibilityCapture()
            uri == "/accessibility/touch-exploration" && method == Method.GET ->
                handleTouchExplorationState(requestId, startedAt)
            uri == "/accessibility/touch-exploration" && method == Method.POST ->
                handleTouchExploration(session, requestId, startedAt)
            BuildConfig.DEBUG && uri == "/debug/accessibility/touch-exploration" && method == Method.POST ->
                handleTouchExploration(session, requestId, startedAt)
            uri == "/tree" && method == Method.GET -> handleTreeRequest(session, requestId)
            uri == "/events" && method == Method.GET -> handleEvents(session)
            uri.startsWith("/node/") && method == Method.POST ->
                runTreeRequest(requestId, CompanionProtocolFailures.nodeActionUnsupported("执行失败")) {
                    handleNodeAction(uri, session, requestId)
                }
            else -> protocolError(
                Response.Status.NOT_FOUND,
                CompanionProtocolFailures.invalidRequest("不存在的接口或方法：$method $uri"),
                requestId,
                startedAt,
            )
        }
    }

    /** 节点树与 ref 操作共享熔断边界；health 和读屏控制不调用此方法。 */
    private fun runTreeRequest(
        requestId: Long,
        unexpectedFailure: CompanionProtocolError,
        timeoutMs: Long = TREE_CAPTURE_TIMEOUT_MS,
        block: () -> Response,
    ): Response {
        val startedAt = System.currentTimeMillis()
        return try {
            CompanionTreeCapture.coordinator.capture(timeoutMs, block)
        } catch (_: TreeCaptureBusyException) {
            Log.w(TAG, "Tree request rejected: id=$requestId, reason=busy")
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = 0L,
                error = "tree capture busy",
            )
            protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                CompanionProtocolFailures.treeCaptureBusy(),
                requestId,
                startedAt,
                timeoutMs,
                environment = refreshDeviceEnvironment(),
                recoveries = "none",
            )
        } catch (_: TreeCaptureTimeoutException) {
            Log.w(TAG, "Tree request timed out: id=$requestId, timeoutMs=$timeoutMs")
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = timeoutMs,
                error = "tree capture timeout",
            )
            protocolError(
                Response.Status.GATEWAY_TIMEOUT,
                CompanionProtocolFailures.treeCaptureTimeout(),
                requestId,
                startedAt,
                timeoutMs,
                environment = refreshDeviceEnvironment(),
                recoveries = "none",
            )
        } catch (exception: Exception) {
            Log.e(TAG, "Tree request failed: id=$requestId", exception)
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = 0L,
                error = exception.message ?: exception.javaClass.simpleName,
            )
            protocolError(
                Response.Status.INTERNAL_ERROR,
                unexpectedFailure,
                requestId,
                startedAt,
                timeoutMs,
            )
        }
    }

    /** 轻量健康检查不访问 AccessibilityNodeInfo，抓树阻塞时仍可独立响应。 */
    private fun handleHealth(): Response {
        // 锁屏与电池优化状态会随用户操作变化：每次 health 都重新读取一次真实值。
        refreshDeviceEnvironment()
        val payload = CompanionHealthPayload.from(CompanionRuntimeHealth.state.snapshot())
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json",
            mapToJsonValue(payload).toString(),
        )
    }

    /**
     * 用标准 API 读取设备环境并写入统一 health。
     * Service 未连接时返回 null 并保留上一次已知值，不伪造状态。
     */
    private fun refreshDeviceEnvironment(): CompanionDeviceEnvironment? {
        val context = CompanionAccessibilityService.instance?.applicationContext ?: return null
        val environment = CompanionDeviceEnvironmentReader.read(context)
        CompanionRuntimeHealth.state.setDeviceEnvironment(
            locked = environment.locked,
            batteryOptimizationIgnored = environment.batteryOptimizationIgnored,
        )
        return environment
    }

    /** 严格递归转换 health payload，并显式保留 nullable 必填字段。 */
    private fun mapToJsonValue(values: Map<String, Any?>): JSONObject {
        return JSONObject().apply {
            values.forEach { (key, value) ->
                put(
                    key,
                    when (value) {
                        null -> JSONObject.NULL
                        is Map<*, *> -> {
                            @Suppress("UNCHECKED_CAST")
                            mapToJsonValue(value as Map<String, Any?>)
                        }
                        else -> value
                    },
                )
            }
        }
    }

    /** 将纯协议 payload 写成 HTTP 响应；诊断数据只读取请求当时的真实 runtime health。 */
    private fun protocolError(
        status: Response.Status,
        error: CompanionProtocolError,
        requestId: Long,
        startedAt: Long,
        timeoutMs: Long = 0L,
        root: AccessibilityNodeInfo? = null,
        dump: NodeTreeDumper.DumpResult? = null,
        dumpElapsedMs: Long? = null,
        environment: CompanionDeviceEnvironment? = null,
        recoveries: String? = null,
    ): Response {
        // 失败时重新确认无障碍能力与读屏状态：只读系统状态，不重启任何组件。
        CompanionAccessibilityService.instance?.refreshHealthSnapshot()
        val health = CompanionRuntimeHealth.state.snapshot()
        val payload = companionErrorPayload(
            error,
            CompanionProtocolDiagnostics(
                requestId = requestId,
                elapsedMs = System.currentTimeMillis() - startedAt,
                timeoutMs = timeoutMs,
                serviceConnected = health.serviceConnected,
                httpListening = health.httpServer.listening,
                accessibilityCanRetrieveWindowContent = health.accessibility.canRetrieveWindowContent,
                accessibilityTouchExploration = health.accessibility.touchExploration,
                root = root?.let { rootDiagnostics(it) },
                visitedNodeCount = dump?.visitedNodeCount,
                childReadFailures = dump?.childReadFailures,
                interestingNodeCount = dump?.interestingNodeCount,
                visibleSemanticNodeCount = dump?.visibleSemanticNodeCount,
                truncated = dump?.truncated,
                dumpElapsedMs = dumpElapsedMs,
                deviceLocked = environment?.locked,
                batteryOptimizationIgnored = environment?.batteryOptimizationIgnored,
                recoveries = recoveries,
            ),
        )
        return newFixedLengthResponse(
            status,
            "application/json",
            mapToJsonValue(payload).toString(),
        )
    }

    /**
     * Debug 诊断接口：同时返回 fresh root、缓存 root、全部窗口和当前优化结果。
     * 该路由只在 Debug APK 中启用，避免生产接口暴露完整聊天文本与内部语义字段。
     */
    private fun handleDebugAccessibilityCapture(): Response {
        val service = CompanionAccessibilityService.instance ?: return error("服务未就绪")
        var freshActiveRoot: AccessibilityNodeInfo? = null
        var cachedRoot: AccessibilityNodeInfo? = null
        val windows = mutableListOf<CompanionAccessibilityService.DebugWindowRoot>()
        return try {
            freshActiveRoot = service.getFreshActiveRoot()
            cachedRoot = service.getCachedRootCopy()
            windows += service.getFreshWindowRoots()

            val result = JSONObject().apply {
                put("capturedAt", System.currentTimeMillis())
                put("serviceInfo", mapToJson(service.getDebugServiceState()))
                put("cachedRootAvailable", service.hasCachedRoot())
                put("activeRoot", dumpRootComparison(freshActiveRoot))
                put("cachedRoot", dumpRootComparison(cachedRoot))
                put("windows", windowsToJson(windows))
                put("events", eventsToJson(service.getDebugEvents()))
            }
            newFixedLengthResponse(Response.Status.OK, "application/json", result.toString())
        } catch (exception: Exception) {
            error("Debug capture 失败：${exception.message ?: exception.javaClass.simpleName}")
        } finally {
            freshActiveRoot?.recycle()
            cachedRoot?.recycle()
            windows.forEach { it.root?.recycle() }
        }
    }

    /** Debug：返回结构化日志，方便 AI 直接通过 adb forward + curl 读取。 */
    private fun handleDebugLogs(session: IHTTPSession): Response {
        val limit = debugLogLimit(session)
        val entries = Log.snapshot(limit)
        val result = JSONObject().apply {
            put("ok", true)
            put("capturedAt", System.currentTimeMillis())
            put("count", entries.size)
            put("limit", limit)
            put("logFile", Log.adbFilePath())
            put("adbCommand", "adb shell run-as com.agentkit.companion cat files/logs/lingxi.log")
            put(
                "entries",
                JSONArray().apply {
                    entries.forEach { entry ->
                        put(
                            JSONObject().apply {
                                put("timestamp", entry.timestamp)
                                put("level", entry.level)
                                put("tag", entry.tag)
                                put("message", entry.message)
                                put("formatted", entry.formatted)
                            },
                        )
                    }
                },
            )
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", result.toString(2))
    }

    /** Debug：返回纯文本日志，便于 curl、ADB 和主界面复制。 */
    private fun handleDebugLogsRaw(session: IHTTPSession): Response {
        val limit = debugLogLimit(session)
        val body = Log.formattedText(limit)
        return newFixedLengthResponse(Response.Status.OK, "text/plain", body)
    }

    /** 限制单次 Debug 日志读取量，避免日志窗口或 HTTP 响应无限增长。 */
    private fun debugLogLimit(session: IHTTPSession): Int {
        return session.parameters["limit"]?.firstOrNull()?.toIntOrNull()?.coerceIn(1, 300) ?: 300
    }

    /** Debug：按请求切换 Touch Exploration；是否保持开启由运行时策略决定，用户可双击退出。 */
    private fun handleTouchExploration(
        session: IHTTPSession,
        requestId: Long,
        startedAt: Long,
    ): Response {
        val service = CompanionAccessibilityService.instance ?: return protocolError(
            Response.Status.SERVICE_UNAVAILABLE,
            CompanionProtocolFailures.touchExplorationUnavailable(),
            requestId,
            startedAt,
        )
        val body = parseBody(session) ?: return protocolError(
            Response.Status.BAD_REQUEST,
            CompanionProtocolFailures.invalidRequest("请求体必须是 JSON"),
            requestId,
            startedAt,
        )
        if (!body.has("enabled")) return protocolError(
            Response.Status.BAD_REQUEST,
            CompanionProtocolFailures.invalidRequest("缺少 enabled 参数"),
            requestId,
            startedAt,
        )
        val enabled = body.opt("enabled")
        if (enabled !is Boolean) return protocolError(
            Response.Status.BAD_REQUEST,
            CompanionProtocolFailures.invalidRequest("enabled 必须是 boolean"),
            requestId,
            startedAt,
        )
        val state = service.setTouchExplorationRequested(enabled)
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json",
            JSONObject().apply {
                put("ok", true)
                put("serviceInfo", mapToJson(state))
            }.toString(),
        )
    }

    /** 返回 Touch Exploration 的真实运行时状态，供 BFF 确认请求是否生效。 */
    private fun handleTouchExplorationState(requestId: Long, startedAt: Long): Response {
        val service = CompanionAccessibilityService.instance ?: return protocolError(
            Response.Status.SERVICE_UNAVAILABLE,
            CompanionProtocolFailures.touchExplorationUnavailable(),
            requestId,
            startedAt,
        )
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json",
            JSONObject().apply {
                put("ok", true)
                put("serviceInfo", mapToJson(service.getDebugServiceState()))
            }.toString(),
        )
    }

    /** Debug：对同一个 root 输出 raw tree 与现有优化 tree，便于直接计算信息损失。 */
    private fun dumpRootComparison(root: AccessibilityNodeInfo?): JSONObject {
        if (root == null) return JSONObject().put("present", false)
        val raw = RawAccessibilityTreeDumper.dump(root)
        val optimized = NodeTreeDumper.dump(root)
        return JSONObject().apply {
            put("present", true)
            put("summary", nodeSummary(root))
            put("rawNodeCount", raw.nodes.length())
            put("rawTruncated", raw.truncated)
            put("rawNodes", raw.nodes)
            put("optimizedNodeCount", optimized.length())
            put("optimizedNodes", optimized)
            put("rawMetrics", nodeMetrics(raw.nodes))
            put("optimizedMetrics", nodeMetrics(optimized))
        }
    }

    /** Debug：窗口元信息与对应 root 必须在同一个响应中保存，避免窗口切换造成误判。 */
    private fun windowsToJson(windows: List<CompanionAccessibilityService.DebugWindowRoot>): JSONArray {
        return JSONArray().apply {
            windows.forEach { window ->
                put(
                    JSONObject().apply {
                        put("id", window.id)
                        put("type", window.type)
                        put("layer", window.layer)
                        put("title", window.title)
                        put("active", window.active)
                        put("focused", window.focused)
                        put("root", dumpRootComparison(window.root))
                    },
                )
            }
        }
    }

    /** Debug：只返回字段存在性和数量，不对 raw 节点正文做二次裁剪。 */
    private fun nodeMetrics(nodes: JSONArray): JSONObject {
        val textFields = listOf(
            "text",
            "contentDescription",
            "hintText",
            "stateDescription",
            "tooltipText",
        )
        val result = JSONObject()
        textFields.forEach { field ->
            var count = 0
            for (index in 0 until nodes.length()) {
                if (nodes.optJSONObject(index)?.optString(field).orEmpty().isNotBlank()) count++
            }
            result.put(field, count)
        }
        listOf(
            "clickable",
            "longClickable",
            "focusable",
            "focused",
            "accessibilityFocused",
            "editable",
            "checkable",
            "checked",
            "selected",
            "enabled",
            "visibleToUser",
        ).forEach { field ->
            var count = 0
            for (index in 0 until nodes.length()) {
                if (nodes.optJSONObject(index)?.optBoolean(field, false) == true) count++
            }
            result.put(field, count)
        }
        return result
    }

    /** Debug：输出 root 摘要，帮助判断是否读取到了微信窗口。 */
    private fun nodeSummary(node: AccessibilityNodeInfo): JSONObject {
        return JSONObject().apply {
            put("windowId", node.windowId)
            put("packageName", node.packageName?.toString() ?: "")
            put("className", node.className?.toString() ?: "")
            put("viewId", node.viewIdResourceName ?: "")
            put("childCount", node.childCount)
            put("visibleToUser", node.isVisibleToUser)
        }
    }

    /** Debug：将服务状态 Map 转为 JSON，避免依赖 JSONObject 对 Map 泛型的隐式转换。 */
    private fun mapToJson(values: Map<String, Any>): JSONObject {
        return JSONObject().apply {
            values.forEach { (key, value) -> put(key, value) }
        }
    }

    /** Debug：将安全的事件摘要转为 JSON，不把 AccessibilityEvent 原对象暴露给 HTTP 层。 */
    private fun eventsToJson(events: List<CompanionAccessibilityService.DebugEvent>): JSONArray {
        return JSONArray().apply {
            events.forEach { event ->
                put(
                    JSONObject().apply {
                        put("type", event.type)
                        put("time", event.time)
                        put("packageName", event.packageName)
                        put("className", event.className)
                        put("windowId", event.windowId)
                        put("contentChangeTypes", event.contentChangeTypes)
                        put("action", event.action)
                        put("text", event.text)
                    },
                )
            }
        }
    }

    /** 解析 Touch 状态、抓树等级和目标包名；旧客户端的 mode=enhanced 映射到 deep。 */
    private fun handleTreeRequest(session: IHTTPSession, requestId: Long): Response {
        val startedAt = System.currentTimeMillis()
        val targetPackage = session.parameters["packageName"]?.firstOrNull()?.takeIf { it.isNotBlank() }
        val legacyMode = try {
            session.parameters["mode"]?.firstOrNull()?.let(CompanionCaptureMode::fromWire)
        } catch (exception: IllegalArgumentException) {
            return protocolError(
                Response.Status.BAD_REQUEST,
                CompanionProtocolFailures.invalidRequest(exception.message ?: "抓取模式无效"),
                requestId,
                startedAt,
            )
        }
        val requestedCaptureLevel = session.parameters["level"]?.firstOrNull()
        val captureLevel = try {
            if (requestedCaptureLevel == null) {
                legacyMode?.legacyCaptureLevel ?: CompanionCaptureLevel.FAST
            } else {
                CompanionCaptureLevel.fromWire(requestedCaptureLevel)
            }
        } catch (exception: IllegalArgumentException) {
            return protocolError(
                Response.Status.BAD_REQUEST,
                CompanionProtocolFailures.invalidRequest(exception.message ?: "抓取等级无效"),
                requestId,
                startedAt,
            )
        }
        val service = CompanionAccessibilityService.instance
        val mode = legacyMode ?: if (service?.isTouchExplorationEnabled() == true) {
            CompanionCaptureMode.ENHANCED
        } else {
            CompanionCaptureMode.NORMAL
        }
        if (legacyMode == CompanionCaptureMode.ENHANCED && service != null && !service.isTouchExplorationEnabled()) {
            return protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                CompanionProtocolFailures.touchExplorationUnavailable(),
                requestId,
                startedAt,
                TREE_CAPTURE_TIMEOUT_MS,
            )
        }

        // fast 只查询现成缓存，不等待预热；deep 必须执行有界主动重探，不能被旧缓存短路。
        val prepared = if (captureLevel == CompanionCaptureLevel.FAST) {
            service?.awaitPreparedTreeObservation(
                targetPackage = targetPackage,
                mode = mode,
                waitMs = 0L,
            )
        } else {
            null
        }
        val environment = if (service != null) refreshDeviceEnvironment() else null
        val lockedFailure = environment?.let { deviceLockedFailureOrNull(it) }
        if (lockedFailure != null) {
            Log.w(TAG, "Accessibility tree handling aborted: id=$requestId, reason=device_locked")
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - startedAt,
                error = "device locked",
            )
            return protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                lockedFailure,
                requestId,
                startedAt,
                TREE_CAPTURE_TIMEOUT_MS,
                environment = environment,
                recoveries = recoverySummary(),
            )
        }
        return runTreeRequest(
            requestId = requestId,
            unexpectedFailure = CompanionProtocolFailures.treeDumpFailed(),
            timeoutMs = captureLevel.requestTimeoutMs,
        ) {
            val currentPrepared = prepared?.takeIf {
                service?.isPreparedTreeObservationCurrent(it, targetPackage, mode) == true
            }
            if (currentPrepared != null) {
                val cachedResponse = try {
                    val result = currentPrepared.payload.toJson("companion:${System.currentTimeMillis()}")
                    CompanionRuntimeHealth.state.recordTreeSuccess(
                        at = System.currentTimeMillis(),
                        durationMs = System.currentTimeMillis() - startedAt,
                        nodeCount = currentPrepared.nodeCount,
                    )
                    Log.i(
                        TAG,
                        "Serving prepared tree: id=$requestId, package=${currentPrepared.payload.packageName}, " +
                            "eventSequence=${currentPrepared.eventSequence}, nodeCount=${currentPrepared.nodeCount}, " +
                            "elapsedMs=${System.currentTimeMillis() - startedAt}",
                    )
                    newFixedLengthResponse(Response.Status.OK, "application/json", result.toString(2))
                } catch (exception: Exception) {
                    Log.w(TAG, "Prepared tree serialization failed: id=$requestId", exception)
                    null
                }
                if (cachedResponse != null) return@runTreeRequest cachedResponse
            }
            handleTree(requestId, targetPackage, mode, captureLevel, environment)
        }
    }

    private fun handleTree(
        requestId: Long,
        targetPackage: String?,
        mode: CompanionCaptureMode,
        captureLevel: CompanionCaptureLevel,
        precheckedEnvironment: CompanionDeviceEnvironment?,
    ): Response {
        val startedAt = System.currentTimeMillis()
        Log.i(
            TAG,
            "Accessibility tree handling started: id=$requestId, mode=${mode.wireValue}, " +
                "level=${captureLevel.wireValue}, " +
                "targetPackage=${targetPackage ?: "(none)"}",
        )
        val service = CompanionAccessibilityService.instance
        if (service == null) {
            Log.w(TAG, "Accessibility tree handling aborted: id=$requestId, reason=service_not_ready")
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - startedAt,
                error = "accessibility service not ready",
            )
            return protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                CompanionProtocolFailures.accessibilityServiceUnavailable(),
                requestId,
                startedAt,
                captureLevel.requestTimeoutMs,
            )
        }

        // 锁屏是无障碍不可用的确定性原因：直接失败，不重试、不重启 Service、不重建 Touch Exploration。
        val environment = precheckedEnvironment ?: refreshDeviceEnvironment()
        val lockedFailure = environment?.let { deviceLockedFailureOrNull(it) }
        if (lockedFailure != null) {
            Log.w(TAG, "Accessibility tree handling aborted: id=$requestId, reason=device_locked")
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - startedAt,
                error = "device locked",
            )
            return protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                lockedFailure,
                requestId,
                startedAt,
                captureLevel.requestTimeoutMs,
                environment = environment,
                recoveries = recoverySummary(),
            )
        }

        Log.i(TAG, "Accessibility tree root acquisition started: id=$requestId")
        // 当前快照禁止使用旧缓存；节点操作仍保留原有兼容行为，由调用方校验快照上下文。
        var root = service.getRootCopy(
            preferredPackage = targetPackage,
            mode = mode,
            captureLevel = captureLevel,
            allowCachedFallback = false,
        )
        if (root == null) {
            Log.w(
                TAG,
                "Accessibility tree root acquisition returned null: id=$requestId, elapsedMs=${System.currentTimeMillis() - startedAt}",
            )
            CompanionRuntimeHealth.state.recordTreeFailure(
                at = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - startedAt,
                error = "root unavailable",
            )
            return protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                CompanionProtocolFailures.treeRootUnavailable(),
                requestId,
                startedAt,
                captureLevel.requestTimeoutMs,
                environment = environment,
                recoveries = recoverySummary(rootAttempts = captureLevel.rootCaptureAttempts),
            )
        }
        Log.i(
            TAG,
            "Accessibility tree root acquired: id=$requestId, elapsedMs=${System.currentTimeMillis() - startedAt}, " +
                "package=${root.packageName}, class=${root.className}, childCount=${root.childCount}, " +
                "visible=${root.isVisibleToUser}, windowId=${root.windowId}",
        )

        try {
            if (!service.hasRootContent(root)) {
                Log.w(
                    TAG,
                    "Accessibility tree root is empty: id=$requestId, package=${root.packageName}, " +
                        "class=${root.className}, childCount=${root.childCount}, " +
                        "visible=${root.isVisibleToUser}, windowId=${root.windowId}",
                )
                CompanionRuntimeHealth.state.recordTreeFailure(
                    at = System.currentTimeMillis(),
                    durationMs = System.currentTimeMillis() - startedAt,
                    error = "root empty: package=${root.packageName}, childCount=${root.childCount}, " +
                        "visible=${root.isVisibleToUser}, windowId=${root.windowId}",
                )
                return protocolError(
                    Response.Status.SERVICE_UNAVAILABLE,
                    CompanionProtocolFailures.treeRootEmpty(),
                    requestId,
                    startedAt,
                    captureLevel.requestTimeoutMs,
                    root,
                    environment = environment,
                    recoveries = recoverySummary(rootAttempts = captureLevel.rootCaptureAttempts),
                )
            }

            // root 有 childCount 但 getChild 失败时，短暂重抓 root 可能恢复；每次都记录完整
            // 遍历统计，最终失败时让 BFF/LLM 知道是 provider 读取失败还是语义过滤为空。
            var dumpResult: NodeTreeDumper.DumpResult? = null
            var dumpElapsedMs = 0L
            for (dumpAttempt in 1..captureLevel.dumpRetryAttempts) {
                val currentRoot = root ?: break
                val dumpStartedAt = System.currentTimeMillis()
                dumpResult = NodeTreeDumper.dumpWithDiagnostics(currentRoot)
                dumpElapsedMs = System.currentTimeMillis() - dumpStartedAt
                Log.i(
                    TAG,
                    "Accessibility tree dumped: id=$requestId, attempt=$dumpAttempt, " +
                        "nodeCount=${dumpResult.nodes.length()}, visitedNodeCount=${dumpResult.visitedNodeCount}, " +
                        "childReadFailures=${dumpResult.childReadFailures}, " +
                        "interestingNodeCount=${dumpResult.interestingNodeCount}, " +
                        "visibleSemanticNodeCount=${dumpResult.visibleSemanticNodeCount}, " +
                        "truncated=${dumpResult.truncated}, dumpElapsedMs=$dumpElapsedMs",
                )
                val dumpReady = dumpResult.nodes.length() > 0 &&
                    (!(mode.requiresVisibleSemanticNodes || captureLevel.requiresVisibleSemanticNodes) ||
                        dumpResult.visibleSemanticNodeCount > 0)
                if (dumpReady || dumpAttempt == captureLevel.dumpRetryAttempts) break

                currentRoot.recycle()
                root = null
                try {
                    Thread.sleep(captureLevel.dumpRetryDelayMs)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
                root = service.getRootCopy(
                    preferredPackage = targetPackage,
                    mode = mode,
                    captureLevel = captureLevel,
                    allowCachedFallback = false,
                )
                if (root == null || !service.hasRootContent(root)) break
            }

            val finalRoot = root ?: return protocolError(
                Response.Status.SERVICE_UNAVAILABLE,
                CompanionProtocolFailures.treeRootUnavailable(),
                requestId,
                startedAt,
                captureLevel.requestTimeoutMs,
                environment = environment,
                recoveries = recoverySummary(rootAttempts = captureLevel.rootCaptureAttempts),
            )
            if (!service.hasRootContent(finalRoot)) {
                return protocolError(
                    Response.Status.SERVICE_UNAVAILABLE,
                    CompanionProtocolFailures.treeRootEmpty(),
                    requestId,
                    startedAt,
                    captureLevel.requestTimeoutMs,
                    finalRoot,
                    environment = environment,
                    recoveries = recoverySummary(rootAttempts = captureLevel.rootCaptureAttempts),
                )
            }
            val finalDump = dumpResult ?: NodeTreeDumper.dumpWithDiagnostics(finalRoot)
            val nodes = finalDump.nodes
            val (screenWidth, screenHeight) = service.getScreenSize()
            val dumpHasNoUsableNodes = nodes.length() == 0 ||
                ((mode.requiresVisibleSemanticNodes || captureLevel.requiresVisibleSemanticNodes) &&
                    finalDump.visibleSemanticNodeCount == 0)
            if (dumpHasNoUsableNodes) {
                Log.w(
                    TAG,
                    "Accessibility tree is empty: id=$requestId, package=${finalRoot.packageName}, " +
                        "class=${finalRoot.className}, childCount=${finalRoot.childCount}, " +
                        "visible=${finalRoot.isVisibleToUser}, windowId=${finalRoot.windowId}, " +
                        "visitedNodeCount=${finalDump.visitedNodeCount}, childReadFailures=${finalDump.childReadFailures}, " +
                        "interestingNodeCount=${finalDump.interestingNodeCount}, truncated=${finalDump.truncated}, " +
                        "visibleSemanticNodeCount=${finalDump.visibleSemanticNodeCount}, " +
                        "dumpElapsedMs=$dumpElapsedMs",
                )
                CompanionRuntimeHealth.state.recordTreeFailure(
                    at = System.currentTimeMillis(),
                    durationMs = System.currentTimeMillis() - startedAt,
                    error = "tree dump empty: package=${finalRoot.packageName}, childCount=${finalRoot.childCount}, " +
                        "visitedNodeCount=${finalDump.visitedNodeCount}, childReadFailures=${finalDump.childReadFailures}, " +
                        "interestingNodeCount=${finalDump.interestingNodeCount}, " +
                        "visibleSemanticNodeCount=${finalDump.visibleSemanticNodeCount}, truncated=${finalDump.truncated}",
                )
                return protocolError(
                    Response.Status.SERVICE_UNAVAILABLE,
                    CompanionProtocolFailures.treeDumpEmpty(),
                    requestId,
                    startedAt,
                    captureLevel.requestTimeoutMs,
                    finalRoot,
                    finalDump,
                    dumpElapsedMs,
                    environment = environment,
                    recoveries = recoverySummary(
                        rootAttempts = captureLevel.rootCaptureAttempts,
                        dumpAttempts = captureLevel.dumpRetryAttempts,
                    ),
                )
            }
            service.rememberSuccessfulRoot(finalRoot)
            val result = JSONObject().apply {
                put("snapshotId", "companion:${System.currentTimeMillis()}")
                put("packageName", finalRoot.packageName?.toString() ?: "")
                put("screenWidth", screenWidth)
                put("screenHeight", screenHeight)
                put("nodes", nodes)
                put("accessibilityMode", service.getDebugServiceState()["accessibilityMode"] ?: "normal")
                put(
                    "root",
                    JSONObject().apply {
                        put("windowId", finalRoot.windowId)
                        put("packageName", finalRoot.packageName?.toString() ?: "")
                        put("className", finalRoot.className?.toString() ?: "")
                        put("childCount", finalRoot.childCount)
                        put("visibleToUser", finalRoot.isVisibleToUser)
                    },
                )
            }
            CompanionRuntimeHealth.state.recordTreeSuccess(
                at = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - startedAt,
                nodeCount = nodes.length(),
            )
            Log.i(
                TAG,
                "Accessibility tree response ready: id=$requestId, nodeCount=${nodes.length()}, " +
                    "totalElapsedMs=${System.currentTimeMillis() - startedAt}",
            )
            return newFixedLengthResponse(Response.Status.OK, "application/json", result.toString(2))
        } finally {
            root?.recycle()
        }
    }

    private fun handleEvents(session: IHTTPSession): Response {
        val service = CompanionAccessibilityService.instance ?: return error("服务未就绪")
        val since = session.parameters["since"]?.firstOrNull()?.toLongOrNull() ?: 0L
        val events = service.getEventsSince(since)
        val arr = JSONArray()
        events.forEach { event ->
            val obj = JSONObject().apply {
                put("type", event.eventType)
                put("time", event.eventTime)
                put("packageName", event.packageName?.toString() ?: "")
                put("text", event.text?.toString() ?: "")
                put("sourceNodeId", event.source?.let { getNodeId(it) } ?: "")
            }
            arr.put(obj)
            event.recycle()
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", arr.toString())
    }

    private fun handleNodeAction(uri: String, session: IHTTPSession, requestId: Long): Response {
        val startedAt = System.currentTimeMillis()
        // 解析 /node/{ref}/{action}
        val parts = uri.trim('/').split('/')
        if (parts.size < 3) return protocolError(
            Response.Status.BAD_REQUEST,
            CompanionProtocolFailures.invalidRequest("节点操作路径格式错误"),
            requestId,
            startedAt,
            TREE_CAPTURE_TIMEOUT_MS,
        )
        val ref = parts[1].toIntOrNull() ?: return protocolError(
            Response.Status.BAD_REQUEST,
            CompanionProtocolFailures.invalidRequest("节点 ref 必须是整数"),
            requestId,
            startedAt,
            TREE_CAPTURE_TIMEOUT_MS,
        )
        val action = parts[2]
        val body = parseBody(session)

        val service = CompanionAccessibilityService.instance ?: return protocolError(
            Response.Status.SERVICE_UNAVAILABLE,
            CompanionProtocolFailures.accessibilityServiceUnavailable(),
            requestId,
            startedAt,
            TREE_CAPTURE_TIMEOUT_MS,
        )
        val root = service.getRootCopy() ?: return protocolError(
            Response.Status.SERVICE_UNAVAILABLE,
            CompanionProtocolFailures.treeRootUnavailable(),
            requestId,
            startedAt,
            TREE_CAPTURE_TIMEOUT_MS,
        )
        try {
            val node = findNodeByRef(root, ref) ?: return protocolError(
                Response.Status.BAD_REQUEST,
                CompanionProtocolFailures.nodeRefStale(ref),
                requestId,
                startedAt,
                TREE_CAPTURE_TIMEOUT_MS,
            )
            return when (action) {
                "click" -> {
                    if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) ok("已点击")
                    else protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.nodeActionUnsupported(action),
                        requestId,
                        startedAt,
                        TREE_CAPTURE_TIMEOUT_MS,
                    )
                }
                "text" -> {
                    val text = body?.opt("text") as? String ?: return protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.invalidRequest("缺少 text 参数"),
                        requestId,
                        startedAt,
                        TREE_CAPTURE_TIMEOUT_MS,
                    )
                    // 先点击聚焦输入框：ACTION_SET_TEXT 需要输入框真实持焦才生效，
                    // 仅 ACTION_FOCUS 未必激活，导致「已设置文本」但内容未写入。
                    node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    try { Thread.sleep(150) } catch (_: Exception) {}
                    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    // Android 无障碍服务的 ACTION_SET_TEXT 直接支持 Unicode
                    val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
                    if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) ok("已设置文本")
                    else protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.nodeActionUnsupported(action),
                        requestId,
                        startedAt,
                        TREE_CAPTURE_TIMEOUT_MS,
                    )
                }
                "scroll" -> {
                    val direction = body?.opt("direction") as? String ?: "forward"
                    val action = if (direction == "backward") AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                    if (node.performAction(action)) ok("已滚动 $direction")
                    else protocolError(
                        Response.Status.BAD_REQUEST,
                        CompanionProtocolFailures.nodeActionUnsupported("scroll"),
                        requestId,
                        startedAt,
                        TREE_CAPTURE_TIMEOUT_MS,
                    )
                }
                else -> protocolError(
                    Response.Status.BAD_REQUEST,
                    CompanionProtocolFailures.invalidRequest("未知节点操作：$action"),
                    requestId,
                    startedAt,
                    TREE_CAPTURE_TIMEOUT_MS,
                )
            }
        } finally {
            root.recycle()
        }
    }

    private fun findNodeByRef(node: AccessibilityNodeInfo, targetRef: Int, currentRef: IntArray = intArrayOf(-1)): AccessibilityNodeInfo? {
        // 与 NodeTreeDumper 保持一致：先记录当前节点（若 interesting），再无条件遍历子节点。
        // ref 从 0 开始，isInteresting 用与快照端相同的 accessibilityNodeInteresting，保证 ref 编号一致。
        if (accessibilityNodeInteresting(node)) {
            currentRef[0]++
            if (currentRef[0] == targetRef) return node
        }
        if (currentRef[0] >= 500) return null
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                val found = findNodeByRef(child, targetRef, currentRef)
                if (found != null) return found
                child.recycle()
            }
        }
        return null
    }

    private fun getNodeId(node: AccessibilityNodeInfo): String {
        return node.viewIdResourceName ?: node.className?.toString() ?: "unknown"
    }

    private fun parseBody(session: IHTTPSession): JSONObject? {
        return try {
            val body = HashMap<String, String>()
            session.parseBody(body)
            body["postData"]?.let { JSONObject(it) }
        } catch (_: Exception) { null }
    }

    /** 将实际抓到的 root 转成无业务正文的诊断摘要。 */
    private fun rootDiagnostics(root: AccessibilityNodeInfo): CompanionRootDiagnostics {
        return CompanionRootDiagnostics(
            windowId = root.windowId,
            packageName = root.packageName?.toString() ?: "",
            className = root.className?.toString() ?: "",
            childCount = root.childCount,
            visibleToUser = root.isVisibleToUser,
        )
    }

    private fun error(msg: String) = newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json",
        JSONObject().apply { put("ok", false); put("message", msg) }.toString())
    private fun ok(msg: String) = newFixedLengthResponse(Response.Status.OK, "application/json",
        JSONObject().apply { put("ok", true); put("message", msg) }.toString())
}
