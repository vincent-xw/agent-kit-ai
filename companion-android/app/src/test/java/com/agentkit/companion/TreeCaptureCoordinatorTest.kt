package com.agentkit.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class TreeCaptureCoordinatorTest {
    @Test
    fun `已有抓树任务时第二次请求快速失败`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val coordinator = TreeCaptureCoordinator(
            CompanionHealthState(processStartedAt = 100L, appVersion = "test-version"),
        )
        val worker = thread {
            coordinator.capture(2_000) {
                entered.countDown()
                release.await()
                "first"
            }
        }

        assertTrue(entered.await(500, TimeUnit.MILLISECONDS))
        assertThrows(TreeCaptureBusyException::class.java) {
            coordinator.capture(50) { "second" }
        }

        release.countDown()
        worker.join(500)
        coordinator.close()
        assertFalse(worker.isAlive)
    }

    @Test
    fun `超时任务真正退出前保持卡住状态`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val health = CompanionHealthState(processStartedAt = 100L, appVersion = "test-version")
        val coordinator = TreeCaptureCoordinator(health)

        assertThrows(TreeCaptureTimeoutException::class.java) {
            coordinator.capture(20) {
                entered.countDown()
                awaitIgnoringInterrupt(release)
                "late"
            }
        }
        assertTrue(entered.await(500, TimeUnit.MILLISECONDS))
        assertTrue(health.snapshot().treeCapture.busy)
        assertTrue(health.snapshot().treeCapture.stuck)

        release.countDown()
        assertTrue(waitUntil(500) { !health.snapshot().treeCapture.busy })
        assertFalse(health.snapshot().treeCapture.stuck)
        coordinator.close()
    }

    /** 模拟不响应 Future.cancel(true) 的 Binder 调用，直到测试主动释放。 */
    private fun awaitIgnoringInterrupt(latch: CountDownLatch) {
        while (latch.count > 0L) {
            try {
                latch.await(10, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                // Binder 卡住时可能忽略线程中断，测试必须覆盖该行为。
            }
        }
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            if (condition()) return true
            Thread.sleep(5)
        }
        return condition()
    }
}
