package io.github.eli5learner.ask

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Ask sheet (16 §6.2): a section from the outline and a one-line question, then Send. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1400dp")
class AskSheetTest {
    @get:Rule val compose = createComposeRule()

    private val sections =
        listOf(
            OutlineSection("sec-indepth-001ce0e7", "Why ad spend is judged by ROAS", "In depth", "a".repeat(64)),
            OutlineSection("sec-eli5-aa296fff", "Money in, money out", "ELI5", "b".repeat(64)),
        )

    @Test fun `send needs a section and a question of at least three characters`() {
        val sent = mutableListOf<Pair<String, String>>()
        compose.setContent { Eli5Theme { AskSheetContent(sections, { s, q -> sent += s.id to q }) } }
        val send = compose.onNode(hasText("Send to my Mac") and hasClickAction())
        send.assertIsNotEnabled()
        compose.onNodeWithText("Money in, money out").performClick()
        send.assertIsNotEnabled()
        compose.onNode(hasSetTextAction()).performTextInput("  Where does   it go? ")
        send.assertIsEnabled()
        send.performClick()
        assertEquals(listOf("sec-eli5-aa296fff" to "Where does it go?"), sent)
    }

    @Test fun `a document without sections says so`() {
        compose.setContent { Eli5Theme { AskSheetContent(emptyList(), { _, _ -> }) } }
        compose.onNodeWithText("This document has no sections to ask about.").assertExists()
    }
}
