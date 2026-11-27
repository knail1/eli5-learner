package io.github.eli5learner.capture

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ApplicationProvider
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The capture sheet (16 §6.2): preview, refusals, instructions, focus chips, Deadpan and Send; and "Send a link". */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CaptureSheetTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `the preview lists links and files, refusals have a one-line reason, and Send sends`() {
        var sent = 0
        val focus = mutableListOf<FocusChip>()
        var question = ""
        val state =
            CaptureUiState(
                loading = false,
                urls = listOf("https://example.com/story"),
                files = listOf(StagedFile("a".repeat(64), "chart.png", "image/png", 2048)),
                refusals = listOf(Refusal("movie.mov", RefusalReason.TYPE), Refusal("huge.pdf", RefusalReason.TOO_LARGE)),
                connected = true,
            )
        compose.setContent {
            Eli5Theme {
                CaptureSheetContent(state, CaptureActions({ question = it }, { focus += it }, { sent++ }))
            }
        }
        compose.onNodeWithText("https://example.com/story").assertExists()
        compose.onNodeWithText("chart.png", substring = true).assertExists()
        compose.onNodeWithText("movie.mov: this kind of file can’t be sent").assertExists()
        compose.onNodeWithText("huge.pdf: too large (over 20 MB)").assertExists()
        compose.onNodeWithText("Instructions for your Mac (optional)").performTextInput("Why now?")
        assertEquals("Why now?", question)
        compose.onNodeWithText("The numbers").performClick()
        assertEquals(listOf(FocusChip.NUMBERS), focus)
        compose.onNode(hasText("Send to my Mac") and hasClickAction()).performScrollTo().assertIsEnabled().performClick()
        assertEquals(1, sent)
    }

    @Test fun `not connected is a note, not a block, an empty share cannot be sent`() {
        compose.setContent {
            Eli5Theme { CaptureSheetContent(CaptureUiState(loading = false, connected = false), CaptureActions()) }
        }
        compose.onNodeWithText("Google Drive isn’t connected", substring = true).assertExists()
        compose.onNodeWithText("Nothing to send").assertExists()
        compose.onNode(hasText("Send to my Mac") and hasClickAction()).assertIsNotEnabled()
    }

    @Test fun `instructions show their hint and a visible counter`() {
        compose.setContent {
            Eli5Theme { CaptureSheetContent(CaptureUiState(loading = false, connected = true, clarifyingInput = "Keep it short"), CaptureActions()) }
        }
        compose.onNodeWithText("Instructions for your Mac (optional)").assertExists()
        compose.onNodeWithText("13/500").assertExists()
    }

    @Test fun `Send a link has a link field with Paste, and says when the link cannot be sent`() {
        var link = ""
        var done = 0
        val clipboard = ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("link", "  https://example.com/pasted  "))
        var state by mutableStateOf(CaptureUiState(loading = false, connected = true, manual = true))
        compose.setContent {
            Eli5Theme { CaptureSheetContent(state, CaptureActions(onLinkChange = { link = it }, onLinkDone = { done++ })) }
        }
        compose.onAllNodesWithText("Send a link").assertCountEquals(1)
        // Nothing typed yet: no error and no "Nothing to send".
        compose.onNodeWithText("Nothing to send").assertDoesNotExist()
        compose.onNodeWithText("Enter a web link", substring = true).assertDoesNotExist()
        compose.onNode(hasText("Send to my Mac") and hasClickAction()).assertIsNotEnabled()
        compose.onNodeWithText("Link").performTextInput("example.com")
        assertEquals("example.com", link)
        assertEquals("typing is not done", 0, done)
        compose.onNodeWithText("Paste").performClick()
        compose.waitForIdle()
        assertEquals("https://example.com/pasted", link)
        assertEquals("a paste is a whole link", 1, done)

        // Half typed: the field is not an error until the user is done with it.
        state = state.copy(linkInput = "file:///etc/hosts", refusedUrls = 1)
        compose.onNodeWithText("Enter a web link", substring = true).assertDoesNotExist()
        state = state.copy(linkTouched = true)
        compose.onNodeWithText("user name", substring = true).assertExists()
        compose.onNodeWithText("can’t be sent", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Enter a web link that starts with http:// or https://", substring = true).assertExists()
        compose.onNode(hasText("Send to my Mac") and hasClickAction()).assertIsNotEnabled()

        state = state.copy(linkInput = "https://example.com/a", urls = listOf("https://example.com/a"))
        compose.onNodeWithText("Enter a web link", substring = true).assertDoesNotExist()
        compose.onNode(hasText("Send to my Mac") and hasClickAction()).assertIsEnabled()
    }

    @Test fun `the Deadpan switch toggles for a new Mac and is disabled with a note for an older one`() {
        var toggles = 0
        var state by mutableStateOf(CaptureUiState(loading = false, connected = true, urls = listOf("https://example.com/a"), deadpanAvailable = true))
        compose.setContent {
            Eli5Theme { CaptureSheetContent(state, CaptureActions(onToggleDeadpan = { toggles++ })) }
        }
        compose.onNodeWithText("Also write a deadpan, sarcastic retelling", substring = true).assertExists()
        compose.onNode(isToggleable()).assertIsEnabled().assertIsOff().performClick()
        assertEquals(1, toggles)
        state = state.copy(deadpan = true)
        compose.onNode(isToggleable()).assertIsOn()

        state = state.copy(deadpanAvailable = false)
        compose.onNode(isToggleable()).assertIsNotEnabled().assertIsOff()
        compose.onNodeWithText("Needs ELI5 Learner 0.6.0 or later on your Mac.").assertExists()
        compose.onNodeWithText("Deadpan tab").performClick()
        assertEquals(1, toggles)

        // Not read yet (a share cold-started the app): a neutral note, not "needs update".
        state = state.copy(macVersionUnknown = true)
        compose.onNode(isToggleable()).assertIsNotEnabled()
        compose.onNodeWithText("Checking which version your Mac runs…").assertExists()
        compose.onNodeWithText("Needs ELI5 Learner", substring = true).assertDoesNotExist()
    }
}
