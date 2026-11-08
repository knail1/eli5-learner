package io.github.eli5learner.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class DocStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `write is content addressed, atomic and idempotent`() {
        val root = tmp.newFolder("docs")
        val store = DocStore(root)
        val bytes = "<html>hi</html>".toByteArray()
        val sha = store.write("local-a", bytes)
        assertEquals(DocStore.sha256Hex(bytes), sha)
        assertEquals(sha, store.write("local-a", bytes))
        assertArrayEquals(bytes, store.read("local-a", sha))
        assertEquals(listOf("$sha.html"), File(root, "local-a").list()!!.toList())
        assertEquals(listOf("local-a" to sha), store.list())
    }

    @Test fun `a file whose bytes no longer match its sha is not served`() {
        val root = tmp.newFolder("docs")
        val store = DocStore(root)
        val sha = store.write("k", "original".toByteArray())
        File(root, "k/$sha.html").writeText("tampered")
        assertNull(store.read("k", sha))
    }

    @Test fun `writing the same bytes again repairs a damaged copy of the same length`() {
        val root = tmp.newFolder("docs")
        val store = DocStore(root)
        val bytes = "original".toByteArray()
        val sha = store.write("k", bytes)
        File(root, "k/$sha.html").writeText("tampered")
        assertEquals(sha, store.write("k", bytes))
        assertArrayEquals(bytes, store.read("k", sha))
    }

    @Test fun `keys and shas that could escape the folder are rejected`() {
        val store = DocStore(tmp.newFolder("docs"))
        val sha = "a".repeat(64)
        for (bad in listOf("..", "../x", "a/b", "", ".hidden", "a b", "x".repeat(200))) {
            assertNull(store.read(bad, sha))
            assertTrue(runCatching { store.write(bad, ByteArray(1)) }.isFailure)
        }
        assertNull(store.read("ok", "../../etc"))
        assertNull(store.read("ok", "A".repeat(64)))
    }

    @Test fun `delete and prune`() {
        val store = DocStore(tmp.newFolder("docs"))
        val a = store.write("k", "a".toByteArray())
        val b = store.write("k", "b".toByteArray())
        store.prune("k", b)
        assertNull(store.read("k", a))
        store.delete("k")
        assertTrue(store.list().isEmpty())
    }

    @Test fun `pruneExcept keeps the listed shas and drops an empty folder`() {
        val store = DocStore(tmp.newFolder("docs"))
        val a = store.write("k", "a".toByteArray())
        val b = store.write("k", "b".toByteArray())
        store.pruneExcept("k", setOf(a, b))
        assertEquals(setOf(a, b), store.list().map { it.second }.toSet())
        store.pruneExcept("k", emptySet())
        assertTrue(store.list().isEmpty())
        assertTrue(!File(store.root, "k").exists())
        assertTrue(!store.exists("k", a))
    }
}
