package io.github.eli5learner.capture

import android.content.Intent
import android.net.Uri
import io.github.eli5learner.sync.protocol.Limits
import io.github.eli5learner.sync.protocol.isHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Share intent parsing (16 §5.1, §5.2): links in text, multiple images, files, and URL rules (16 §12). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ShareInputTest {
    private fun uri(n: Int) = Uri.parse("content://com.example.photos/media/$n")

    @Test fun `a shared link arrives as text, with the page title as subject`() {
        val i =
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "https://example.com/story")
                .putExtra(Intent.EXTRA_SUBJECT, "  A story  ")
        val input = ShareInput.of(i)!!
        assertEquals("https://example.com/story", input.text)
        assertEquals("A story", input.subject)
        assertTrue(input.streams.isEmpty())
        assertFalse(input.isEmpty)
        val t = TextExtractor.extract(input.text)
        assertEquals(listOf("https://example.com/story"), t.urls)
        assertEquals("", t.text)
    }

    @Test fun `multiple images arrive as streams, only content URIs are kept`() {
        val i =
            Intent(Intent.ACTION_SEND_MULTIPLE)
                .setType("image/*")
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri(1), uri(2), Uri.parse("file:///data/data/x/secret"), uri(1)))
        val input = ShareInput.of(i)!!
        assertEquals(listOf(uri(1), uri(2)), input.streams)
        assertEquals(2, input.droppedStreams)
    }

    @Test fun `a PDF arrives as one stream`() {
        val pdf = Uri.parse("content://com.example.files/doc/report.pdf")
        val input = ShareInput.of(Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, pdf))!!
        assertEquals(listOf(pdf), input.streams)
        assertEquals("application/pdf", input.type)
    }

    @Test fun `other actions are not shares, an empty share is empty`() {
        assertNull(ShareInput.of(Intent(Intent.ACTION_VIEW)))
        assertNull(ShareInput.of(null))
        assertTrue(ShareInput.of(Intent(Intent.ACTION_SEND).setType("text/plain"))!!.isEmpty)
    }

    @Test fun `a title in front of the link is dropped, long text around links is kept`() {
        val short = TextExtractor.extract("Great read: https://example.com/a.")
        assertEquals(listOf("https://example.com/a"), short.urls)
        assertEquals("", short.text)

        val essay = "word ".repeat(80)
        val long = TextExtractor.extract("$essay\nsee https://example.com/a and (https://example.com/b)")
        assertEquals(listOf("https://example.com/a", "https://example.com/b"), long.urls)
        assertTrue(long.text.startsWith("word word"))
        assertFalse(long.text.contains("https://"))

        val plain = TextExtractor.extract("Just a note to think about")
        assertEquals(emptyList<String>(), plain.urls)
        assertEquals("Just a note to think about", plain.text)
    }

    @Test fun `URLs are normalized into the shape both sides accept`() {
        assertEquals("https://xn--bcher-kva.example/caf%C3%A9?q=a%20b#x", TextExtractor.normalizeUrl("https://Bücher.example/café?q=a b#x"))
        assertEquals("https://example.com/a%7Cb%5B1%5D", TextExtractor.normalizeUrl("HTTPS://EXAMPLE.com/a|b[1]"))
        assertEquals("http://example.com:8080/p%25zz%41", TextExtractor.normalizeUrl("http://example.com:8080/p%zz%41"))
        assertEquals("https://en.wikipedia.org/wiki/Foo_(bar)", TextExtractor.trimUrl("https://en.wikipedia.org/wiki/Foo_(bar))."))
        // A user name or password, a bad port and an empty host are refused.
        // Assembled at runtime: the repository never contains a literal credentialed URL (hygiene check).
        assertNull(TextExtractor.normalizeUrl("https://" + listOf("user", "pw").joinToString(":") + "@example.com/"))
        assertNull(TextExtractor.normalizeUrl("https://example.com:99999/"))
        assertNull(TextExtractor.normalizeUrl("https:///path"))
        for (u in listOf("https://Bücher.example/café?q=a b#x#y", "http://例え.テスト/パス", "https://example.com/\"quoted\"")) {
            val n = TextExtractor.normalizeUrl(u)
            if (n != null) assertTrue(n, isHttpUrl(n))
        }
    }

    @Test fun `more than 20 links are refused beyond the cap, and long text is shortened`() {
        val many = (1..25).joinToString(" ") { "https://example.com/$it" }
        val t = TextExtractor.extract(many)
        assertEquals(Limits.URLS, t.urls.size)
        assertEquals(5, t.refusedUrls)

        val huge = TextExtractor.extract("x".repeat(Limits.TEXT_CHARS + 10))
        assertTrue(huge.shortened)
        assertEquals(Limits.TEXT_CHARS, huge.text.length)
    }

    @Test fun `attachment names lose paths and control characters and carry the right extension`() {
        assertEquals("evilname.pdf", AttachmentNames.sanitize("../evil‮name.pdf", MimeSniffer.PDF, 0))
        assertEquals("photo.jpeg", AttachmentNames.sanitize("photo.jpeg", MimeSniffer.JPEG, 0))
        assertEquals("scan.png.pdf", AttachmentNames.sanitize("scan.png", MimeSniffer.PDF, 0))
        assertEquals("attachment-3.png", AttachmentNames.sanitize("..", MimeSniffer.PNG, 2))
        assertEquals("attachment-1.heic", AttachmentNames.sanitize(null, MimeSniffer.HEIC, 0))
        val long = AttachmentNames.sanitize("a".repeat(300), MimeSniffer.PDF, 0)
        assertEquals(Limits.ATTACHMENT_NAME_CHARS, long.length)
        assertTrue(long.endsWith(".pdf"))
    }
}
