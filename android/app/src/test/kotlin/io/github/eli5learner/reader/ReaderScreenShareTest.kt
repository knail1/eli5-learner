package io.github.eli5learner.reader

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.inMemoryDb
import io.github.eli5learner.ui.theme.Eli5Theme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The Reader's Share button (16 §6.5): which version it sends and when it is hidden. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ReaderScreenShareTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var store: DocStore
    private lateinit var index: LibraryIndex
    private val shared = mutableListOf<Pair<String, String>>()

    @Before fun setUp() {
        db = inMemoryDb()
        store = DocStore(File(tmp.root, "docs"))
        index = LibraryIndex(db, store)
    }

    @After fun tearDown() = db.close()

    private fun show(
        key: String,
        preview: ReaderPreview? = null,
    ) {
        compose.setContent {
            Eli5Theme {
                ReaderScreen(key = key, index = index, store = store, onBack = {}, preview = preview, onShare = { e, sha -> shared += e.key to sha })
            }
        }
    }

    private fun awaitText(text: String) {
        compose.waitUntil(5_000) { compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun shareButtonCount(): Int =
        compose.onAllNodes(hasContentDescription("Share document")).fetchSemanticsNodes().size

    @Test fun `Share sends the stored version on screen`() {
        val sha = store.write("local-a", TestDocs.eli5().toByteArray())
        show("local-a")
        compose.waitUntil(5_000) { shareButtonCount() == 1 }
        compose.onNodeWithContentDescription("Share document").performClick()
        assertEquals(listOf("local-a" to sha), shared)
    }

    @Test fun `while the Updated banner is up, Share sends the version on screen, not the newer one`() {
        val first = store.write("local-a", TestDocs.eli5().toByteArray())
        show("local-a")
        compose.waitUntil(5_000) { shareButtonCount() == 1 }
        val second = store.write("local-a", TestDocs.eli5(script = "document.body.dataset.ok='2';").toByteArray())
        runBlocking { index.write { d -> d.upsert(d.get("local-a")!!.copy(localSha = second)) } }
        awaitText("Updated on your Mac")
        compose.onNodeWithContentDescription("Share document").performClick()
        assertEquals(listOf("local-a" to first), shared)
    }

    @Test fun `a preview of an earlier version has no Share`() {
        val sha = store.write("local-a", TestDocs.eli5().toByteArray())
        show("local-a", preview = ReaderPreview("v1", sha, "Version 1"))
        awaitText("Version 1")
        compose.waitForIdle()
        assertEquals(0, shareButtonCount())
    }

    @Test fun `a synced document that is not on the phone has no Share`() {
        runBlocking {
            index.write { d ->
                d.upsert(
                    DocumentEntity(
                        key = "d1",
                        docId = "d1",
                        source = DocumentEntity.SOURCE_SYNCED,
                        title = "Synced deck",
                        updatedAt = 1,
                        remoteSha = "c".repeat(64),
                        localSha = null,
                    ),
                )
            }
        }
        show("d1")
        awaitText("Synced deck")
        compose.waitForIdle()
        compose.onNodeWithText("Synced deck").assertExists()
        assertEquals(0, shareButtonCount())
    }
}
