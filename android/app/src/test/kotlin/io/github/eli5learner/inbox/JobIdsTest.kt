package io.github.eli5learner.inbox

import io.github.eli5learner.sync.protocol.Patterns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Job ids are UUIDv7 (16 §4.2) and match the shared pattern. */
class JobIdsTest {
    @Test fun `ids are version 7, carry the time and sort by it`() {
        val id = JobIds.of(0x0190_1234_5678L, ByteArray(16) { 0xFF.toByte() })
        assertEquals("01901234-5678-7fff-bfff-ffffffffffff", id)
        repeat(100) { assertTrue(Patterns.JOB_ID.matches(JobIds.new())) }
        val a = JobIds.new(1_800_000_000_000L)
        val b = JobIds.new(1_800_000_000_001L)
        assertTrue(a < b)
    }
}
