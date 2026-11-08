package io.github.eli5learner.data

import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.data.db.FtsQuery
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.importer.ImportResult
import io.github.eli5learner.inMemoryDb
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The Room library index (16 §6.4): rebuilt from the files, the S2 JSON index migrated, full-text search. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LibraryIndexTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db

    @Before fun setUp() {
        db = inMemoryDb()
    }

    @After fun tearDown() = db.close()

    @Test fun `an empty database is rebuilt from the files and the S2 JSON index is migrated and deleted`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val sha = store.write(DocStore.importedKey("x"), TestDocs.eli5().toByteArray())
            val f = store.write("local-f", TestDocs.foreign().toByteArray())
            // A synced copy whose row was lost with the database.
            val synced = store.write(DOC, TestDocs.eli5(docId = DOC, title = "From the Mac").toByteArray())
            val legacy = File(tmp.root, "library-index.json")
            legacy.writeText(
                """{"version":1,"entries":[{"key":"local-f","sha":"$f","title":"Renamed page","foreign":true,"importedAt":42}]}""",
            )

            val index = LibraryIndex(db, store, legacy) { 5L }
            val rebuilt = index.load()
            assertEquals(
                setOf(DocStore.importedKey("x") to sha, "local-f" to f, DOC to synced),
                rebuilt.map { it.key to it.sha }.toSet(),
            )
            val page = rebuilt.single { it.key == "local-f" }
            assertEquals("Renamed page", page.title)
            assertEquals(42L, page.updatedAt)
            assertEquals("doc-1", rebuilt.single { it.key == DocStore.importedKey("x") }.docId)
            val mac = rebuilt.single { it.key == DOC }
            assertTrue(mac.synced)
            assertEquals(synced, mac.remoteSha)
            assertFalse(legacy.exists())
        }

    @Test fun `rows whose files are gone are dropped, synced ones wait for a download`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val first = LibraryIndex(db, store)
            val imported = (HtmlImporter(store, first).import(TestDocs.foreign().toByteArray(), "p.html") as ImportResult.Imported).entry
            val sha = store.write(DOC, TestDocs.eli5(docId = DOC).toByteArray())
            db.documents().save(
                DocumentEntity(key = DOC, docId = DOC, source = DocumentEntity.SOURCE_SYNCED, title = "T", updatedAt = 1, localSha = sha, remoteSha = sha),
                "",
            )
            store.delete(imported.key)
            store.delete(DOC)

            // A new process: the first load checks rows against files.
            val entries = LibraryIndex(db, store).load()
            assertEquals(listOf(DOC), entries.map { it.key })
            assertNull(entries.single().sha)
            assertFalse(entries.single().available)
        }

    @Test fun `remove drops the entry and its files, newest first order`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val index = LibraryIndex(db, store)
            var now = 1L
            val importer = HtmlImporter(store, index) { now }
            val a = (importer.import(TestDocs.foreign("A").toByteArray(), "a.html") as ImportResult.Imported).entry
            now = 2L
            val b = (importer.import(TestDocs.foreign("B").toByteArray(), "b.html") as ImportResult.Imported).entry
            assertEquals(listOf(b.key, a.key), index.entries.first().map { it.key })
            assertEquals(a.key, index.remove(a.key)?.key)
            assertNull(index.remove(a.key))
            assertFalse(store.exists(a.key, a.sha!!))
            assertEquals(listOf(b.key), LibraryIndex(db, store).load().map { it.key })
        }

    @Test fun `an import of a document already synced from the Mac is skipped`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val index = LibraryIndex(db, store)
            db.documents().save(
                DocumentEntity(key = "doc-1", docId = "doc-1", source = DocumentEntity.SOURCE_SYNCED, title = "T", updatedAt = 1),
                "",
            )
            val r = HtmlImporter(store, index).import(TestDocs.eli5(docId = "doc-1").toByteArray(), "index.html")
            assertTrue(r is ImportResult.Skipped)
            assertTrue(store.list().isEmpty())
        }

    @Test fun `full-text search covers title, headings and the document text, as prefixes, all terms`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val index = LibraryIndex(db, store)
            val importer = HtmlImporter(store, index)
            val showcase = (importer.import(TestDocs.fixture("full.html"), "index.html") as ImportResult.Imported).entry
            val gizmos = (importer.import(TestDocs.eli5(docId = "w", title = "Gizmos explained").toByteArray(), "w.html") as ImportResult.Imported).entry

            // Body text only (a glossary explanation and a paragraph of the fixture), not in title or headings.
            assertEquals(setOf(showcase.key), index.search("revenue earned"))
            assertEquals(setOf(showcase.key), index.search("plant SEEDS"))
            // Prefix match on the title.
            assertEquals(setOf(gizmos.key), index.search("gizm"))
            // Headings of the synthetic document.
            assertEquals(setOf(gizmos.key), index.search("five-year-old"))
            assertEquals(emptySet<String>(), index.search("gizmos seeds"))
            // Punctuation alone is no query; FTS syntax is never passed through.
            assertNull(index.search("  \"* - "))
            assertEquals("roas* or*", FtsQuery.of("ROAS OR"))
            assertEquals(emptySet<String>(), index.search("NEAR(\"x\""))
        }

    @Test fun `model text is plain prose without markup`() {
        val text = HtmlImporter.modelText(TestDocs.fixture("full.html").toString(Charsets.UTF_8))
        assertTrue(text.contains("Revenue earned for each dollar"))
        assertFalse(text.contains("**"))
        assertFalse(text.contains("<b>"))
        assertEquals("", HtmlImporter.modelText(TestDocs.foreign()))
    }

    private companion object {
        const val DOC = "6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f"
    }
}
