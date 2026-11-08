package io.github.eli5learner.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    private val sha = "0123456789abcdef".repeat(4)
    private val doc = UrlPolicy.docUrl("local-$sha", sha)

    @Test fun `only document URLs under docs on the asset host are servable`() {
        assertTrue(UrlPolicy.isServable(doc))
        assertTrue(UrlPolicy.isServable("$doc#sec-indepth-1"))
        for (bad in listOf(
            "http://appassets.androidplatform.net/docs/k/$sha.html",
            "https://appassets.androidplatform.net:444/docs/k/$sha.html",
            "https://user@appassets.androidplatform.net/docs/k/$sha.html",
            "https://evil.example/docs/k/$sha.html",
            "https://appassets.androidplatform.net/assets/x.js",
            "https://appassets.androidplatform.net/docs/k/../../x/$sha.html",
            "https://appassets.androidplatform.net/docs/k/%2e%2e/$sha.html",
            "https://appassets.androidplatform.net/docs/k/notasha.html",
            "file:///data/data/x/files/docs/k/$sha.html",
            "content://x/docs/k/$sha.html",
            "data:text/html,hi",
            "javascript:alert(1)",
            "not a url",
        )) {
            assertFalse(bad, UrlPolicy.isServable(bad))
        }
    }

    @Test fun `parseDocPath`() {
        assertEquals("k" to sha, UrlPolicy.parseDocPath("/docs/k/$sha.html"))
        assertEquals(null, UrlPolicy.parseDocPath("/docs/k/sub/$sha.html"))
    }

    @Test fun `navigation inside the document is allowed`() {
        assertEquals(UrlDecision.Allow, UrlPolicy.forNavigation("$doc#g-abc123", doc, hasGesture = true, isMainFrame = true))
        assertEquals(UrlDecision.Allow, UrlPolicy.forNavigation(doc, doc, hasGesture = false, isMainFrame = true))
    }

    @Test fun `http and https links open externally only with a user gesture`() {
        assertEquals(
            UrlDecision.OpenExternal("https://www.example.com/widgets/pricing"),
            UrlPolicy.forNavigation("https://www.example.com/widgets/pricing", doc, hasGesture = true, isMainFrame = true),
        )
        assertEquals(
            UrlDecision.OpenExternal("http://example.com/a"),
            UrlPolicy.forNavigation("http://example.com/a", doc, hasGesture = true, isMainFrame = true),
        )
        assertEquals(UrlDecision.Block, UrlPolicy.forNavigation("https://example.com", doc, hasGesture = false, isMainFrame = true))
        assertEquals(UrlDecision.Block, UrlPolicy.forNavigation("https://example.com", doc, hasGesture = true, isMainFrame = false))
    }

    @Test fun `every other scheme, host or document is dropped`() {
        val other = UrlPolicy.docUrl("local-x", "f".repeat(64))
        for (bad in listOf(
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;end",
            "file:///sdcard/x.html",
            "content://com.android.providers/x",
            "data:text/html,<script>1</script>",
            "mailto:a@example.com",
            "tel:123",
            "market://details?id=x",
            other,
            "$doc?x=1",
            "https://appassets.androidplatform.net/other",
            "https:///nohost",
            "",
        )) {
            assertEquals(bad, UrlDecision.Block, UrlPolicy.forNavigation(bad, doc, hasGesture = true, isMainFrame = true))
        }
    }
}
