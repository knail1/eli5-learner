package io.github.eli5learner.reader

import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.importer.HtmlImporter
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DocPathHandlerTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun cspOf(html: String): String {
        val store = DocStore(tmp.newFolder())
        val sha = store.write("k", html.toByteArray())
        val r = DocPathHandler(store).handle("k/$sha.html")
        assertEquals(200, r.statusCode)
        assertEquals("text/html", r.mimeType)
        assertArrayEquals(html.toByteArray(), r.data.readBytes())
        assertEquals("nosniff", r.responseHeaders["X-Content-Type-Options"])
        return r.responseHeaders.getValue("Content-Security-Policy")
    }

    @Test fun `an ELI5 document gets script-src pinned to its own inline script hashes`() {
        val csp = cspOf(TestDocs.eli5(script = "run();"))
        assertTrue(csp, csp.contains("script-src ${HtmlImporter.scriptHash("run();")};"))
        for (d in listOf("default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "img-src data:")) {
            assertTrue(d, csp.contains(d))
        }
        assertFalse(csp.contains("unsafe-eval"))
    }

    @Test fun `the desktop fixture is served with the hash its meta CSP pins`() {
        val html = TestDocs.fixture("full.html").toString(Charsets.UTF_8)
        val hash = HtmlImporter.inspect(html).scriptHashes.single()
        assertTrue(cspOf(html).contains("script-src $hash;"))
    }

    @Test fun `a foreign file gets script-src none`() {
        assertTrue(cspOf(TestDocs.foreign()).contains("script-src 'none';"))
        assertTrue(cspOf(TestDocs.eli5(pin = false)).contains("script-src 'none';"))
    }

    @Test fun `unknown, malformed or tampered paths are 404, never null`() {
        val root = tmp.newFolder()
        val store = DocStore(root)
        val sha = store.write("k", "<html></html>".toByteArray())
        val handler = DocPathHandler(store)
        for (p in listOf("k/${"0".repeat(64)}.html", "../k/$sha.html", "k/$sha.htm", "k", "")) {
            assertEquals(p, 404, handler.handle(p).statusCode)
        }
        java.io.File(root, "k/$sha.html").writeText("changed")
        assertEquals(404, handler.handle("k/$sha.html").statusCode)
    }

    @Test fun `contentSecurityPolicy without hashes is script-src none`() {
        assertTrue(DocPathHandler.contentSecurityPolicy(null).contains("script-src 'none'"))
        assertTrue(DocPathHandler.contentSecurityPolicy(emptyList()).contains("script-src 'none'"))
    }
}
