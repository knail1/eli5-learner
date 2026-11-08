package io.github.eli5learner.ask

import io.github.eli5learner.TestDocs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Ask sheet's outline and section hashes (16 §5.1 `ask.sectionHash`, 08 §6.3) against the
 * shared `section-hashes.json`, which the desktop writes from its own `sectionHash` and Vitest
 * checks against `parseDocument`.
 */
class DocOutlineTest {
    @Serializable
    private data class Sec(
        val id: String,
        val hash: String,
    )

    @Serializable
    private data class Doc(
        val file: String,
        val sections: List<Sec>,
    )

    @Serializable
    private data class Canonical(
        val value: JsonElement,
        val json: String,
        val hash: String,
    )

    @Serializable
    private data class Contract(
        val documents: List<Doc>,
        val canonical: List<Canonical>,
    )

    private val contract: Contract =
        Json.decodeFromString(
            requireNotNull(javaClass.getResourceAsStream("/sync/section-hashes.json")) { "missing section-hashes.json" }
                .use { it.readBytes().toString(Charsets.UTF_8) },
        )

    @Test fun `every section of the desktop's built documents hashes as on the desktop`() {
        assertTrue(contract.documents.size > 3)
        for (d in contract.documents) {
            val html = TestDocs.fixture(d.file).toString(Charsets.UTF_8)
            val outline = DocOutline.of(html)
            val expected = d.sections.associate { it.id to it.hash }
            assertTrue(d.file, outline.isNotEmpty())
            for (s in outline) assertEquals("${d.file} ${s.id}", expected[s.id], s.hash)
            // Reference sections are not offered; every other section is.
            val model = Regex("""id="eli5-model">(.*?)</script>""", RegexOption.DOT_MATCHES_ALL).find(html)!!.groupValues[1]
            val all = (Json.parseToJsonElement(model) as JsonObject)["tabs"] as JsonArray
            val askable =
                all.flatMap { t -> ((t as JsonObject)["sections"] as JsonArray).map { it as JsonObject } }
                    .filter { it["kind"]?.jsonPrimitive?.content != "references" }
                    .map { it["id"]!!.jsonPrimitive.content }
            assertEquals(d.file, askable, outline.map { it.id })
            assertEquals(d.file, d.sections.map { it.id }.filter { it in askable }, outline.map { it.id })
        }
    }

    @Test fun `canonical JSON matches JSON stringify with sorted keys on the edge cases`() {
        assertTrue(contract.canonical.size >= 4)
        for (c in contract.canonical) {
            assertEquals(c.json, DocOutline.canonicalJson(c.value))
            assertEquals(c.hash, DocOutline.sectionHash(c.value))
        }
    }

    @Test fun `numbers are written as JavaScript writes them`() {
        val cases =
            mapOf(
                "0" to "0", "-0" to "0", "42" to "42", "1.50" to "1.5", "1E3" to "1000", "1e21" to "1e+21",
                "1.5e300" to "1.5e+300", "0.000001" to "0.000001", "0.0000001" to "1e-7", "-2.5E-8" to "-2.5e-8",
                "123456789012345678901" to "123456789012345680000", "0.1" to "0.1", "100.0" to "100",
                // Shortest round-tripping digits, independent of the runtime's Double.toString.
                "0.19999999999999998" to "0.19999999999999998", "5e-324" to "5e-324", "2e-3" to "0.002",
                "1.7976931348623157e308" to "1.7976931348623157e+308", "5.684341886080802e-14" to "5.684341886080802e-14",
                "1e23" to "1e+23", "9007199254740993" to "9007199254740992",
            )
        for ((literal, js) in cases) assertEquals(literal, js, DocOutline.jsNumber(literal))
    }

    @Test fun `keys are ordered as a JavaScript object enumerates them`() {
        assertEquals(
            listOf("2", "10", "4294967294", "", "01", "4294967295", "B", "a", "é"),
            DocOutline.jsKeyOrder(listOf("a", "10", "é", "01", "B", "4294967295", "2", "", "4294967294")),
        )
    }

    @Test fun `a deeply nested model is not a crash`() {
        val deep = "[".repeat(200_000) + "]".repeat(200_000)
        val html = """<script type="application/json" id="eli5-model">{"tabs":[{"sections":[{"id":"s-a","x":$deep}]}]}</script>"""
        // Either the parser refuses it or the hash is computed; never a StackOverflowError.
        DocOutline.of(html)
    }

    @Test fun `a foreign file or a broken model has no outline`() {
        assertEquals(emptyList<OutlineSection>(), DocOutline.of(TestDocs.foreign()))
        assertEquals(emptyList<OutlineSection>(), DocOutline.of("""<script type="application/json" id="eli5-model">{not json</script>"""))
        // Sections without a valid id cannot be asked about.
        assertEquals(emptyList<OutlineSection>(), DocOutline.of(TestDocs.eli5()))
    }

    @Test fun `questions are one line, trimmed, at least 3 and at most 500 code points`() {
        assertEquals("Why so?", AskQuestion.normalize("  Why\n so?  "))
        assertNull(AskQuestion.normalize(" a\n "))
        val long = "😀".repeat(600)
        val cut = AskQuestion.normalize(long)!!
        assertEquals(500, cut.codePointCount(0, cut.length))
    }
}
