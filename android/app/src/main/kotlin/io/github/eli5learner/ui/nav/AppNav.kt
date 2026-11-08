package io.github.eli5learner.ui.nav

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import io.github.eli5learner.AppContainer
import io.github.eli5learner.R
import io.github.eli5learner.inbox.InboxScreen
import io.github.eli5learner.library.LibraryEvent
import io.github.eli5learner.library.LibraryScreen
import io.github.eli5learner.library.LibraryViewModel
import io.github.eli5learner.reader.ReaderScreen
import io.github.eli5learner.settings.SettingsScreen
import kotlinx.serialization.Serializable

@Serializable
data object LibraryKey : NavKey

@Serializable
data object InboxKey : NavKey

@Serializable
data object SettingsKey : NavKey

@Serializable
data class ReaderKey(
    val key: String,
) : NavKey

private enum class TopLevel(
    val key: NavKey,
    val label: Int,
    val icon: Int,
) {
    Library(LibraryKey, R.string.nav_library, R.drawable.ic_library),
    Inbox(InboxKey, R.string.nav_inbox, R.drawable.ic_inbox),
    Settings(SettingsKey, R.string.nav_settings, R.drawable.ic_settings),
}

/**
 * Navigation 3 with a navigation suite (bar on phones, rail on wider windows): Library, Inbox,
 * Settings; the reader is pushed on top and hides the suite (16 §6.2).
 */
@Composable
fun AppNav(
    container: AppContainer,
    library: LibraryViewModel,
) {
    val backStack = rememberNavBackStack(LibraryKey)
    val state by library.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val resources = LocalResources.current
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            if (uris.isNotEmpty()) library.import(uris)
        }
    val onImport = { picker.launch(arrayOf("text/html")) }

    LaunchedEffect(library) {
        library.messages.collect { e ->
            val text =
                when (e) {
                    is LibraryEvent.Imported ->
                        if (e.skipped == 0) {
                            resources.getString(R.string.import_done, e.imported)
                        } else {
                            resources.getString(R.string.import_done_skipped, e.imported, e.skipped)
                        }
                    LibraryEvent.NothingToImport -> resources.getString(R.string.import_none)
                    is LibraryEvent.Removed -> resources.getString(R.string.removed, e.title)
                }
            snackbar.showSnackbar(text)
        }
    }

    val top = backStack.lastOrNull()
    val inReader = top is ReaderKey
    val selected = TopLevel.entries.firstOrNull { it.key == top } ?: TopLevel.Library
    val defaultType = NavigationSuiteScaffoldDefaults.navigationSuiteType(currentWindowAdaptiveInfoV2())

    NavigationSuiteScaffold(
        layoutType = if (inReader) NavigationSuiteType.None else defaultType,
        navigationSuiteItems = {
            TopLevel.entries.forEach { dest ->
                item(
                    selected = !inReader && dest == selected,
                    onClick = {
                        backStack.clear()
                        backStack.add(LibraryKey)
                        if (dest.key != LibraryKey) backStack.add(dest.key)
                    },
                    icon = { Icon(painterResource(dest.icon), contentDescription = null) },
                    label = { Text(stringResource(dest.label)) },
                )
            }
        },
    ) {
        Scaffold(
            contentWindowInsets = WindowInsets(0),
            snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                NavDisplay(
                    backStack = backStack,
                    onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                    entryDecorators =
                        listOf(
                            rememberSaveableStateHolderNavEntryDecorator(),
                            rememberViewModelStoreNavEntryDecorator(),
                        ),
                    entryProvider =
                        entryProvider {
                            entry<LibraryKey> {
                                LibraryScreen(
                                    state = state,
                                    onQueryChange = library::setQuery,
                                    onImport = onImport,
                                    onOpen = { backStack.add(ReaderKey(it.key)) },
                                    onRemove = { library.remove(it.key) },
                                )
                            }
                            entry<InboxKey> { InboxScreen() }
                            entry<SettingsKey> { SettingsScreen(onImport = onImport) }
                            entry<ReaderKey> { k ->
                                ReaderScreen(
                                    key = k.key,
                                    index = container.localIndex,
                                    store = container.docStore,
                                    onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                                )
                            }
                        },
                )
            }
        }
    }
}
