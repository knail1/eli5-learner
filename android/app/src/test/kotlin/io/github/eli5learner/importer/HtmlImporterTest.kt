package io.github.eli5learner.importer

import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.inMemoryDb
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class HtmlImporterTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `desktop fixtures are ELI5 documents with their model's id, title, tabs and headings`() {
        for (name in listOf("full.html", "showcase.html", "with-tab.html", "merged.html")) {
            val i = HtmlImporter.inspect(TestDocs.fixture(name).toString(Charsets.UTF_8))
            assertTrue("$name is ELI5", i.isEli5)
            assertTrue(i.docId!!.isNotBlank())
            assertTrue(i.title.isNotBlank())
            assertTrue(i.tabs.size >= 2)
            assertTrue(i.headings.isNotEmpty())
            assertEquals(1, i.scriptHashes.size)
        }
    }

    @Test fun `a document with explorables (data-params JSON) imports with its single pinned script`() {
        val html = TestDocs.fixture("showcase.html").toString(Charsets.UTF_8)
        assertTrue(html.contains("data-params=\"{&quot;kind&quot;:&quot;gradient-descent&quot;"))
        val i = HtmlImporter.inspect(html)
        assertTrue(i.isEli5)
        assertTrue(i.headings.contains("How the routing model learns"))
        assertEquals(1, i.scriptHashes.size)
    }

    @Test fun `the runtime hash matches the one the desktop pinned in the meta CSP`() {
        val html = TestDocs.fixture("full.html").toString(Charsets.UTF_8)
        val i = HtmlImporter.inspect(html)
        assertTrue(html.contains(i.scriptHashes.single()))
    }

    @Test fun `synthetic ELI5 document`() {
        val i = HtmlImporter.inspect(TestDocs.eli5())
        assertTrue(i.isEli5)
        assertEquals("doc-1", i.docId)
        assertEquals("Widgets explained", i.title)
        assertEquals(listOf("In depth", "ELI5"), i.tabs)
        assertEquals(listOf("How widgets work", "Widgets for a five-year-old"), i.headings)
        assertEquals(listOf(HtmlImporter.scriptHash("document.body.dataset.ok='1';")), i.scriptHashes)
    }

    @Test fun `a model whose scripts the meta CSP does not pin is foreign`() {
        val i = HtmlImporter.inspect(TestDocs.eli5(pin = false))
        assertFalse(i.isEli5)
        assertNull(i.docId)
        assertTrue(i.scriptHashes.isEmpty())
        assertEquals("Widgets explained", i.title)
    }

    @Test fun `HTML without a model is foreign and titled from title or file name`() {
        assertFalse(HtmlImporter.inspect(TestDocs.foreign()).isEli5)
        assertEquals("Some page", HtmlImporter.inspect(TestDocs.foreign()).title)
        assertEquals("Fallback", HtmlImporter.inspect("<html><body>x</body></html>", "Fallback").title)
    }

    @Test fun `broken, duplicated or mistyped models are foreign`() {
        val good = TestDocs.eli5()
        val cases =
            listOf(
                good.replace("\"formatVersion\":1,", ""),
                good.replace("\"docId\":\"doc-1\"", "\"docId\":\"\""),
                good.replace("type=\"application/json\" ", ""),
                good.replace("{\"formatVersion\"", "{not json"),
                good.replace("</head>", "<script type=\"application/json\" id=\"eli5-model\">{}</script></head>"),
                good.replace(",{\"key\":\"eli5\",\"label\":\"ELI5\",\"sections\":[{\"heading\":\"Widgets for a five-year-old\"}]}", ""),
                good.replace(Regex("<meta http-equiv=\"Content-Security-Policy\"[^>]*>"), ""),
            )
        for (html in cases) assertFalse(html, HtmlImporter.inspect(html).isEli5)
    }

    @Test fun `an extra unpinned inline script makes the file foreign`() {
        val html = TestDocs.eli5().replace("</body>", "<script>fetch('https://example.com')</script></body>")
        assertFalse(HtmlImporter.inspect(html).isEli5)
    }

    @Test fun `entities in the meta content are decoded`() {
        val hash = HtmlImporter.scriptHash("document.body.dataset.ok='1';")
        val escaped = hash.replace("'", "&#39;")
        val html = TestDocs.eli5().replace("script-src $hash", "script-src $escaped")
        assertTrue(html.contains(escaped))
        assertTrue(HtmlImporter.inspect(html).isEli5)
        assertEquals("a<b&\"c'", HtmlImporter.decodeEntities("a&lt;b&amp;&quot;c&#x27;"))
    }

    @Test fun `a large inline script is hashed without blowing the stack`() {
        val big = "var a='" + "x".repeat(8 * 1024 * 1024) + "';"
        val i = HtmlImporter.inspect(TestDocs.eli5(script = big))
        assertTrue(i.isEli5)
    }

    @Test fun `import stores the bytes, indexes them and replaces an older copy of the same docId`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val index = LibraryIndex(inMemoryDb(), store)
            var now = 1_000L
            val importer = HtmlImporter(store, index) { now }

            val v1 = importer.import(TestDocs.eli5(title = "v1").toByteArray(), "index.html") as ImportResult.Imported
            now = 2_000L
            val v2 = importer.import(TestDocs.eli5(title = "v2").toByteArray(), "index.html") as ImportResult.Imported
            now = 3_000L
            val other = importer.import(TestDocs.foreign().toByteArray(), "page.html") as ImportResult.Imported

            val entries = index.load()
            assertEquals(listOf(other.entry.key, v2.entry.key), entries.map { it.key })
            assertTrue(other.entry.foreign)
            assertFalse(v2.entry.foreign)
            assertEquals(DocStore.importedKey(v2.entry.sha!!), v2.entry.key)
            assertNull(store.read(v1.entry.key, v1.entry.sha!!))
            assertEquals(v2.entry.sha, DocStore.sha256Hex(store.read(v2.entry.key, v2.entry.sha!!)!!))
        }

    @Test fun `import skips empty, non-HTML and oversized files`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val importer = HtmlImporter(store, LibraryIndex(inMemoryDb(), store))
            assertTrue(importer.import(ByteArray(0), "a.html") is ImportResult.Skipped)
            assertTrue(importer.import("%PDF-1.7 binary".toByteArray(), "a.pdf") is ImportResult.Skipped)
            assertTrue(importer.import(ByteArray(HtmlImporter.MAX_BYTES + 1) { 'a'.code.toByte() }, "a.html") is ImportResult.Skipped)
            assertTrue(store.list().isEmpty())
        }
}
