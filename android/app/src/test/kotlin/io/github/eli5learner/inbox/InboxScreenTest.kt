package io.github.eli5learner.inbox

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.eli5learner.sync.MacInfo
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Inbox (16 §6.2): chips, stage, reason, actions, the Mac line, and acks of what was shown. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1400dp")
class InboxScreenTest {
    @get:Rule val compose = createComposeRule()

    private val now = 1_800_000_000_000L

    @Test fun `rows show their chips and actions, terminal rows are reported as shown`() {
        val cancelled = mutableListOf<String>()
        val retried = mutableListOf<String>()
        val opened = mutableListOf<String>()
        val shown = mutableListOf<List<String>>()
        val items =
            listOf(
                InboxItem("j1", "example.com", now - 60_000, InboxChip.GENERATING, stage = "Reading 3 sources"),
                InboxItem("j2", "notes.pdf", now - 120_000, InboxChip.WAITING_FOR_MAC, canCancel = true),
                InboxItem("j3", "news.example", now, InboxChip.FAILED, reason = "Your Mac couldn’t read this link", canRetry = true, canDelete = true, terminal = true),
                InboxItem("j4", "story.example", now, InboxChip.BUILT_SKIPPED, skippedSources = 2, openKey = "doc-1", canDelete = true, terminal = true),
            )
        val mac = MacInfo("Studio", now - 5 * 60_000, InboxState.ON, listOf(JobKind.CAPTURE))
        compose.setContent {
            Eli5Theme {
                InboxScreen(
                    InboxUiState(items = items, connected = true, mac = mac, offerNotifications = false),
                    InboxActions(
                        onCancel = { cancelled += it },
                        onRetry = { retried += it },
                        onOpen = { opened += it },
                        onShown = { shown += it },
                    ),
                    now = now,
                )
            }
        }
        compose.onNodeWithText("Generating").assertExists()
        compose.onNodeWithText("Reading 3 sources").assertExists()
        compose.onNodeWithText("Waiting for your Mac").assertExists()
        compose.onNodeWithText("Built · 2 sources skipped").assertExists()
        compose.onNodeWithText("Your Mac couldn’t read this link").assertExists()
        compose.onNodeWithText("Your Mac was last seen", substring = true).assertExists()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Retry").performClick()
        compose.onNodeWithText("Open").performClick()
        assertEquals(listOf("j2"), cancelled)
        assertEquals(listOf("j3"), retried)
        assertEquals(listOf("doc-1"), opened)
        compose.waitForIdle()
        assertEquals(listOf("j3", "j4"), shown.last())
    }

    @Test fun `without Google Drive, waiting captures offer Connect, an empty Inbox explains itself`() {
        var connects = 0
        compose.setContent {
            Eli5Theme {
                InboxScreen(
                    InboxUiState(items = listOf(InboxItem("j1", "", now, InboxChip.CONNECT_TO_SEND, canCancel = true)), connected = false),
                    InboxActions(onConnect = { connects++ }),
                    now = now,
                )
            }
        }
        compose.onNodeWithText("Connect Google Drive to send").assertExists()
        compose.onNodeWithText("Capture").assertExists()
        compose.onNodeWithText("Connect Google Drive").performClick()
        assertEquals(1, connects)
    }

    @Test fun `the empty state and a paused Mac`() {
        val mac = MacInfo("Studio", null, InboxState.OFF, listOf(JobKind.CAPTURE))
        compose.setContent {
            Eli5Theme { InboxScreen(InboxUiState(connected = true, mac = mac), InboxActions(), now = now) }
        }
        compose.onNodeWithText("Share a link, photo or file", substring = true).assertExists()
        compose.onNodeWithText("Your Mac isn’t taking jobs right now").assertExists()
    }
}
