package io.github.eli5learner.capture

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import io.github.eli5learner.sync.protocol.Limits
import io.github.eli5learner.sync.protocol.isHttpUrl
import java.io.ByteArrayOutputStream
import java.net.IDN

/** What a share intent carried, before any file is read (16 §5.2 step 1). */
data class ShareInput(
    /** The shared text (`EXTRA_TEXT`), if any. */
    val text: String = "",
    /** `EXTRA_SUBJECT`, e.g. a page title; shown as the capture's label, never sent. */
    val subject: String? = null,
    /** Shared files (`EXTRA_STREAM`), `content:` only, at most [MAX_STREAMS]. */
    val streams: List<Uri> = emptyList(),
    /** The intent's declared type. */
    val type: String? = null,
    /** Streams dropped before reading: not `content:`, or beyond [MAX_STREAMS]. */
    val droppedStreams: Int = 0,
) {
    val isEmpty: Boolean get() = text.isBlank() && streams.isEmpty()

    companion object {
        /** More files than a job can carry are refused in the sheet rather than read. */
        const val MAX_STREAMS = 50

        /** Null when [intent] is not a share (SEND or SEND_MULTIPLE). */
        fun of(intent: Intent?): ShareInput? {
            if (intent == null) return null
            val streams =
                when (intent.action) {
                    Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
                    Intent.ACTION_SEND_MULTIPLE ->
                        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty().filterNotNull()
                    else -> return null
                }
            // Only content URIs: a file: URI would let another app make us read our own private files.
            val content = streams.filter { it.scheme == "content" }.distinct()
            return ShareInput(
                text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty(),
                subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.trim()?.takeIf { it.isNotEmpty() },
                streams = content.take(MAX_STREAMS),
                type = intent.type,
                droppedStreams = streams.size - content.size.coerceAtMost(MAX_STREAMS),
            )
        }
    }
}

/** URLs and remaining text found in shared text. */
data class SharedText(
    val urls: List<String>,
    val text: String,
    /** URLs that could not be sent (user name in the URL, bad host, too long), or beyond the cap. */
    val refusedUrls: Int,
    /** The text was cut to [Limits.TEXT_CHARS]. */
    val shortened: Boolean,
)

/**
 * Splits shared text into job URLs and job text (16 §5.1). Browsers share a page as its URL, often
 * with the title in front; that leftover is dropped when it is short (the URL is the source), and
 * kept as text when it is long enough to be what the user meant to send.
 */
object TextExtractor {
    private val URL = Regex("(?i)\\bhttps?://[^\\s<>\"'`]+")

    /** Leftover text around URLs shorter than this is treated as a title, not as a source. */
    const val LEFTOVER_MIN_CHARS = 280

    fun extract(raw: String): SharedText {
        val found = URL.findAll(raw).map { trimUrl(it.value) to it.range }.toList()
        val urls = LinkedHashSet<String>()
        var refused = 0
        for ((u, _) in found) {
            val n = normalizeUrl(u)
            when {
                n == null -> refused++
                urls.size >= Limits.URLS && n !in urls -> refused++
                else -> urls += n
            }
        }
        var leftover = raw
        for ((u, range) in found.asReversed()) {
            leftover = leftover.replaceRange(range.first, range.first + u.length, " ")
        }
        leftover = leftover.lines().joinToString("\n") { it.trim() }.replace(Regex("\n{3,}"), "\n\n").trim()
        val keep = found.isEmpty() || leftover.codePointCount(0, leftover.length) >= LEFTOVER_MIN_CHARS
        var text = if (keep) leftover else ""
        val shortened = text.codePointCount(0, text.length) > Limits.TEXT_CHARS
        if (shortened) text = text.substring(0, text.offsetByCodePoints(0, Limits.TEXT_CHARS))
        return SharedText(urls.toList(), text, refused, shortened)
    }

