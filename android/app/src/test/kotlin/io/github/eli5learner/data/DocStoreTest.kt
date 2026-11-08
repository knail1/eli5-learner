package io.github.eli5learner.data

import io.github.eli5learner.TestDocs
import kotlinx.coroutines.test.runTest
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

    @Test fun `the index is rebuilt from the files when it is missing or corrupt`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val indexFile = File(tmp.root, "index.json")
            val sha = store.write(DocStore.importedKey("x"), TestDocs.eli5().toByteArray())
            val f = store.write("local-f", TestDocs.foreign().toByteArray())

            val rebuilt = LocalIndex(indexFile, store) { 5L }.load()
            assertEquals(setOf(DocStore.importedKey("x") to sha, "local-f" to f), rebuilt.map { it.key to it.sha }.toSet())
            assertEquals("doc-1", rebuilt.single { !it.foreign }.docId)
            assertTrue(indexFile.isFile)

            indexFile.writeText("{ not json")
            assertEquals(2, LocalIndex(indexFile, store).load().size)

            // A stale entry (file gone) is dropped on the next load.
            store.delete("local-f")
            assertEquals(listOf(DocStore.importedKey("x")), LocalIndex(indexFile, store).load().map { it.key })
        }

    @Test fun `remove drops the entry and keeps the order newest first`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val index = LocalIndex(File(tmp.root, "index.json"), store)
            val e1 = DocEntry(key = "a", sha = store.write("a", "1".toByteArray()), title = "A", foreign = true, importedAt = 1)
            val e2 = DocEntry(key = "b", sha = store.write("b", "2".toByteArray()), title = "B", foreign = true, importedAt = 2)
            index.upsert(e1)
            index.upsert(e2)
            assertEquals(listOf("b", "a"), index.entries.value.map { it.key })
            assertEquals(e1, index.remove("a"))
            assertNull(index.remove("a"))
            store.delete("a")
            assertEquals(listOf("b"), LocalIndex(File(tmp.root, "index.json"), store).load().map { it.key })
        }
}
