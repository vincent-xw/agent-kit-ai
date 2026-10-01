package com.agentkit.companion

import org.junit.After
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket

class HttpServerHolderTest {
    @After
    fun tearDown() {
        HttpServerHolder.stop()
    }

    @Test
    fun `首次监听失败并释放端口后后台会自动恢复`() {
        val blocker = ServerSocket()
        blocker.reuseAddress = true
        blocker.bind(InetSocketAddress("127.0.0.1", 7777))
        try {
            assertThrows(Exception::class.java) { HttpServerHolder.start() }
        } finally {
            blocker.close()
        }

        // 端口释放后等待真实监听状态恢复，验证失败分支没有让后台重试线程永久退出。
        assertTrue(waitUntil(4_000L) { HttpServerHolder.isServerAlive() })
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            if (condition()) return true
            Thread.sleep(20L)
        }
        return condition()
    }
}
