package com.agentkit.companion

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.StandardCharsets

/** 通过实际 HTTP 往返确认固定 IPv4 loopback 监听器可用。 */
object LoopbackHealthProbe {
    fun isResponsive(port: Int, timeoutMs: Int): Boolean {
        if (port <= 0) return false
        val timeout = timeoutMs.coerceAtLeast(1)
        return try {
            Socket().use { client ->
                client.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), timeout)
                client.soTimeout = timeout
                // 不能关闭 SocketOutputStream；关闭任一 socket 流会同时关闭输入流，导致读不到响应。
                val output = client.getOutputStream()
                output.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
                output.flush()
                readHttpLine(BufferedInputStream(client.getInputStream()), 128) == "HTTP/1.1 200 OK"
            }
        } catch (_: Exception) {
            false
        }
    }

    /** Probe 只需解析状态行，保持独立于 Companion HTTP 路由实现。 */
    private fun readHttpLine(input: BufferedInputStream, maxBytes: Int): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val value = input.read()
            if (value < 0) return if (line.size() == 0) null else line.toString(StandardCharsets.UTF_8.name())
            if (value == '\n'.code) {
                val bytes = line.toByteArray()
                val size = if (bytes.lastOrNull() == '\r'.code.toByte()) bytes.size - 1 else bytes.size
                return String(bytes, 0, size, StandardCharsets.UTF_8)
            }
            line.write(value)
            if (line.size() > maxBytes) return null
        }
    }
}
