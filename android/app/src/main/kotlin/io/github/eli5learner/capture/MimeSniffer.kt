package io.github.eli5learner.capture

import io.github.eli5learner.sync.protocol.ATTACHMENT_MIME_TYPES
import java.io.ByteArrayInputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.zip.ZipInputStream

/**
 * The type of a shared file from its bytes, not from what the sharing app declared (16 §5.1: the MIME
 * allowlist is checked by sniffing). Returns one of [ATTACHMENT_MIME_TYPES], or null for anything
 * the desktop resolvers do not accept. The declared type and the file name only choose between the
 * text types, which have no magic bytes.
 */
object MimeSniffer {
    const val PNG = "image/png"
    const val JPEG = "image/jpeg"
    const val GIF = "image/gif"
    const val WEBP = "image/webp"
    const val HEIC = "image/heic"
    const val TIFF = "image/tiff"
    const val BMP = "image/bmp"
    const val PDF = "application/pdf"
    const val PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    const val DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    const val XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    const val TEXT = "text/plain"
    const val MARKDOWN = "text/markdown"
    const val CSV = "text/csv"
    const val HTML = "text/html"

    /** HEIF brands of still images; HEIC stays HEIC because the desktop accepts it (16 §5.2). */
    private val HEIF_BRANDS = setOf("heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1")

    /** Text files are checked in full up to this size; longer ones by their first part. */
    private const val TEXT_PROBE_BYTES = 64 * 1024

    /** Zip entries read to tell the Office formats apart. */
    private const val MAX_ZIP_ENTRIES = 200

    fun sniff(
        bytes: ByteArray,
        declared: String? = null,
        name: String? = null,
    ): String? {
        if (bytes.isEmpty()) return null
        val type =
            when {
                startsWith(bytes, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) -> PNG
                startsWith(bytes, 0xFF, 0xD8, 0xFF) -> JPEG
                ascii(bytes, 0, 6) == "GIF87a" || ascii(bytes, 0, 6) == "GIF89a" -> GIF
                ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WEBP" -> WEBP
                ascii(bytes, 4, 4) == "ftyp" && ascii(bytes, 8, 4) in HEIF_BRANDS -> HEIC
                startsWith(bytes, 0x49, 0x49, 0x2A, 0x00) || startsWith(bytes, 0x4D, 0x4D, 0x00, 0x2A) -> TIFF
                ascii(bytes, 0, 2) == "BM" && bytes.size >= 26 -> BMP
                isPdf(bytes) -> PDF
                startsWith(bytes, 0x50, 0x4B, 0x03, 0x04) -> office(bytes)
                else -> text(bytes, declared, name)
            }
        return type?.takeIf { it in ATTACHMENT_MIME_TYPES }
    }

    /** The canonical file extension for an accepted type (the remote `att-<sha>.<ext>` name). */
    fun extension(mime: String): String =
        when (mime) {
            PNG -> "png"
            JPEG -> "jpg"
            GIF -> "gif"
            WEBP -> "webp"
            HEIC -> "heic"
            TIFF -> "tiff"
            BMP -> "bmp"
            PDF -> "pdf"
            PPTX -> "pptx"
            DOCX -> "docx"
            XLSX -> "xlsx"
            MARKDOWN -> "md"
            CSV -> "csv"
            HTML -> "html"
            else -> "txt"
        }

    /** Extensions a name may already carry for [mime] (so `photo.jpeg` is not renamed). */
    fun extensions(mime: String): Set<String> =
        when (mime) {
            JPEG -> setOf("jpg", "jpeg", "jfif")
            TIFF -> setOf("tif", "tiff")
            HEIC -> setOf("heic", "heif")
            MARKDOWN -> setOf("md", "markdown")
            HTML -> setOf("html", "htm")
            TEXT -> setOf("txt", "text")
            else -> setOf(extension(mime))
        }

    /** `%PDF-` at the start, or within the first KiB as PDF readers allow. */
    private fun isPdf(bytes: ByteArray): Boolean {
        val head = ascii(bytes, 0, minOf(bytes.size, 1024))
        return head.contains("%PDF-")
    }

    /** OOXML: a zip whose parts live under `ppt/`, `word/` or `xl/`. Any other zip is refused. */
    private fun office(bytes: ByteArray): String? =
        try {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                var seen = 0
                while (seen++ < MAX_ZIP_ENTRIES) {
                    val e = zip.nextEntry ?: break
                    when {
                        e.name.startsWith("ppt/") -> return PPTX
                        e.name.startsWith("word/") -> return DOCX
                        e.name.startsWith("xl/") -> return XLSX
                    }
                }
                null
            }
        } catch (_: IOException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }

    /** Valid UTF-8 without NUL bytes; HTML by its start, Markdown and CSV by the declared type or name. */
    private fun text(
        bytes: ByteArray,
        declared: String?,
        name: String?,
    ): String? {
        val probe = if (bytes.size <= TEXT_PROBE_BYTES) bytes else trimToCharBoundary(bytes.copyOf(TEXT_PROBE_BYTES))
        if (probe.any { it == 0.toByte() }) return null
        val decoded =
            try {
                Charsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(probe))
                    .toString()
            } catch (_: CharacterCodingException) {
                return null
            }
        val start = decoded.trimStart('\uFEFF', ' ', '\t', '\r', '\n').take(64).lowercase()
        val ext = name?.substringAfterLast('.', "")?.lowercase().orEmpty()
        val type = declared?.substringBefore(';')?.trim()?.lowercase()
        return when {
            start.startsWith("<!doctype html") || start.startsWith("<html") -> HTML
            type == MARKDOWN || type == "text/x-markdown" || ext == "md" || ext == "markdown" -> MARKDOWN
            type == CSV || type == "text/comma-separated-values" || ext == "csv" -> CSV
            else -> TEXT
        }
    }

    /** Drops a UTF-8 sequence cut off at the end of a probe, so a long file is not called binary. */
    private fun trimToCharBoundary(b: ByteArray): ByteArray {
        var end = b.size
        var back = 0
        while (end > 0 && back < 3 && (b[end - 1].toInt() and 0xC0) == 0x80) {
            end--
            back++
        }
        if (end > 0 && (b[end - 1].toInt() and 0xC0) == 0xC0) end--
        return b.copyOf(end)
    }

    private fun startsWith(
        b: ByteArray,
        vararg sig: Int,
    ): Boolean = b.size >= sig.size && sig.indices.all { (b[it].toInt() and 0xFF) == sig[it] }

    private fun ascii(
        b: ByteArray,
        from: Int,
        len: Int,
    ): String {
        if (from + len > b.size || len <= 0) return ""
        return String(CharArray(len) { (b[from + it].toInt() and 0xFF).toChar() })
    }
}
