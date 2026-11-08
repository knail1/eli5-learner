package io.github.eli5learner.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Types come from the bytes (16 §5.1), not from what the sharing app declared. */
class MimeSnifferTest {
    private fun zip(vararg names: String): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for (n in names) {
                z.putNextEntry(ZipEntry(n))
                z.write("<x/>".toByteArray())
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    @Test fun `images, PDF and Office files are recognised by their bytes`() {
        assertEquals(MimeSniffer.PNG, MimeSniffer.sniff(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0)))
        assertEquals(MimeSniffer.JPEG, MimeSniffer.sniff(bytes(0xFF, 0xD8, 0xFF, 0xE0, 0)))
        assertEquals(MimeSniffer.GIF, MimeSniffer.sniff("GIF89a....".toByteArray()))
        assertEquals(MimeSniffer.WEBP, MimeSniffer.sniff("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray()))
        assertEquals(MimeSniffer.HEIC, MimeSniffer.sniff(bytes(0, 0, 0, 0x18) + "ftypheic\u0000\u0000\u0000\u0000".toByteArray()))
        assertEquals(MimeSniffer.TIFF, MimeSniffer.sniff(bytes(0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0)))
        assertEquals(MimeSniffer.BMP, MimeSniffer.sniff("BM".toByteArray() + ByteArray(30)))
        assertEquals(MimeSniffer.PDF, MimeSniffer.sniff("%PDF-1.7\n...".toByteArray()))
        assertEquals(MimeSniffer.PPTX, MimeSniffer.sniff(zip("[Content_Types].xml", "ppt/presentation.xml")))
        assertEquals(MimeSniffer.DOCX, MimeSniffer.sniff(zip("[Content_Types].xml", "word/document.xml")))
        assertEquals(MimeSniffer.XLSX, MimeSniffer.sniff(zip("[Content_Types].xml", "xl/workbook.xml")))
    }

    @Test fun `a wrong declared type does not matter, the bytes decide`() {
        // Declared as an image, actually a PDF: sent as a PDF.
        assertEquals(MimeSniffer.PDF, MimeSniffer.sniff("%PDF-1.4 body".toByteArray(), declared = "image/png", name = "photo.png"))
        // Declared as a PDF, actually a Windows program: refused.
        assertNull(MimeSniffer.sniff(bytes(0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00), declared = "application/pdf", name = "a.pdf"))
        // A plain zip, an AVIF image and an empty file are refused.
        assertNull(MimeSniffer.sniff(zip("readme.txt")))
        assertNull(MimeSniffer.sniff(bytes(0, 0, 0, 0x1C) + "ftypavif\u0000\u0000\u0000\u0000".toByteArray()))
        assertNull(MimeSniffer.sniff(ByteArray(0)))
    }

    @Test fun `text is UTF-8 without NULs, the declared type or name picks Markdown or CSV`() {
        assertEquals(MimeSniffer.TEXT, MimeSniffer.sniff("hello, world".toByteArray(), declared = "text/plain"))
        assertEquals(MimeSniffer.MARKDOWN, MimeSniffer.sniff("# Notes".toByteArray(), name = "notes.md"))
        assertEquals(MimeSniffer.CSV, MimeSniffer.sniff("a,b\n1,2".toByteArray(), declared = "text/csv"))
        assertEquals(MimeSniffer.HTML, MimeSniffer.sniff("<!DOCTYPE html><html></html>".toByteArray(), declared = "text/plain"))
        assertNull(MimeSniffer.sniff(bytes(0x68, 0x00, 0x69)))
        assertNull(MimeSniffer.sniff(bytes(0xC3, 0x28, 0x41)))
        // A long text whose probe cuts a multi-byte character in half is still text.
        val long = ("é".repeat(40_000)).toByteArray()
        assertEquals(MimeSniffer.TEXT, MimeSniffer.sniff(long))
    }
}
