package io.github.eli5learner.library

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.FolderEntity
import io.github.eli5learner.sync.MacInfo
import io.github.eli5learner.sync.SyncProblem
import io.github.eli5learner.sync.SyncStatus
import io.github.eli5learner.sync.protocol.InboxState
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
        DocEntry(key = "local-a", sha = "a".repeat(64), title = "How widgets work", docId = "d1", foreign = false, updatedAt = 1, tabs = listOf("In depth", "ELI5"), headings = listOf("Pricing tiers"))
    private val foreign = DocEntry(key = "local-b", sha = "b".repeat(64), title = "Some page", foreign = true, updatedAt = 2)

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

    private val synced =
        DocEntry(
            key = "d2",
            sha = null,
            title = "Synced deck",
            docId = "d2",
            foreign = false,
            updatedAt = 3,
            source = DocumentEntity.SOURCE_SYNCED,
            placement = DocumentEntity.PLACEMENT_FOLDER,
            folderId = "f-00000001",
            unread = true,
            busy = true,
        )

    @Test fun `synced rows show their state and offer Keep offline instead of Remove`() {
        val pins = mutableListOf<Pair<String, Boolean>>()
        compose.setContent {
            Eli5Theme {
                LibraryScreen(
                    LibraryUiState(loaded = true, total = 1, items = listOf(synced)),
                    {},
                    {},
                    {},
                    {},
                    connected = true,
                    onPin = { e, p -> pins += e.key to p },
                )
            }
        }
        compose.onNodeWithText("Your Mac is updating this document", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Not on this phone yet", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("New version").assertIsDisplayed()
        compose.onNodeWithContentDescription("More options for Synced deck").performClick()
        compose.onNodeWithText("Remove").assertDoesNotExist()
        compose.onNodeWithText("Keep offline").performClick()
        assertEquals(listOf("d2" to true), pins)
    }

    @Test fun `the row menu shares a document on this phone`() {
        val shared = mutableListOf<String>()
        compose.setContent {
            Eli5Theme {
                LibraryScreen(LibraryUiState(loaded = true, total = 1, items = listOf(eli5)), {}, {}, {}, {}, onShare = { shared += it.key })
            }
        }
        compose.onNodeWithContentDescription("More options for How widgets work").performClick()
        compose.onNodeWithText("Share").performClick()
        assertEquals(listOf("local-a"), shared)
    }

    @Test fun `a synced document that is not downloaded has no Share`() {
        compose.setContent {
            Eli5Theme {
                LibraryScreen(LibraryUiState(loaded = true, total = 1, items = listOf(synced)), {}, {}, {}, {}, connected = true)
            }
        }
        compose.onNodeWithContentDescription("More options for Synced deck").performClick()
        compose.onNodeWithText("Keep offline").assertIsDisplayed()
        compose.onNodeWithText("Share").assertDoesNotExist()
    }

    @Test fun `a long press opens the row menu`() {
        val opened = mutableListOf<String>()
        compose.setContent {
            Eli5Theme {
                LibraryScreen(LibraryUiState(loaded = true, total = 1, items = listOf(eli5)), {}, {}, { opened += it.key }, {})
            }
        }
        // TalkBack announces the label as an action: "Double-tap and hold to show options for …".
        compose
            .onNode(SemanticsMatcher("long-click label") { it.config.getOrNull(SemanticsActions.OnLongClick)?.label == "show options for How widgets work" })
            .assertExists()
        compose.onNodeWithText("How widgets work").performTouchInput { longClick() }
        compose.onNodeWithText("Share").assertIsDisplayed()
        compose.onNodeWithText("Remove").assertIsDisplayed()
        assertEquals(emptyList<String>(), opened)
    }

    @Test fun `folder chips select a folder`() {
        val picked = mutableListOf<String?>()
        compose.setContent {
            Eli5Theme {
                LibraryScreen(
                    LibraryUiState(loaded = true, total = 1, items = listOf(synced), folders = listOf(FolderEntity("f-00000001", "Marketing", 0))),
                    {},
                    {},
                    {},
                    {},
                    onFolder = { picked += it },
                )
            }
        }
        compose.onNodeWithText("Marketing").performClick()
        compose.onNodeWithText("Unfiled").performClick()
        compose.onNodeWithText("All").performClick()
        assertEquals(listOf("f-00000001", FolderFilter.UNFILED, null), picked)
    }

    @Test fun `the sync icon opens a sheet with the Mac's heartbeat and Sync now`() {
        var refreshes = 0
        val status = SyncStatus(mac = MacInfo("Studio", System.currentTimeMillis() - 120_000, InboxState.OFF, emptyList()), pendingDownloads = 2)
        compose.setContent {
            Eli5Theme {
                LibraryScreen(
                    LibraryUiState(loaded = true, total = 1, items = listOf(eli5), sync = status, lastSyncAt = System.currentTimeMillis()),
                    {},
                    {},
                    {},
                    {},
                    connected = true,
                    onRefresh = { refreshes++ },
                )
            }
        }
        compose.onNodeWithContentDescription("Synced").performClick()
        compose.onNodeWithText("Your Mac was last seen", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Your Mac isn’t taking jobs right now").assertIsDisplayed()
        compose.onNodeWithText("2 documents still to download").assertIsDisplayed()
        compose.onNodeWithText("Sync now").performClick()
        assertEquals(1, refreshes)
    }

    @Test fun `offline shows a quiet icon, and a lost grant the reconnect banner`() {
        compose.setContent {
            Eli5Theme {
                LibraryScreen(
                    LibraryUiState(loaded = true, total = 1, items = listOf(eli5), sync = SyncStatus(problem = SyncProblem.OFFLINE)),
                    {},
                    {},
                    {},
                    {},
                    connected = true,
                )
            }
        }
        compose.onNodeWithContentDescription("Not synced right now").assertIsDisplayed()
        compose.onNodeWithText("Sign in again").assertDoesNotExist()
    }

    @Test fun `connected with no Mac yet says it is waiting`() {
        compose.setContent {
            Eli5Theme { LibraryScreen(LibraryUiState(loaded = true, sync = SyncStatus(waitingForMac = true)), {}, {}, {}, {}, connected = true) }
        }
        compose.onNodeWithText("Waiting for your Mac…").assertIsDisplayed()
    }

    @Test fun `filterEntries applies folder chips and full-text hits, and hides archived documents from All`() {
        val archived = synced.copy(key = "d3", title = "Old", placement = DocumentEntity.PLACEMENT_ARCHIVE, folderId = null)
        val all = listOf(eli5, synced, archived)
        val folders = setOf("f-00000001")
        assertEquals(listOf(eli5, synced), LibraryViewModel.filterEntries(all, "", folderIds = folders))
        assertEquals(listOf(synced), LibraryViewModel.filterEntries(all, "", folder = "f-00000001", folderIds = folders))
        assertEquals(listOf(eli5), LibraryViewModel.filterEntries(all, "", folder = FolderFilter.UNFILED, folderIds = folders))
        assertEquals(listOf(archived), LibraryViewModel.filterEntries(all, "", folder = FolderFilter.ARCHIVE, folderIds = folders))
        // A body-text hit from the search index matches even when title and headings do not.
        assertEquals(listOf(synced), LibraryViewModel.filterEntries(all, "roas", hits = setOf("d2"), folderIds = folders))
    }
}
