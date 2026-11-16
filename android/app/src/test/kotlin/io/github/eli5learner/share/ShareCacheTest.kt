package io.github.eli5learner.share

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Share copies under cacheDir/share (16 §6.5). */
class ShareCacheTest {
    @get:Rule val tmp = TemporaryFolder()

    private val day = ShareCache.MAX_AGE_MS

    @Test fun `stage writes the bytes into its own folder and leaves no temp file`() {
        val root = File(tmp.root, "share")
        val cache = ShareCache(root)
        val bytes = "<html>hi</html>".toByteArray()
        val f = cache.stage(bytes, "Doc.html")
        assertArrayEquals(bytes, f.readBytes())
        assertEquals("Doc.html", f.name)
        assertEquals(root.canonicalFile, f.parentFile!!.parentFile!!.canonicalFile)
        assertEquals(listOf("Doc.html"), f.parentFile!!.list()!!.toList())
    }

    @Test fun `two copies with the same name do not clash`() {
        val cache = ShareCache(File(tmp.root, "share"))
        val a = cache.stage("a".toByteArray(), "Same.html")
        val b = cache.stage("b".toByteArray(), "Same.html")
        assertNotEquals(a, b)
        assertEquals("a", a.readText())
        assertEquals("b", b.readText())
    }

    @Test fun `stage rejects names with path parts`() {
        val cache = ShareCache(File(tmp.root, "share"))
        for (bad in listOf("../x.html", "a/b.html", "", "..")) {
            val thrown = runCatching { cache.stage(byteArrayOf(1), bad) }.exceptionOrNull()
            assertTrue("for '$bad': $thrown", thrown is IllegalArgumentException)
        }
        assertFalse(File(tmp.root, "x.html").exists())
    }

    @Test fun `cleanup removes copies older than a day and keeps fresh ones and siblings`() {
        val root = File(tmp.root, "share")
        var now = 10 * day
        val cache = ShareCache(root) { now }
        val old = cache.stage("old".toByteArray(), "Old.html")
        val fresh = cache.stage("new".toByteArray(), "New.html")
        val oldTime = now - day - 1000
        old.setLastModified(oldTime)
        old.parentFile!!.setLastModified(oldTime)
        val sibling = File(tmp.root, "sibling.html").apply { writeText("keep") }
        sibling.setLastModified(0)

        assertEquals(1, cache.cleanup())
        assertFalse(old.parentFile!!.exists())
        assertTrue(fresh.exists())
        assertTrue(sibling.exists())

        now += 2 * day
        // The real clock set the fresh copy's time; move it into the past too.
        fresh.setLastModified(10 * day)
        fresh.parentFile!!.setLastModified(10 * day)
        assertEquals(1, cache.cleanup())
        assertEquals(0, root.list()!!.size)
    }

    @Test fun `cleanup tolerates a missing root`() {
        assertEquals(0, ShareCache(File(tmp.root, "nope")).cleanup())
    }
}
