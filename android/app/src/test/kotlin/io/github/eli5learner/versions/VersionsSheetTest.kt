package io.github.eli5learner.versions

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Versions sheet (16 §6.2): current marker, "Not available on this phone", preview and checkout. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1400dp")
class VersionsSheetTest {
    @get:Rule val compose = createComposeRule()

    private val now = 1_800_000_000_000L

    private fun row(
        id: String,
        level: Int = 1,
        current: Boolean = false,
        hasChildren: Boolean = false,
    ) = VersionRow(id, level, null, current, current, hasChildren, hasChildren, false, false, false, 3, 1)

    private val items =
        listOf(
            VersionItem(row("v1", hasChildren = true), "Original", "initial", now - 3_600_000, available = true, sha = "a".repeat(64)),
            VersionItem(row("v2", level = 2), "Went deeper", "deeper", now - 1_800_000, available = false, sha = "b".repeat(64)),
            VersionItem(row("v3", current = true), "Expanded", "expand", now - 60_000, available = true, sha = "c".repeat(64)),
        )

    @Test fun `rows read as versions, unavailable ones say so, and actions report their version`() {
        val previews = mutableListOf<String>()
        val checkouts = mutableListOf<String>()
        val toggles = mutableListOf<String>()
        compose.setContent {
            Eli5Theme {
                VersionsContent(
                    VersionsUiState(loaded = true, docId = "d", title = "Budgets", items = items, canCheckout = true),
                    VersionsActions(onToggle = { toggles += it }, onPreview = { previews += it }, onCheckout = { checkouts += it }),
                    now = now,
                )
            }
        }
        compose.onNodeWithText("Current").assertExists()
        compose.onNodeWithText("Not available on this phone", substring = true).assertExists()
        compose.onNodeWithText("Original").performClick()
        compose.onNodeWithText("Went deeper").performClick()
        assertEquals(listOf("v1"), previews)
        // The current version has no "Make current"; the other two do.
        assertEquals(2, compose.onAllNodesWithText("Make current on your Mac").fetchSemanticsNodes().size)
        compose.onAllNodesWithText("Make current on your Mac")[0].performClick()
        assertEquals(listOf("v1"), checkouts)
        compose.onNodeWithText("Hide branches").performClick()
        assertEquals(listOf("v1"), toggles)
    }

    @Test fun `without checkout support the sheet is read-only`() {
        compose.setContent {
            Eli5Theme {
                VersionsContent(VersionsUiState(loaded = true, docId = "d", items = items, canCheckout = false, busy = true), VersionsActions(), now = now)
            }
        }
        assertEquals(0, compose.onAllNodesWithText("Make current on your Mac").fetchSemanticsNodes().size)
        compose.onNodeWithText("Your Mac is updating this document.").assertExists()
    }

    @Test fun `an empty tree says so`() {
        compose.setContent { Eli5Theme { VersionsContent(VersionsUiState(loaded = true), VersionsActions(), now = now) } }
        compose.onNodeWithText("No versions from your Mac yet.").assertExists()
    }
}
