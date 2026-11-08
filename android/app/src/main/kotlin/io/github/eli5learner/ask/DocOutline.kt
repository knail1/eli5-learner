package io.github.eli5learner.ask

import io.github.eli5learner.data.DocStore
import io.github.eli5learner.sync.protocol.Patterns
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One section a phone question can be about (16 §6.2 Ask: "section picker from the document outline"). */
data class OutlineSection(
    val id: String,
    val heading: String,
    /** The tab's label, for grouping in the picker. */
    val tab: String,
    /** 08 §6.3 `sectionHash`: the desktop refuses the ask with `E_STALE` when it no longer matches. */
    val hash: String,
)

/**
 * The outline of an ELI5 document, read from its embedded model (`#eli5-model`), with each
 * section's 08 §6.3 hash: the SHA-256 of the section's canonical JSON (keys sorted by UTF-16 code
 * unit at every level, written as JavaScript's `JSON.stringify` writes it). The desktop hashes the
 * parsed model; for documents it wrote, that equals the embedded JSON, which the shared
 * `section-hashes.json` contract checks on both sides. Reference sections are left out (the
 * desktop never asks about them, 08 §5.3).
 */
object DocOutline {
    private val SCRIPT_RE = Regex("<script\\b([^>]*)>(.*?)</script\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val ID_ATTR = Regex("\\bid\\s*=\\s*(\"eli5-model\"|'eli5-model'|eli5-model(?=[\\s>]|$))", RegexOption.IGNORE_CASE)
    private val JSON = Json { isLenient = false }

    /**
     * Every askable section, in document order; empty for a foreign file or an unreadable model.
     * Parses the whole document, so callers run it off the main thread.
     */
    fun of(html: String): List<OutlineSection> =
        try {
            outline(html)
        } catch (_: StackOverflowError) {
            // A pathologically nested model: nothing to ask about, never a crash.
            emptyList()
        }

    private fun outline(html: String): List<OutlineSection> {
        val body =
            SCRIPT_RE.findAll(html).filter { ID_ATTR.containsMatchIn(it.groupValues[1]) }.toList().singleOrNull()?.groupValues?.get(2)
                ?: return emptyList()
        val model = runCatching { JSON.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return emptyList()
        val tabs = model["tabs"] as? JsonArray ?: return emptyList()
        val out = mutableListOf<OutlineSection>()
        for (t in tabs) {
            val tab = t as? JsonObject ?: continue
            val label = tab.string("label").orEmpty()
            for (s in (tab["sections"] as? JsonArray).orEmpty()) {
                val sec = s as? JsonObject ?: continue
                val id = sec.string("id") ?: continue
                if (!Patterns.SECTION_ID.matches(id) || sec.string("kind") == "references") continue
                val heading = sec.string("heading")?.trim().orEmpty()
                out += OutlineSection(id = id, heading = heading, tab = label, hash = sectionHash(sec))
            }
        }
        return out
    }

    /** SHA-256 hex of [canonicalJson]. */
    fun sectionHash(section: JsonElement): String = DocStore.sha256Hex(canonicalJson(section).toByteArray(Charsets.UTF_8))

    /**
     * The desktop's `canonicalJson` (src/main/document/canonical-json.ts): `JSON.stringify` with
     * object keys sorted, numbers written as JavaScript writes them ([jsNumber]).
     */
    fun canonicalJson(e: JsonElement): String = StringBuilder().also { write(e, it) }.toString()

    private fun write(
        e: JsonElement,
        out: StringBuilder,
    ) {
        when (e) {
            is JsonNull -> out.append("null")
            is JsonPrimitive ->
                when {
                    e.isString -> quote(e.content, out)
                    e.content == "true" || e.content == "false" -> out.append(e.content)
                    else -> out.append(jsNumber(e.content))
                }
            is JsonArray -> {
                out.append('[')
                e.forEachIndexed { i, v ->
                    if (i > 0) out.append(',')
                    write(v, out)
                }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                jsKeyOrder(e.keys).forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    quote(k, out)
                    out.append(':')
                    write(e.getValue(k), out)
                }
                out.append('}')
            }
        }
    }

    private val ARRAY_INDEX = Regex("^(0|[1-9][0-9]{0,9})$")

    /**
     * The order `JSON.stringify` writes the desktop's sorted object in: `Object.keys(v).sort()` sorts
     * by UTF-16 code unit (as [String.compareTo] does), but a JavaScript object enumerates array-index
     * keys (canonical integers below 2^32 - 1) first, in numeric order, whatever the insertion order.
     */
    fun jsKeyOrder(keys: Collection<String>): List<String> {
        val (indices, names) = keys.partition { ARRAY_INDEX.matches(it) && it.toLong() < 4_294_967_295L }
        return indices.sortedBy { it.toLong() } + names.sorted()
    }

    private val SMALL_INT = Regex("^-?(0|[1-9][0-9]{0,14})$")

    /**
     * A JSON number literal as JavaScript's `Number.prototype.toString` writes it (ECMA-262
     * Number::toString): the shortest round-tripping digits, plain notation for exponents from -7 to
     * 20, otherwise `d.ddde±n`. Small integers, the common case, pass through unchanged.
     */
    fun jsNumber(literal: String): String {
        if (SMALL_INT.matches(literal)) return if (literal == "-0") "0" else literal
        val d = literal.toDoubleOrNull() ?: return literal
        if (d == 0.0) return "0"
        if (d.isInfinite() || d.isNaN()) return "null"
        val dec = shortest(d)
        val neg = dec.signum() < 0
        val digits = dec.unscaledValue().abs().toString()
        val k = digits.length
        val n = k - dec.scale() // value = 0.digits × 10^n
        val body =
            when {
                n in k..21 -> digits + "0".repeat(n - k)
                n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
                n in -5..0 -> "0." + "0".repeat(-n) + digits
                else -> {
                    val e = n - 1
                    val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
                    mantissa + "e" + (if (e >= 0) "+" else "-") + kotlin.math.abs(e)
                }
            }
        return if (neg) "-$body" else body
    }

    /**
     * The fewest significant digits that read back as [d], the closest such value when several have
     * that length (ECMA-262 Number::toString step 5). Computed here rather than taken from
     * [Double.toString], whose digits are only shortest on JDK 19+, not on every Android runtime.
     */
    private fun shortest(d: Double): BigDecimal {
        val exact = BigDecimal(d)
        for (p in 1..17) {
            // The round-tripping values form an interval around d, so the best p-digit one is a
            // neighbour of d. Both are tried: below a power of two the interval is lopsided, and the
            // nearest neighbour may miss it while the other lands in it (2^-44 is 5.684341886080802e-14).
            val best =
                listOf(RoundingMode.FLOOR, RoundingMode.CEILING)
                    .map { exact.round(MathContext(p, it)) }
                    .filter { it.toDouble() == d }
                    // Closest first; on a tie, the even digit (Number::toString's rule).
                    .minWithOrNull(compareBy({ it.subtract(exact).abs() }, { it.unscaledValue().testBit(0) }))
            if (best != null) return best.stripTrailingZeros()
        }
        return exact.round(MathContext(17, RoundingMode.HALF_EVEN)).stripTrailingZeros()
    }

    /** JSON.stringify's string quoting, including `\u` escapes for lone surrogates (ES2019). */
    private fun quote(
        s: String,
        out: StringBuilder,
    ) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000c' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u").append("%04x".format(c.code))
                c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                    out.append(c).append(s[i + 1])
                    i++
                }
                c.isSurrogate() -> out.append("\\u").append("%04x".format(c.code))
                else -> out.append(c)
            }
            i++
        }
        out.append('"')
    }

    private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}
