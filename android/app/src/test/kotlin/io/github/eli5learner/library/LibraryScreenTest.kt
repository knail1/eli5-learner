package io.github.eli5learner.library

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LibraryScreenTest {
    @get:Rule val compose = createComposeRule()

    private val eli5 =
        DocEntry(key = "local-a", sha = "a".repeat(64), title = "How widgets work", docId = "d1", foreign = false, importedAt = 1, tabs = listOf("In depth", "ELI5"), headings = listOf("Pricing tiers"))
    private val foreign = DocEntry(key = "local-b", sha = "b".repeat(64), title = "Some page", foreign = true, importedAt = 2)

    @Test fun `empty library offers Import`() {
        var imports = 0
        compose.setContent {
            Eli5Theme { LibraryScreen(LibraryUiState(loaded = true), {}, { imports++ }, {}, {}) }
        }
        compose.onNodeWithText("No documents yet").assertIsDisplayed()
        compose.onNodeWithText("Import HTML").performClick()
        assertEquals(1, imports)
    }

    @Test fun `rows show titles and the foreign label, and open on tap`() {
        val opened = mutableListOf<String>()
        compose.setContent {
            Eli5Theme {
                LibraryScreen(LibraryUiState(loaded = true, total = 2, items = listOf(foreign, eli5)), {}, {}, { opened += it.key }, {})
            }
        }
        compose.onNodeWithText("How widgets work").assertIsDisplayed()
        compose.onNodeWithText("Foreign file · scripts off", substring = true).assertIsDisplayed()
        compose.onNodeWithText("How widgets work").performClick()
        assertEquals(listOf("local-a"), opened)
    }

    @Test fun `the row menu removes an entry`() {
        val removed = mutableListOf<String>()
        compose.setContent {
            Eli5Theme { LibraryScreen(LibraryUiState(loaded = true, total = 1, items = listOf(eli5)), {}, {}, {}, { removed += it.key }) }
        }
        compose.onNodeWithContentDescription("More options for How widgets work").performClick()
        compose.onNodeWithText("Remove").performClick()
        assertEquals(listOf("local-a"), removed)
    }

    @Test fun `a search with no match says so`() {
        compose.setContent {
            Eli5Theme { LibraryScreen(LibraryUiState(loaded = true, query = "zzz", total = 1, items = emptyList()), {}, {}, {}, {}) }
        }
        compose.onNodeWithText("Nothing matches your search.").assertIsDisplayed()
    }

    @Test fun `filterEntries matches title, tabs and headings, all terms, any case`() {
        val all = listOf(eli5, foreign)
        assertEquals(all, LibraryViewModel.filterEntries(all, "  "))
        assertEquals(listOf(eli5), LibraryViewModel.filterEntries(all, "PRICING"))
        assertEquals(listOf(eli5), LibraryViewModel.filterEntries(all, "widgets tiers"))
        assertEquals(listOf(foreign), LibraryViewModel.filterEntries(all, "some"))
        assertEquals(emptyList<DocEntry>(), LibraryViewModel.filterEntries(all, "widgets nope"))
    }
}
