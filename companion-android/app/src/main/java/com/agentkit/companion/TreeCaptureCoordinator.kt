package com.agentkit.companion

import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

class TreeCaptureBusyException : IllegalStateException("tree capture busy")

class TreeCaptureTimeoutException : IllegalStateException("tree capture timeout")

/**
 * 串行化所有需要访问 AccessibilityNodeInfo 树的工作。
 *
 * Binder 调用可能不响应线程中断。超时只让 HTTP 调用方及时返回，busy/stuck 必须保持到
 * 执行线程真正离开 block，避免后续请求继续堆积到同一个已卡住的无障碍通道。
 */
class TreeCaptureCoordinator(
    private val health: CompanionHealthState,
) : AutoCloseable {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "Lingxi Tree Capture").apply { isDaemon = true }
    }
    private val busy = AtomicBoolean(false)

    fun <T> capture(timeoutMs: Long, block: () -> T): T {
        if (!busy.compareAndSet(false, true)) throw TreeCaptureBusyException()
        health.setTreeExecution(busy = true, stuck = false)
        val started = AtomicBoolean(false)
        val future = executor.submit(Callable {
            started.set(true)
            try {
                block()
            } finally {
                clearExecutionState()
            }
        })

        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            health.setTreeExecution(busy = true, stuck = true)
            future.cancel(true)
            // 任务尚未进入 Callable 时不会执行内部 finally，调用线程负责解除占用。
            if (!started.get()) clearExecutionState()
            throw TreeCaptureTimeoutException()
        } catch (exception: InterruptedException) {
            health.setTreeExecution(busy = true, stuck = true)
            future.cancel(true)
            if (!started.get()) clearExecutionState()
            Thread.currentThread().interrupt()
            throw exception
        } catch (exception: ExecutionException) {
            val cause = exception.cause
            when (cause) {
                is RuntimeException -> throw cause
                is Error -> throw cause
                else -> throw IllegalStateException("tree capture failed", cause)
            }
        }
    }

    private fun clearExecutionState() {
        busy.set(false)
        health.setTreeExecution(busy = false, stuck = false)
    }

    override fun close() {
        executor.shutdownNow()
        clearExecutionState()
    }
}

/** HTTP listener 重建时仍复用同一执行器，不能绕过已经卡住的 Binder 抓树。 */
object CompanionTreeCapture {
    val coordinator = TreeCaptureCoordinator(CompanionRuntimeHealth.state)
}
