package com.agentkit.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.OutputStreamWriter
import java.net.ServerSocket
import kotlin.concurrent.thread

class CompanionHttpServerTest {
    @Test
    fun `本地健康请求可以验证监听器真实可访问`() {
        val server = ServerSocket(0)
        val responder = thread(start = true) {
            server.accept().use { client ->
                OutputStreamWriter(client.getOutputStream()).use { output ->
                    output.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    output.flush()
                }
            }
        }
        try {
            assertTrue(LoopbackHealthProbe.isResponsive(server.localPort, timeoutMs = 1_000))
        } finally {
            server.close()
            responder.join(1_000L)
        }

        assertFalse(LoopbackHealthProbe.isResponsive(server.localPort, timeoutMs = 100))
    }
}
