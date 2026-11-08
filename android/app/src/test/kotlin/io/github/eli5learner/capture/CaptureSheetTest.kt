package io.github.eli5learner.capture

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The capture sheet (16 §6.2): preview, refusals, question, focus chips and Send. */
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
        compose.onNodeWithText("What do you want to understand?").performTextInput("Why now?")
        assertEquals("Why now?", question)
        compose.onNodeWithText("The numbers").performClick()
        assertEquals(listOf(FocusChip.NUMBERS), focus)
        compose.onNode(hasText("Send to my Mac") and hasClickAction()).assertIsEnabled().performClick()
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
}
