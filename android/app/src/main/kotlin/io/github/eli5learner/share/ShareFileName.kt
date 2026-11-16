package io.github.eli5learner.share

import java.text.Normalizer

/** A readable, safe file name for a shared document: `<title>.html` (16 §6.5). */
object ShareFileName {
    /** Code points before [EXTENSION]. */
    const val MAX_CHARS = 80

    /** UTF-8 bytes before [EXTENSION] (file systems allow 255). */
    const val MAX_BYTES = 200
    const val EXTENSION = ".html"
    const val DEFAULT = "document"

    private val RESERVED = setOf('/', '\\', ':', '*', '?', '"', '<', '>', '|')
    private val HTML_SUFFIX = Regex("\\.html?$", RegexOption.IGNORE_CASE)

    /** `clean(title)`, else `clean(fallback)`, else [DEFAULT]; plus [EXTENSION]. */
    fun of(
        title: String,
        fallback: String,
    ): String = clean(title).ifEmpty { clean(fallback) }.ifEmpty { DEFAULT } + EXTENSION

    /** The usable part of [raw] as a file name base, or "" when nothing usable is left. */
    internal fun clean(raw: String): String {
        val normalized = Normalizer.normalize(raw, Normalizer.Form.NFC)
        val sb = StringBuilder(normalized.length)
        var i = 0
        while (i < normalized.length) {
            val cp = normalized.codePointAt(i)
            i += Character.charCount(cp)
            val type = Character.getType(cp)
            when {
                Character.isISOControl(cp) && !Character.isWhitespace(cp) -> Unit
                type == Character.FORMAT.toInt() -> Unit
                type == Character.LINE_SEPARATOR.toInt() || type == Character.PARAGRAPH_SEPARATOR.toInt() -> sb.append(' ')
                Character.isWhitespace(cp) || Character.isSpaceChar(cp) -> sb.append(' ')
                cp < 0x80 && cp.toChar() in RESERVED -> sb.append(' ')
                // Lone surrogates cannot be encoded as a file name.
                Character.isSurrogate(cp.toChar()) && cp <= 0xFFFF -> Unit
                else -> sb.appendCodePoint(cp)
            }
        }
        var s = trimEnds(sb.toString().replace(Regex(" {2,}"), " "))
        s = trimEnds(s.replace(HTML_SUFFIX, ""))
        s = cap(s)
        s = trimEnds(s)
        return if (s == "." || s == "..") "" else s
    }

    private fun trimEnds(s: String): String = s.trim { it == ' ' || it == '.' }

    private fun cap(s: String): String {
        var out = s
        if (out.codePointCount(0, out.length) > MAX_CHARS) out = out.substring(0, out.offsetByCodePoints(0, MAX_CHARS))
        while (out.toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
            out = out.substring(0, out.offsetByCodePoints(0, out.codePointCount(0, out.length) - 1))
        }
        return out
    }
}
