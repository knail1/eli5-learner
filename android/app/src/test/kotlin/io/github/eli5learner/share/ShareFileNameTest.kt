package io.github.eli5learner.share

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** File names for shared documents (16 §6.5). */
class ShareFileNameTest {
    private fun base(name: String) = name.removeSuffix(ShareFileName.EXTENSION)

    private fun assertSafe(name: String) {
        assertTrue(name, name.endsWith(".html"))
        assertFalse(name, name.startsWith("."))
        for (bad in listOf("/", "\\", "\u0000", "‮", "​", "\n", "\t", ":", "*", "?", "\"", "<", ">", "|")) {
            assertFalse("$name contains ${bad.codePointAt(0)}", name.contains(bad))
        }
        // No lone surrogates: the name round-trips through UTF-8.
        assertEquals(name, String(name.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
    }

    @Test fun `a plain title becomes the file name`() {
        assertEquals("How widgets work.html", ShareFileName.of("How widgets work", "doc-1"))
    }

    @Test fun `separators and reserved characters become single spaces`() {
        val name = ShareFileName.of("a/b\\c:d*e?f\"g<h>i|j", "doc-1")
        assertEquals("a b c d e f g h i j.html", name)
        assertSafe(name)
    }

    @Test fun `controls, whitespace runs and format characters are removed or collapsed`() {
        assertEquals("Line one Line two.html", ShareFileName.of("Line\u0000 one\n\n\tLine\u0007 two", "doc-1"))
        val rlo = ShareFileName.of("evil‮lmth.exe", "doc-1")
        assertFalse(rlo.contains("‮"))
        assertEquals("evillmth.exe.html", rlo)
        assertEquals("zerowidth.html", ShareFileName.of("zero​width", "doc-1"))
        assertEquals("para graph.html", ShareFileName.of("para graph", "doc-1"))
    }

    @Test fun `leading dots are dropped and nothing usable falls back`() {
        assertEquals("hidden.html", ShareFileName.of(".hidden", "doc-1"))
        for (t in listOf("..", ".", "   ", "///", "", "‮​")) {
            assertEquals("for '$t'", "doc-1.html", ShareFileName.of(t, "doc-1"))
        }
        assertEquals("document.html", ShareFileName.of("  ", ""))
        assertEquals("document.html", ShareFileName.of("..", "../"))
    }

    @Test fun `an html suffix is not doubled`() {
        assertEquals("Report.html", ShareFileName.of("Report.html", "doc-1"))
        assertEquals("Report.html", ShareFileName.of("Report.HTM", "doc-1"))
        assertEquals("Report.html", ShareFileName.of("Report. .html", "doc-1"))
    }

    @Test fun `long titles are capped by code points without splitting a surrogate pair`() {
        val long = ShareFileName.of("x".repeat(300), "doc-1")
        assertEquals(ShareFileName.MAX_CHARS, base(long).length)

        val emoji = String(Character.toChars(0x1F600))
        val boundary = ShareFileName.of("a".repeat(ShareFileName.MAX_CHARS - 1) + emoji + "tail", "doc-1")
        val b = base(boundary)
        assertEquals(ShareFileName.MAX_CHARS, b.codePointCount(0, b.length))
        assertTrue(b.endsWith(emoji))
        assertSafe(boundary)
    }

    @Test fun `multi-byte titles respect the UTF-8 byte cap`() {
        val emoji = String(Character.toChars(0x1F600)) // 4 bytes in UTF-8
        val name = ShareFileName.of(emoji.repeat(ShareFileName.MAX_CHARS), "doc-1")
        val b = base(name)
        assertTrue(b.toByteArray(Charsets.UTF_8).size <= ShareFileName.MAX_BYTES)
        assertEquals(ShareFileName.MAX_BYTES / 4, b.codePointCount(0, b.length))
        assertSafe(name)
    }

    @Test fun `combining characters are normalized`() {
        assertEquals("Café.html", ShareFileName.of("Café", "doc-1"))
    }
}
