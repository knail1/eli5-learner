package io.github.eli5learner.share

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import androidx.test.core.app.ApplicationProvider
import io.github.eli5learner.MainActivity
import io.github.eli5learner.capture.CaptureActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The share sheet intents and the FileProvider that serves the copies (16 §6.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ShareIntentsTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val uri: Uri = Uri.parse("content://${ctx.packageName}.share/share/abc/Doc.html")

    @Before fun resetFileProvider() = FileProviderCache.reset()

    @Test fun `send carries the stream, subject, text and a read-only grant`() {
        val i = ShareIntents.send(uri, "T", "msg")
        assertEquals(Intent.ACTION_SEND, i.action)
        assertEquals("text/html", i.type)
        assertEquals(uri, IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java))
        assertEquals("T", i.getStringExtra(Intent.EXTRA_SUBJECT))
        assertEquals("msg", i.getStringExtra(Intent.EXTRA_TEXT))
        assertTrue(i.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(0, i.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        assertEquals(0, i.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        val clip = i.clipData!!
        assertEquals(1, clip.itemCount)
        assertEquals(uri, clip.getItemAt(0).uri)
        assertEquals("text/html", clip.description.getMimeType(0))
    }

    @Test fun `the chooser leaves out this app's own import and capture`() {
        val send = ShareIntents.send(uri, "T", "msg")
        val c = ShareIntents.chooser(send, "Share", ShareIntents.ownTargets(ctx))
        assertEquals(Intent.ACTION_CHOOSER, c.action)
        val inner = IntentCompat.getParcelableExtra(c, Intent.EXTRA_INTENT, Intent::class.java)
        assertEquals(Intent.ACTION_SEND, inner?.action)
        assertEquals(uri, IntentCompat.getParcelableExtra(inner!!, Intent.EXTRA_STREAM, Uri::class.java))
        assertEquals("Share", c.getCharSequenceExtra(Intent.EXTRA_TITLE).toString())
        @Suppress("DEPRECATION")
        val excluded = c.getParcelableArrayExtra(Intent.EXTRA_EXCLUDE_COMPONENTS)!!.map { it as ComponentName }
        assertTrue(ComponentName(ctx, MainActivity::class.java) in excluded)
        assertTrue(ComponentName(ctx, CaptureActivity::class.java) in excluded)
    }

    @Test fun `uriFor serves only copies under cacheDir share`() {
        val staged = ShareCache(File(ctx.cacheDir, "share")).stage("x".toByteArray(), "Doc.html")
        val u = ShareIntents.uriFor(ctx, staged)
        assertEquals("content", u.scheme)
        assertEquals("${ctx.packageName}.share", u.authority)
        assertTrue(u.path!!, u.path!!.startsWith("/share/"))
        assertTrue(u.path!!.endsWith("/Doc.html"))

        val doc = File(ctx.filesDir, "docs/k/x.html").apply { parentFile!!.mkdirs(); writeText("x") }
        val other = File(ctx.cacheDir, "other.html").apply { writeText("x") }
        val escape = File(File(ctx.cacheDir, "share"), "../other.html")
        for (f in listOf(doc, other, escape)) {
            val thrown = runCatching { ShareIntents.uriFor(ctx, f) }.exceptionOrNull()
            assertTrue("for $f: $thrown", thrown is IllegalArgumentException)
        }
    }

    @Test fun `the provider is not exported and grants per URI`() {
        val info = ctx.packageManager.resolveContentProvider(ShareIntents.authority(ctx), 0)
        assertNotNull(info)
        assertFalse(info!!.exported)
        assertTrue(info.grantUriPermissions)
    }
}
