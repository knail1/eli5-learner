package io.github.eli5learner.share

import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.inMemoryDb
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** Preparing a share copy of a stored version (16 §6.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
@OptIn(ExperimentalCoroutinesApi::class)
class DocSharerTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var store: DocStore
    private lateinit var index: LibraryIndex
    private val bytes = TestDocs.eli5().toByteArray()

    @Before fun setUp() {
        db = inMemoryDb()
        store = DocStore(File(tmp.root, "docs"))
        index = LibraryIndex(db, store)
    }

    @After fun tearDown() = db.close()

    private fun sharer(root: File = File(tmp.root, "cache/share")) = DocSharer(store, index, ShareCache(root), UnconfinedTestDispatcher())

    @Test fun `a stored version is copied under the cache with its title as the name`() =
        runTest {
            val sha = store.write("doc-1", bytes)
            val s = sharer()
            val p = s.prepare(ShareRequest("doc-1", sha, "Widgets explained", "doc-1"))
            assertTrue(p is SharePrepared.Ready)
            p as SharePrepared.Ready
            assertEquals("Widgets explained.html", p.file.name)
            assertEquals("Widgets explained", p.title)
            assertArrayEquals(bytes, p.file.readBytes())
            assertTrue(p.file.canonicalPath.startsWith(s.cache.root.canonicalPath + File.separator))
            assertEquals(emptySet<String>(), index.leased("doc-1"))
        }

    @Test fun `ShareRequest of an entry falls back to the docId, then the key`() {
        val e = DocEntry(key = "local-x", sha = "a".repeat(64), title = "T", docId = "d1", foreign = false, updatedAt = 0)
        assertEquals(ShareRequest("local-x", "b".repeat(64), "T", "d1"), ShareRequest.of(e, "b".repeat(64)))
        assertEquals("local-x", ShareRequest.of(e.copy(docId = null), "c".repeat(64)).fallbackName)
    }

    @Test fun `an unknown sha, a tampered file or an invalid key is Missing`() =
        runTest {
            val sha = store.write("doc-1", bytes)
            val s = sharer()
            assertEquals(SharePrepared.Missing, s.prepare(ShareRequest("doc-1", "0".repeat(64), "T", "doc-1")))
            assertEquals(SharePrepared.Missing, s.prepare(ShareRequest("../etc", sha, "T", "doc-1")))
            File(File(store.root, "doc-1"), "$sha.html").writeText("tampered")
            assertEquals(SharePrepared.Missing, s.prepare(ShareRequest("doc-1", sha, "T", "doc-1")))
            assertEquals(emptySet<String>(), index.leased("doc-1"))
        }

    @Test fun `an unwritable cache is Failed, not an exception`() =
        runTest {
            val sha = store.write("doc-1", bytes)
            val root = File(tmp.root, "blocked").apply { writeText("a file, not a folder") }
            assertEquals(SharePrepared.Failed, sharer(root).prepare(ShareRequest("doc-1", sha, "T", "doc-1")))
            assertEquals(emptySet<String>(), index.leased("doc-1"))
        }

    @Test fun `prepare removes copies older than a day`() =
        runTest {
            val sha = store.write("doc-1", bytes)
            val s = sharer()
            val old = s.cache.stage(byteArrayOf(1), "Old.html")
            val past = System.currentTimeMillis() - ShareCache.MAX_AGE_MS - 60_000
            old.setLastModified(past)
            old.parentFile!!.setLastModified(past)
            assertTrue(s.prepare(ShareRequest("doc-1", sha, "T", "doc-1")) is SharePrepared.Ready)
            assertFalse(old.parentFile!!.exists())
        }

    @Test fun `the app-start cleanup runs on the given scope`() =
        runTest {
            val s = sharer()
            val old = s.cache.stage(byteArrayOf(1), "Old.html")
            old.setLastModified(0)
            old.parentFile!!.setLastModified(0)
            s.cleanupIn(this)
            testScheduler.advanceUntilIdle()
            assertFalse(old.parentFile!!.exists())
        }
}
