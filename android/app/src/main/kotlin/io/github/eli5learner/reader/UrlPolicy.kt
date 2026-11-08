package io.github.eli5learner.reader

import java.net.URI

/** What the reader does with a navigation (16 §6.3). */
sealed interface UrlDecision {
    /** Let the WebView navigate (same document only). */
    data object Allow : UrlDecision

    /** Open in a Custom Tab; the reader itself does not navigate. */
    data class OpenExternal(
        val url: String,
    ) : UrlDecision

    /** Drop silently. */
    data object Block : UrlDecision
}

/**
 * URL rules for the document reader (16 §6.3). Pure JVM code so it is tested without Android.
 *
 * - Only `https://appassets.androidplatform.net/docs/<key>/<sha>.html` is ever loaded.
 * - Navigation stays inside the current document (fragment changes).
 * - An `http(s)` link opens in a Custom Tab, and only with a user gesture.
 * - Everything else (`javascript:`, `intent:`, `file:`, `content:`, `data:`, other documents,
 *   script-initiated or sub-frame navigations) is dropped.
 */
object UrlPolicy {
    const val HOST = "appassets.androidplatform.net"
    const val DOCS_PREFIX = "/docs/"

    private val DOC_PATH = Regex("^/docs/([A-Za-z0-9][A-Za-z0-9_-]{0,127})/([0-9a-f]{64})\\.html$")

    /** The reader URL of one stored document. */
    fun docUrl(
        key: String,
        sha: String,
    ): String = "https://$HOST$DOCS_PREFIX$key/$sha.html"

    /** The `(key, sha)` a reader URL path names, or null if it is not one. */
    fun parseDocPath(path: String): Pair<String, String>? = DOC_PATH.matchEntire(path)?.let { it.groupValues[1] to it.groupValues[2] }

    /** True for the only URLs `shouldInterceptRequest` may answer from the documents folder. */
    fun isServable(url: String): Boolean {
        val u = parse(url) ?: return false
        return u.scheme.equals("https", ignoreCase = true) &&
            u.host.equals(HOST, ignoreCase = true) &&
            u.port == -1 &&
            u.rawUserInfo == null &&
            parseDocPath(u.rawPath ?: "") != null
    }

    fun forNavigation(
        url: String,
        currentDocUrl: String?,
        hasGesture: Boolean,
        isMainFrame: Boolean,
    ): UrlDecision {
        val target = parse(url) ?: return UrlDecision.Block
        val current = currentDocUrl?.let(::parse)
        if (current != null && sameDocument(target, current)) return UrlDecision.Allow
        if (!isMainFrame || !hasGesture) return UrlDecision.Block
        val scheme = target.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return UrlDecision.Block
        if (target.host.isNullOrEmpty() || target.host.equals(HOST, ignoreCase = true)) return UrlDecision.Block
        return UrlDecision.OpenExternal(target.toASCIIString())
    }

    private fun sameDocument(
        a: URI,
        b: URI,
    ): Boolean =
        a.scheme.equals(b.scheme, ignoreCase = true) &&
            a.host.equals(b.host, ignoreCase = true) &&
            a.port == b.port &&
            a.rawPath == b.rawPath &&
            a.rawQuery == b.rawQuery &&
            a.rawUserInfo == b.rawUserInfo

    private fun parse(url: String): URI? = runCatching { URI(url.trim()) }.getOrNull()?.takeIf { it.isAbsolute && !it.isOpaque }
}
