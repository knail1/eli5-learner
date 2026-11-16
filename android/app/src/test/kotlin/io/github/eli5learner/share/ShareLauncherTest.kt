package io.github.eli5learner.share

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.material3.SnackbarHostState
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.core.content.IntentCompat
import io.github.eli5learner.MainActivity
import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.inMemoryDb
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/** The Share callback: snackbars for failures, the busy guard, and the chooser launch (16 §6.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
@OptIn(ExperimentalCoroutinesApi::class)
class ShareLauncherTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var store: DocStore
    private lateinit var index: LibraryIndex
    private val snackbar = SnackbarHostState()
    private lateinit var share: (ShareRequest) -> Unit

    @Before fun setUp() {
        db = inMemoryDb()
        store = DocStore(File(tmp.root, "docs"))
        index = LibraryIndex(db, store)
        FileProviderCache.reset()
    }

    @After fun tearDown() = db.close()

    private fun launch(root: File = File(compose.activity.cacheDir, "share")) {
        // File work runs inline, so each request finishes within one main-looper pass.
        val sharer = DocSharer(store, index, ShareCache(root), UnconfinedTestDispatcher())
        compose.setContent { share = rememberShareDocument(sharer, snackbar) }
        compose.waitForIdle()
    }

    private fun request(
        sha: String,
        key: String = "doc-1",
    ) = compose.runOnIdle { share(ShareRequest(key, sha, "Widgets explained", key)) }

    private fun awaitSnackbar(text: String) {
        compose.waitUntil(5_000) { snackbar.currentSnackbarData?.visuals?.message == text }
    }

    private fun nextStarted(): Intent? = shadowOf(compose.activity).peekNextStartedActivity()

    private fun awaitChooser(): Intent {
        compose.waitUntil(5_000) { nextStarted() != null }
        return shadowOf(compose.activity).nextStartedActivity
    }

    @Test fun `a version that is not on the phone shows the missing snackbar`() {
        launch()
        request("0".repeat(64))
        awaitSnackbar("This document isn’t on this phone.")
        assertNull(nextStarted())
    }

    @Test fun `a copy that cannot be written shows the failed snackbar`() {
        val sha = store.write("doc-1", TestDocs.eli5().toByteArray())
        launch(File(tmp.root, "blocked").apply { writeText("a file, not a folder") })
        request(sha)
        awaitSnackbar("Couldn’t share this document. Try again.")
        assertNull(nextStarted())
    }

    @Test fun `a failure resets the busy guard, so the next Share still runs`() {
        val sha = store.write("doc-1", TestDocs.eli5().toByteArray())
        launch()
        request("0".repeat(64))
        awaitSnackbar("This document isn’t on this phone.")
        compose.runOnIdle { snackbar.currentSnackbarData?.dismiss() }
        request(sha)
        assertEquals(Intent.ACTION_CHOOSER, awaitChooser().action)
    }

    @Test fun `a stored version opens the chooser with a read-only share URI and without this app`() {
        val sha = store.write("doc-1", TestDocs.eli5().toByteArray())
        launch()
        request(sha)
        val chooser = awaitChooser()
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val send = IntentCompat.getParcelableExtra(chooser, Intent.EXTRA_INTENT, Intent::class.java)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/html", send.type)
        val uri = IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java)!!
        assertEquals("content", uri.scheme)
        assertEquals("${compose.activity.packageName}.share", uri.authority)
        assertTrue(uri.path!!.endsWith("/Widgets explained.html"))
        assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(0, send.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val excluded = IntentCompat.getParcelableArrayExtra(chooser, Intent.EXTRA_EXCLUDE_COMPONENTS, ComponentName::class.java)!!
        assertTrue(excluded.any { (it as ComponentName).className == MainActivity::class.java.name })
        assertNull(snackbar.currentSnackbarData)
    }
}
