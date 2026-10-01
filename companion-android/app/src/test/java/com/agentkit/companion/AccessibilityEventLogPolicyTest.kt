package com.agentkit.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessibilityEventLogPolicyTest {
    @Test
    fun systemUiEventsAreNotWrittenToTheVisibleLog() {
        val policy = AccessibilityEventLogPolicy()

        assertFalse(policy.shouldLog("com.android.systemui", "event-1", 1_000L))
    }

    @Test
    fun nonNoisyEventsAreAggregatedWithinTheMinimumInterval() {
        val policy = AccessibilityEventLogPolicy()

        assertTrue(policy.shouldLog("com.tencent.mm", "event-1", 1_000L))
        assertFalse(policy.shouldLog("com.tencent.mm", "event-1", 2_000L))
        assertTrue(policy.shouldLog("com.tencent.mm", "event-1", 6_000L))
    }

    @Test
    fun aDifferentNonNoisyEventIsLoggedImmediately() {
        val policy = AccessibilityEventLogPolicy()

        assertTrue(policy.shouldLog("com.tencent.mm", "event-1", 1_000L))
        assertTrue(policy.shouldLog("com.tencent.mm", "event-2", 1_001L))
    }
}
