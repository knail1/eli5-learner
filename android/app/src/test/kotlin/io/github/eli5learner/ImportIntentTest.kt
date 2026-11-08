package io.github.eli5learner

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ImportIntentTest {
    private val uri = Uri.parse("content://com.example.files/doc/1")

    @Test fun `VIEW and SEND carry the file to import`() {
        assertEquals(listOf(uri), MainActivity.importUris(Intent(Intent.ACTION_VIEW, uri)))
        val send = Intent(Intent.ACTION_SEND).setType("text/html").putExtra(Intent.EXTRA_STREAM, uri)
        assertEquals(listOf(uri), MainActivity.importUris(send))
    }

    @Test fun `SEND without a stream imports nothing, other actions are not imports`() {
        assertEquals(emptyList<Uri>(), MainActivity.importUris(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "<html>")))
        assertNull(MainActivity.importUris(Intent(Intent.ACTION_MAIN)))
        assertNull(MainActivity.importUris(null))
    }

    @Test fun `an intent relaunched from Recents is not imported again`() {
        val again = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertNull(MainActivity.importUris(again))
    }
}
