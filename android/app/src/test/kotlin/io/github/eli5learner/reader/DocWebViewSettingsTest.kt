package io.github.eli5learner.reader

import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import io.github.eli5learner.data.DocStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DocWebViewSettingsTest {
    @get:Rule val tmp = TemporaryFolder()

    private val sha = "ab".repeat(32)
    private val docUrl = UrlPolicy.docUrl("local-$sha", sha)

    private fun create(
        foreign: Boolean,
        external: MutableList<String> = mutableListOf(),
    ): WebView =
        DocWebViewFactory.create(
            context = ApplicationProvider.getApplicationContext(),
            store = DocStore(tmp.newFolder()),
            docUrl = docUrl,
            foreign = foreign,
            onExternal = { external += it },
            onHistoryChanged = {},
            onRendererGone = {},
        )

    @Test fun `ELI5 documents run JavaScript with every file and content access off`() {
        val s = create(foreign = false).settings
        assertTrue(s.javaScriptEnabled)
        assertTrue(s.domStorageEnabled)
        assertFalse(s.allowFileAccess)
        assertFalse(s.allowContentAccess)
        @Suppress("DEPRECATION")
        assertFalse(s.allowFileAccessFromFileURLs)
        @Suppress("DEPRECATION")
        assertFalse(s.allowUniversalAccessFromFileURLs)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, s.mixedContentMode)
        assertFalse(s.javaScriptCanOpenWindowsAutomatically)
        assertFalse(s.supportMultipleWindows())
    }

    @Test fun `foreign files get no JavaScript`() {
        assertFalse(create(foreign = true).settings.javaScriptEnabled)
    }

    @Test fun `no JavaScript interface is exposed`() {
        val view = create(foreign = false)
        val field = shadowOf(view).javaClass.getDeclaredField("javascriptInterfaces").apply { isAccessible = true }
        assertTrue((field.get(shadowOf(view)) as Map<*, *>).isEmpty())
        assertEquals(null, shadowOf(view).getJavascriptInterface("eli5Doc"))
    }

    @Test fun `the client serves documents, forbids everything else and routes links through the policy`() {
        val external = mutableListOf<String>()
        val view = create(foreign = false, external = external)
        val client = shadowOf(view).webViewClient as DocWebViewFactory.Client

        assertEquals(403, client.intercept("https://example.com/x.js").statusCode)
        assertEquals(403, client.intercept("file:///etc/hosts").statusCode)
        assertEquals(404, client.intercept(docUrl).statusCode) // valid URL, no such file

        assertFalse(client.decide("$docUrl#sec-1", hasGesture = true, isMainFrame = true))
        assertTrue(client.decide("javascript:alert(1)", hasGesture = true, isMainFrame = true))
        assertTrue(client.decide("https://example.com", hasGesture = false, isMainFrame = true))
        assertTrue(external.isEmpty())
        assertTrue(client.decide("https://example.com/a", hasGesture = true, isMainFrame = true))
        assertEquals(listOf("https://example.com/a"), external)
    }
}
