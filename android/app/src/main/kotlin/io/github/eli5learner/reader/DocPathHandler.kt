package io.github.eli5learner.reader

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.importer.HtmlImporter
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Serves `/docs/<key>/<sha>.html` from [DocStore] to the reader WebView (16 §6.3), with a response
 * Content-Security-Policy header. A valid ELI5 document gets `script-src` pinned to the sha256 of its
 * own inline scripts; any other HTML gets `script-src 'none'`. The header applies on top of the
 * document's own meta CSP, so the effective policy is never looser than either.
 */
class DocPathHandler(
    private val store: DocStore,
) : WebViewAssetLoader.PathHandler {
    private val policies = ConcurrentHashMap<String, String>()

    /** [path] is relative to the `/docs/` prefix the handler is registered under. */
    override fun handle(path: String): WebResourceResponse {
        val (key, sha) = UrlPolicy.parseDocPath(UrlPolicy.DOCS_PREFIX + path) ?: return error(404, "Not Found")
        val bytes = store.read(key, sha) ?: return error(404, "Not Found")
        val csp = policies.getOrPut(sha) { policyFor(bytes) }
        return WebResourceResponse("text/html", "utf-8", 200, "OK", headers(csp), ByteArrayInputStream(bytes))
    }

    companion object {
        /** The header for one file's bytes. */
        fun policyFor(bytes: ByteArray): String {
            val i = HtmlImporter.inspect(bytes.toString(Charsets.UTF_8))
            return contentSecurityPolicy(if (i.isEli5) i.scriptHashes else null)
        }

        /** 16 §6.3. [scriptHashes] null (or empty) means no script may run. */
        fun contentSecurityPolicy(scriptHashes: List<String>?): String {
            val scriptSrc = scriptHashes?.takeIf { it.isNotEmpty() }?.joinToString(" ") ?: "'none'"
            return listOf(
                "default-src 'none'",
                "img-src data:",
                "font-src data:",
                "style-src 'unsafe-inline'",
                "script-src $scriptSrc",
                "connect-src 'none'",
                "frame-src 'none'",
                "form-action 'none'",
                "base-uri 'none'",
            ).joinToString("; ")
        }

        fun headers(csp: String): Map<String, String> =
            mapOf(
                "Content-Security-Policy" to csp,
                "X-Content-Type-Options" to "nosniff",
                "Referrer-Policy" to "no-referrer",
                "Cache-Control" to "no-store",
            )

        /** An empty error response; never null, so the WebView never falls through to the network. */
        fun error(
            status: Int,
            reason: String,
        ): WebResourceResponse =
            WebResourceResponse(
                "text/plain",
                "utf-8",
                status,
                reason,
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(ByteArray(0)),
            )
    }
}
