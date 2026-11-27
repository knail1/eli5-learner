package io.github.eli5learner.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Version checks against the Mac's device file (16 §4.3, §5.1): leading major.minor.patch only. */
class AppVersionsTest {
    @Test fun `numbers compare as numbers, not as text`() {
        assertTrue(AppVersions.atLeast("0.6.0", "0.6.0"))
        assertTrue(AppVersions.atLeast("0.6.1", "0.6.0"))
        assertTrue(AppVersions.atLeast("0.10.0", "0.6.0"))
        assertTrue(AppVersions.atLeast("1.0.0", "0.6.0"))
        assertFalse(AppVersions.atLeast("0.5.9", "0.6.0"))
        assertFalse(AppVersions.atLeast("0.5.0", "0.6.0"))
        assertFalse(AppVersions.atLeast("0.0.0", "0.6.0"))
    }

    @Test fun `a suffix is ignored, anything unparsable is too old`() {
        assertTrue(AppVersions.atLeast("0.6.0-beta.1", "0.6.0"))
        assertTrue(AppVersions.atLeast("0.6.0+build.7", "0.6.0"))
        assertTrue(AppVersions.atLeast(" 0.6.0 ", "0.6.0"))
        assertFalse(AppVersions.atLeast("0.5.0-rc.9", "0.6.0"))
        for (bad in listOf(null, "", "0", "0.6", "v0.6.0", "0.6.x", "99999999999.0.0", "dev")) {
            assertFalse("$bad", AppVersions.atLeast(bad, "0.6.0"))
        }
        assertFalse(AppVersions.atLeast("1.0.0", "not a version"))
        assertEquals(listOf(0, 10, 2), AppVersions.parse("0.10.2-x"))
        assertNull(AppVersions.parse("0"))
    }

    @Test fun `the Deadpan gate is 0_6_0`() {
        assertEquals("0.6.0", AppVersions.DEADPAN_MIN_MAC)
        assertTrue(AppVersions.macTakesDeadpan("0.6.0"))
        assertFalse(AppVersions.macTakesDeadpan("0.5.0"))
        assertFalse(AppVersions.macTakesDeadpan(null))
    }
}