    /** Drops sentence punctuation and an unbalanced closing bracket that ended up after a URL. */
    fun trimUrl(u: String): String {
        var s = u
        while (s.isNotEmpty()) {
            val c = s.last()
            val drop =
                when (c) {
                    '.', ',', ';', ':', '!', '?' -> true
                    ')' -> s.count { it == '(' } < s.count { it == ')' }
                    ']' -> s.count { it == '[' } < s.count { it == ']' }
                    '}' -> s.count { it == '{' } < s.count { it == '}' }
                    else -> false
                }
            if (!drop) break
            s = s.dropLast(1)
        }
        return s
    }

    /**
     * The URL as the job carries it (16 §12): the host IDNA-encoded and lowercased, everything else
     * that is not printable ASCII (or not allowed by `java.net.URI`) percent-encoded, no user name or
     * password. Null when it cannot be made valid.
     */
    fun normalizeUrl(u: String): String? {
        val m = Regex("(?i)^(https?)://([^/?#]*)(.*)$").find(u) ?: return null
        val scheme = m.groupValues[1].lowercase()
        val authority = m.groupValues[2]
        val rest = m.groupValues[3]
        if ('@' in authority) return null
        val hostPort = Regex("^(.*?)(:(\\d{1,5}))?$").find(authority) ?: return null
        val rawHost = hostPort.groupValues[1].trimEnd('.')
        if (rawHost.isEmpty()) return null
        val host =
            try {
                IDN.toASCII(rawHost, IDN.USE_STD3_ASCII_RULES).lowercase()
            } catch (_: IllegalArgumentException) {
                return null
            }
        val port = hostPort.groupValues[2]
        val out = "$scheme://$host$port${encodeRest(rest)}"
        return out.takeIf { isHttpUrl(it) }
    }

    /** Characters `java.net.URI` accepts unescaped in a path, query and fragment, plus `#` once. */
    private const val SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@/?"

    private fun encodeRest(rest: String): String {
        val out = StringBuilder()
        var fragment = false
        val bytes = rest.toByteArray(Charsets.UTF_8)
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i].toInt() and 0xFF
            val c = b.toChar()
            when {
                b < 0x80 && c in SAFE -> out.append(c)
                c == '#' && !fragment -> {
                    fragment = true
                    out.append(c)
                }
                c == '%' && i + 2 < bytes.size && isHex(bytes[i + 1]) && isHex(bytes[i + 2]) -> out.append(c)
                else -> out.append('%').append("%02X".format(b))
            }
            i++
        }
        return out.toString()
    }

    private fun isHex(b: Byte): Boolean = b.toInt().toChar().let { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
}

/** Attachment display names as the job carries them (16 §12: no path separators, controls or bidi controls). */
object AttachmentNames {
    private val FORBIDDEN = Regex("[/\\\\\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]")

    /** A safe name of at most [Limits.ATTACHMENT_NAME_CHARS] code points ending in an extension for [mime]. */
    fun sanitize(
        name: String?,
        mime: String,
        index: Int,
    ): String {
        // No leading dots: never "." or "..", and no hidden-file names on the Mac.
        var base = name.orEmpty().replace(FORBIDDEN, "").trim().trimStart('.').trim()
        val ext = base.substringAfterLast('.', "").lowercase()
        val wanted = MimeSniffer.extension(mime)
        if (base.isEmpty()) base = "attachment-${index + 1}"
        val suffix = if (ext in MimeSniffer.extensions(mime)) "" else ".$wanted"
        val max = Limits.ATTACHMENT_NAME_CHARS - suffix.length
        if (base.codePointCount(0, base.length) > max) base = base.substring(0, base.offsetByCodePoints(0, max))
        return base + suffix
    }
}

/** Reads at most [limit] bytes from [input]: one byte more than a cap is enough to refuse a file. */
fun readAtMost(
    input: java.io.InputStream,
    limit: Long,
): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(64 * 1024)
    var total = 0L
    while (total < limit) {
        val n = input.read(buf, 0, minOf(buf.size.toLong(), limit - total).toInt())
        if (n < 0) break
        out.write(buf, 0, n)
        total += n
    }
    return out.toByteArray()
}
