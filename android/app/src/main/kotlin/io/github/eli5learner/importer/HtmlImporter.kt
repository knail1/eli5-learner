package io.github.eli5learner.importer

import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.security.MessageDigest
import java.util.Base64

/** What the importer learned about one HTML file (16 §6.3, §7). */
data class Inspection(
    /** True for a valid ELI5 document: an embedded model and a meta CSP that pins its scripts. */
    val isEli5: Boolean,
    val title: String,
    /** The model's `docId`; null for a foreign file. */
    val docId: String?,
    val tabs: List<String>,
    val headings: List<String>,
    /** CSP sources (`'sha256-…'`) of the inline scripts; empty for a foreign file. */
    val scriptHashes: List<String>,
)

/** Outcome of one import. */
sealed interface ImportResult {
    data class Imported(
        val entry: DocEntry,
    ) : ImportResult

    data class Skipped(
        val reason: String,
    ) : ImportResult
}

/**
 * Imports exported documents (16 §7) and inspects HTML for the reader's CSP (16 §6.3).
 *
 * The inspection is deliberately strict and fails closed: anything that is not clearly an ELI5
 * document is a foreign file, served with `script-src 'none'` and JavaScript off.
 */
class HtmlImporter(
    private val store: DocStore,
    private val index: LibraryIndex,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** Stores [bytes] and records them in the index. */
    suspend fun import(
        bytes: ByteArray,
        displayName: String?,
    ): ImportResult {
        if (bytes.isEmpty()) return ImportResult.Skipped("empty file")
        if (bytes.size > MAX_BYTES) return ImportResult.Skipped("larger than ${MAX_BYTES / (1024 * 1024)} MiB")
        val html = bytes.toString(Charsets.UTF_8)
        if (!looksLikeHtml(html)) return ImportResult.Skipped("not an HTML file")
        val inspection = inspect(html, fallbackTitle(displayName))
        val sha = DocStore.sha256Hex(bytes)
        val key = DocStore.importedKey(sha)
        val entry =
            DocEntry(
                key = key,
                sha = sha,
                title = inspection.title,
                docId = inspection.docId,
                foreign = !inspection.isEli5,
                updatedAt = clock(),
                tabs = inspection.tabs,
                headings = inspection.headings,
            )
        // A newer import of the same ELI5 document replaces the older copy, and a copy synced from the
        // Mac wins over any import (16 §6.4).
        return when (val r = index.saveImport(entry, if (inspection.isEli5) modelText(html) else "") { store.write(key, bytes) }) {
            is LibraryIndex.ImportSave.Saved -> {
                r.replaced.filter { it != key }.forEach { store.delete(it) }
                ImportResult.Imported(entry)
            }
            LibraryIndex.ImportSave.AlreadySynced -> ImportResult.Skipped("already in the library from your Mac")
        }
    }

    companion object {
        /** Exported documents with embedded images run to a few MiB; this bounds memory use. */
        const val MAX_BYTES = 64 * 1024 * 1024

        private const val MAX_TITLE = 300
        private val JSON = Json { ignoreUnknownKeys = true }
        private val SCRIPT_RE = Regex("<script\\b([^>]*)>(.*?)</script\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val META_RE = Regex("<meta\\b([^>]*)>", RegexOption.IGNORE_CASE)
        private val TITLE_RE = Regex("<title\\b[^>]*>(.*?)</title\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val IFRAME_RE = Regex("<iframe\\b([^>]*)>", RegexOption.IGNORE_CASE)

        /** The desktop's animation frame attributes, in order (src/main/document/animation). */
        private val FRAME_ATTRS = listOf("sandbox", "srcdoc", "title", "referrerpolicy", "loading", "aria-describedby")
        private val ATTR_RE = Regex("([A-Za-z_:][-A-Za-z0-9_:.]*)\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))")

        // Same set as the desktop validator (src/main/document/validity.ts, JS_TYPES).
        private val JS_TYPES = Regex("^(|module|(text|application)/(x-)?(java|ecma)script)$", RegexOption.IGNORE_CASE)

        /** Reads the embedded model and decides ELI5 versus foreign. Pure; safe on any input. */
        fun inspect(
            html: String,
            fallbackTitle: String = "Untitled",
        ): Inspection {
            val scripts = SCRIPT_RE.findAll(html).map { attributes(it.groupValues[1]) to it.groupValues[2] }.toList()
            val htmlTitle = TITLE_RE.find(html)?.groupValues?.get(1)?.let(::decodeEntities)?.let(::clean)
            val foreign =
                Inspection(
                    isEli5 = false,
                    title = htmlTitle?.takeIf { it.isNotEmpty() } ?: fallbackTitle,
                    docId = null,
                    tabs = emptyList(),
                    headings = emptyList(),
                    scriptHashes = emptyList(),
                )

            val modelScripts = scripts.filter { (a, _) -> a["id"] == "eli5-model" }
            if (modelScripts.size != 1) return foreign
            val (modelAttrs, modelBody) = modelScripts.single()
            if (modelAttrs["type"]?.lowercase() != "application/json") return foreign
            val model = runCatching { JSON.parseToJsonElement(modelBody) as? JsonObject }.getOrNull() ?: return foreign
            val formatVersion = (model["formatVersion"] as? JsonPrimitive)?.intOrNull ?: return foreign
            val docId = model.string("docId")?.takeIf { it.isNotBlank() } ?: return foreign
            val title = model.string("title") ?: return foreign
            val tabs = (model["tabs"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return foreign
            if (formatVersion < 1 || tabs.size < 2) return foreign

            val frameHashes = animationFrameHashes(html) ?: return foreign
            val hashes =
                scripts
                    .filter { (a, _) -> a["src"] == null && JS_TYPES.matches(a["type"]?.trim() ?: "") }
                    .map { (_, body) -> scriptHash(body) } + frameHashes
            val cspMetas =
                META_RE
                    .findAll(html)
                    .map { attributes(it.groupValues[1]) }
                    .filter { it["http-equiv"]?.lowercase() == "content-security-policy" }
                    .toList()
            if (cspMetas.size != 1) return foreign
            val scriptSrc = directive(cspMetas.single()["content"] ?: "", "script-src") ?: return foreign
            if (!hashes.all { it in scriptSrc }) return foreign

            return Inspection(
                isEli5 = true,
                title = clean(title).ifEmpty { foreign.title },
                docId = docId,
                tabs = tabs.mapNotNull { it.string("label")?.let(::clean) },
                headings =
                    tabs.flatMap { tab ->
                        (tab["sections"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.string("heading")?.let(::clean) }
                    },
                scriptHashes = hashes.distinct(),
            )
        }

        /**
         * The script hashes of every animation frame (07 section 7.1), or null when any `<iframe>`
         * is not exactly the desktop's shape: attributes [FRAME_ATTRS] with `sandbox="allow-scripts"`
         * and a srcdoc holding two plain inline scripts that its own CSP pins. A srcdoc document
         * inherits the reader's CSP header, so these hashes go into the header with the runtime's.
         */
        private fun animationFrameHashes(html: String): List<String>? {
            val out = mutableListOf<String>()
            for (m in IFRAME_RE.findAll(html)) {
                val a = attributes(m.groupValues[1])
                val names = ATTR_RE.findAll(m.groupValues[1]).map { it.groupValues[1].lowercase() }.toList()
                if (names != FRAME_ATTRS || a["sandbox"] != "allow-scripts") return null
                val doc = a["srcdoc"] ?: return null
                val inner = SCRIPT_RE.findAll(doc).map { attributes(it.groupValues[1]) to it.groupValues[2] }.toList()
                if (inner.size != 2 || inner.any { (attrs, _) -> attrs.isNotEmpty() }) return null
                val innerHashes = inner.map { (_, body) -> scriptHash(body) }
                val innerCsp =
                    META_RE
                        .findAll(doc)
                        .map { attributes(it.groupValues[1]) }
                        .filter { it["http-equiv"]?.lowercase() == "content-security-policy" }
                        .toList()
                if (innerCsp.size != 1) return null
                if (directive(innerCsp.single()["content"] ?: "", "script-src") != innerHashes) return null
                out += innerHashes
            }
            return out
        }

        /**
         * The plain text of an ELI5 document's embedded model, for the search index (16 §6.4): title,
         * dek, headings and the prose of every block. Empty for anything without a model. Bounded.
         */
        fun modelText(html: String): String {
            val body =
                SCRIPT_RE
                    .findAll(html)
                    .firstOrNull { attributes(it.groupValues[1])["id"] == "eli5-model" }
                    ?.groupValues
                    ?.get(2) ?: return ""
            val model = runCatching { JSON.parseToJsonElement(body) }.getOrNull() ?: return ""
            val out = StringBuilder()
            collectText(model, inText = false, out)
            return plain(out.toString()).take(MAX_MODEL_TEXT)
        }

        private fun collectText(
            e: JsonElement,
            inText: Boolean,
            out: StringBuilder,
        ) {
            if (out.length > MAX_MODEL_TEXT) return
            when (e) {
                is JsonObject -> e.forEach { (k, v) -> collectText(v, k in TEXT_KEYS, out) }
                is JsonArray -> e.forEach { collectText(it, inText, out) }
                is JsonPrimitive -> if (inText && e.isString) out.append(e.content).append('\n')
            }
        }

        /** Markdown and tags out, entities decoded, whitespace collapsed. */
        private fun plain(s: String): String =
            decodeEntities(s.replace(TAG_RE, " "))
                .replace(MARKDOWN_RE, " ")
                .replace(Regex("\\s+"), " ")
                .trim()

        private const val MAX_MODEL_TEXT = 200_000
        private val TEXT_KEYS =
            setOf(
                "title", "dek", "heading", "md", "paragraphs", "question", "quote", "topic", "text", "items",
                "caption", "subtitle", "term", "explanation", "expansion",
            )
        private val TAG_RE = Regex("<[^>]{0,500}>")
        private val MARKDOWN_RE = Regex("[*_`#>|\\[\\]]+")

        /** The CSP source expression for an inline script body, hashed exactly as the browser does. */
        fun scriptHash(body: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(body.toByteArray(Charsets.UTF_8))
            return "'sha256-${Base64.getEncoder().encodeToString(digest)}'"
        }

        private fun looksLikeHtml(text: String): Boolean {
            val head = text.take(4096).trimStart('\uFEFF', ' ', '\t', '\r', '\n').lowercase()
            return head.startsWith("<!doctype html") || head.startsWith("<html") || "<html" in head || "<head" in head || "<body" in head
        }

        private fun fallbackTitle(displayName: String?): String =
            displayName
                ?.substringAfterLast('/')
                ?.removeSuffix(".html")
                ?.removeSuffix(".htm")
                ?.let(::clean)
                ?.takeIf { it.isNotEmpty() && it != "index" }
                ?: "Untitled"

        private fun attributes(raw: String): Map<String, String> =
            ATTR_RE.findAll(raw).associate { m ->
                val v = m.groups[3]?.value ?: m.groups[4]?.value ?: m.groups[5]?.value ?: ""
                m.groupValues[1].lowercase() to decodeEntities(v)
            }

        private fun directive(
            policy: String,
            name: String,
        ): List<String>? =
            policy
                .split(';')
                .map { it.trim().split(Regex("\\s+")) }
                .firstOrNull { it.firstOrNull()?.lowercase() == name }
                ?.drop(1)

        private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        private fun clean(s: String): String =
            s
                .replace(Regex("\\s+"), " ")
                .trim()
                .take(MAX_TITLE)

        private val ENTITY_RE = Regex("&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos);")

        internal fun decodeEntities(s: String): String =
            if ('&' !in s) {
                s
            } else {
                ENTITY_RE.replace(s) { m ->
                    when (val e = m.groupValues[1]) {
                        "amp" -> "&"
                        "lt" -> "<"
                        "gt" -> ">"
                        "quot" -> "\""
                        "apos" -> "'"
                        else -> {
                            val cp = if (e[1] == 'x' || e[1] == 'X') e.substring(2).toIntOrNull(16) else e.substring(1).toIntOrNull()
                            if (cp != null && Character.isValidCodePoint(cp)) String(Character.toChars(cp)) else m.value
                        }
                    }
                }
            }
    }
}
