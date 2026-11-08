package io.github.eli5learner.reader

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.net.toUri
import androidx.webkit.WebViewAssetLoader
import io.github.eli5learner.data.DocStore

/**
 * Builds the document reader's WebView (16 §6.3). Documents are LLM-generated HTML and untrusted:
 * no file or content access, no JavaScript interface (and nothing named `eli5Doc`, so the runtime
 * stays in its read-only browser mode), no popups, no network.
 */
object DocWebViewFactory {
    /**
     * Applies the reader settings. JavaScript runs only for a valid ELI5 document, whose scripts the
     * CSP header pins by hash; a foreign file gets neither JavaScript nor any script source.
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun applySettings(
        settings: WebSettings,
        foreign: Boolean,
    ) {
        settings.javaScriptEnabled = !foreign
        // The runtime keeps the theme choice in localStorage.
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        @Suppress("DEPRECATION")
        settings.allowFileAccessFromFileURLs = false
        @Suppress("DEPRECATION")
        settings.allowUniversalAccessFromFileURLs = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.safeBrowsingEnabled = true
        // target="_blank" links (every reference link) then stay in this WebView and reach
        // shouldOverrideUrlLoading, which opens http(s) in a Custom Tab; no window is ever created.
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setGeolocationEnabled(false)
        settings.mediaPlaybackRequiresUserGesture = true
        // No network: Client.shouldInterceptRequest answers every request itself (403 outside /docs/),
        // so nothing reaches the network stack. blockNetworkLoads is left alone on purpose.
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
    }

    /** The asset loader that answers `https://appassets.androidplatform.net/docs/…` from [store]. */
    fun assetLoader(store: DocStore): WebViewAssetLoader =
        WebViewAssetLoader
            .Builder()
            .setDomain(UrlPolicy.HOST)
            .setHttpAllowed(false)
            .addPathHandler(UrlPolicy.DOCS_PREFIX, DocPathHandler(store))
            .build()

    /**
     * The client: answers only servable document URLs (403 for anything else) and applies
     * [UrlPolicy] to every navigation.
     */
    class Client(
        private val loader: WebViewAssetLoader,
        private val docUrl: String,
        private val onExternal: (String) -> Unit,
        private val onHistoryChanged: (canGoBack: Boolean) -> Unit = {},
        private val onRendererGone: () -> Unit = {},
        private val onPageFinished: (WebView) -> Unit = {},
    ) : WebViewClient() {
        override fun onPageFinished(
            view: WebView,
            url: String?,
        ) {
            onPageFinished(view)
        }

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse = intercept(request.url.toString())

        fun intercept(url: String): WebResourceResponse =
            if (UrlPolicy.isServable(url)) {
                loader.shouldInterceptRequest(url.toUri()) ?: DocPathHandler.error(404, "Not Found")
            } else {
                DocPathHandler.error(403, "Forbidden")
            }

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean = decide(request.url.toString(), request.hasGesture(), request.isForMainFrame)

        /** True when the WebView must not navigate. */
        fun decide(
            url: String,
            hasGesture: Boolean,
            isMainFrame: Boolean,
        ): Boolean =
            when (val d = UrlPolicy.forNavigation(url, docUrl, hasGesture, isMainFrame)) {
                UrlDecision.Allow -> false
                UrlDecision.Block -> true
                is UrlDecision.OpenExternal -> {
                    onExternal(d.url)
                    true
                }
            }

        override fun doUpdateVisitedHistory(
            view: WebView,
            url: String?,
            isReload: Boolean,
        ) {
            onHistoryChanged(view.canGoBack())
        }

        override fun onRenderProcessGone(
            view: WebView,
            detail: RenderProcessGoneDetail?,
        ): Boolean {
            onRendererGone()
            return true
        }
    }

    /** A configured WebView for one document; the caller loads [UrlPolicy.docUrl] and destroys it. */
    fun create(
        context: Context,
        store: DocStore,
        docUrl: String,
        foreign: Boolean,
        onExternal: (String) -> Unit,
        onHistoryChanged: (Boolean) -> Unit,
        onRendererGone: () -> Unit,
        onPageFinished: (WebView) -> Unit = {},
    ): WebView {
        val view = WebView(context)
        applySettings(view.settings, foreign)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = Client(assetLoader(store), docUrl, onExternal, onHistoryChanged, onRendererGone, onPageFinished)
        return view
    }
}
