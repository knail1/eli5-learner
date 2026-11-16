package io.github.eli5learner.library

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.sync.SyncProblem
import io.github.eli5learner.sync.SyncStatus
import io.github.eli5learner.sync.protocol.InboxState

/** The three states of the sync icon (16 §6.2). */
enum class SyncIconState { SYNCED, SYNCING, OFFLINE }

fun syncIconState(s: SyncStatus): SyncIconState =
    when {
        s.syncing -> SyncIconState.SYNCING
        s.problem != null -> SyncIconState.OFFLINE
        else -> SyncIconState.SYNCED
    }

/**
 * The library list (16 §6.2): search, folder chips, rows (title, updated time, offline pin, unread
 * dot), the sync icon with its status sheet, pull-to-refresh, the reconnect banner and the empty
 * state. A row's menu (also on long-press) offers Share for a document on this phone (16 §6.5).
 * Stateless apart from the sheet. Sync parts show only while connected.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    state: LibraryUiState,
    onQueryChange: (String) -> Unit,
    onImport: () -> Unit,
    onOpen: (DocEntry) -> Unit,
    onRemove: (DocEntry) -> Unit,
    modifier: Modifier = Modifier,
    needsReconnect: Boolean = false,
    onReconnect: () -> Unit = {},
    connected: Boolean = false,
    onRefresh: () -> Unit = {},
    onFolder: (String?) -> Unit = {},
    onPin: (DocEntry, Boolean) -> Unit = { _, _ -> },
    onShare: (DocEntry) -> Unit = {},
) {
    var sheet by rememberSaveable { mutableStateOf(false) }
    val syncVisible = connected || needsReconnect
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_library)) },
                actions = {
                    if (syncVisible) SyncIconButton(if (needsReconnect) SyncIconState.OFFLINE else syncIconState(state.sync)) { sheet = true }
                    IconButton(onClick = onImport) {
                        Icon(painterResource(R.drawable.ic_file_open), contentDescription = stringResource(R.string.action_import))
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            // The only persistent banner: lost authorization (16 §6.2). Reading keeps working.
            if (needsReconnect) ReconnectBanner(onReconnect)
            if (connected) {
                PullToRefreshBox(isRefreshing = state.sync.syncing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
                    LibraryBody(state, onQueryChange, onImport, onOpen, onRemove, onFolder, onPin, onShare, waitingForMac = state.sync.waitingForMac)
                }
            } else {
                LibraryBody(state, onQueryChange, onImport, onOpen, onRemove, onFolder, onPin, onShare, waitingForMac = false)
            }
        }
    }
    if (sheet && syncVisible) {
        ModalBottomSheet(onDismissRequest = { sheet = false }) {
            SyncStatusSheet(
                status = state.sync,
                lastSyncAt = state.lastSyncAt,
                needsReconnect = needsReconnect,
                onSyncNow = onRefresh,
                onReconnect = {
                    sheet = false
                    onReconnect()
                },
            )
        }
    }
}

@Composable
private fun SyncIconButton(
    s: SyncIconState,
    onClick: () -> Unit,
) {
    val (icon, label) =
        when (s) {
            SyncIconState.SYNCED -> R.drawable.ic_cloud_done to R.string.sync_state_synced
            SyncIconState.SYNCING -> R.drawable.ic_sync to R.string.sync_state_syncing
            SyncIconState.OFFLINE -> R.drawable.ic_cloud_off to R.string.sync_state_offline
        }
    IconButton(onClick = onClick) { Icon(painterResource(icon), contentDescription = stringResource(label)) }
}

/** The sync icon's sheet: state, last sync, the Mac's heartbeat and inbox, pending downloads, Sync now. */
@Composable
fun SyncStatusSheet(
    status: SyncStatus,
    lastSyncAt: Long?,
    needsReconnect: Boolean,
    onSyncNow: () -> Unit,
    onReconnect: () -> Unit,
    now: Long = System.currentTimeMillis(),
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
        val headline =
            when {
                needsReconnect -> R.string.account_needs_reconnect
                status.syncing -> R.string.sync_state_syncing
                status.problem == SyncProblem.OFFLINE -> R.string.sync_problem_offline
                status.problem == SyncProblem.FORMAT_TOO_NEW -> R.string.sync_problem_format
                status.problem == SyncProblem.DRIVE_FULL -> R.string.sync_problem_quota
                status.problem == SyncProblem.DRIVE_API_DISABLED -> R.string.sync_problem_api_disabled
                status.problem != null -> R.string.sync_problem_error
                else -> R.string.sync_state_synced
            }
        Text(stringResource(headline), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        val last = lastSyncAt?.let { relative(it, now) }
        Text(
            if (last != null) stringResource(R.string.sync_last, last) else stringResource(R.string.sync_never),
            style = MaterialTheme.typography.bodyMedium,
        )
        val mac = status.mac
        when {
            status.waitingForMac -> Text(stringResource(R.string.onboarding_waiting), style = MaterialTheme.typography.bodyMedium)
            mac != null -> {
                Text(
                    mac.lastSeenMs?.let { stringResource(R.string.sync_mac_seen, relative(it, now)) }
                        ?: stringResource(R.string.sync_mac_never_seen),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (mac.inbox != InboxState.ON) {
                    Text(stringResource(R.string.sync_mac_no_jobs), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        if (status.pendingDownloads > 0) {
            Text(pluralStringResource(R.plurals.sync_pending, status.pendingDownloads, status.pendingDownloads), style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(16.dp))
        if (needsReconnect) {
            Button(onClick = onReconnect) { Text(stringResource(R.string.action_reconnect)) }
        } else {
            Button(onClick = onSyncNow, enabled = !status.syncing) { Text(stringResource(R.string.action_sync_now)) }
        }
    }
}

private fun relative(
    ms: Long,
    now: Long,
): String = DateUtils.getRelativeTimeSpanString(minOf(ms, now), now, DateUtils.MINUTE_IN_MILLIS).toString()

@Composable
private fun ReconnectBanner(onReconnect: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.account_needs_reconnect),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onReconnect) { Text(stringResource(R.string.action_reconnect)) }
        }
    }
}

@Composable
private fun LibraryBody(
    state: LibraryUiState,
    onQueryChange: (String) -> Unit,
    onImport: () -> Unit,
    onOpen: (DocEntry) -> Unit,
    onRemove: (DocEntry) -> Unit,
    onFolder: (String?) -> Unit,
    onPin: (DocEntry, Boolean) -> Unit,
    onShare: (DocEntry) -> Unit,
    waitingForMac: Boolean,
) {
    when {
        !state.loaded -> Box(Modifier.fillMaxSize())
        state.total == 0 -> EmptyState(onImport, waitingForMac, Modifier.fillMaxSize().verticalScroll(rememberScrollState()))
        else ->
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                item(key = "search") {
                    OutlinedTextField(
                        value = state.query,
                        onValueChange = onQueryChange,
                        placeholder = { Text(stringResource(R.string.library_search)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                if (state.folders.isNotEmpty() || state.hasArchive) {
                    item(key = "chips") { FolderChips(state, onFolder) }
                }
                if (state.items.isEmpty()) {
                    item(key = "nomatch") {
                        Text(
                            stringResource(R.string.library_no_match),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(24.dp),
                        )
                    }
                }
                items(state.items, key = { it.key }) { entry ->
                    LibraryRow(entry, onOpen = { onOpen(entry) }, onRemove = { onRemove(entry) }, onPin = { onPin(entry, it) }, onShare = { onShare(entry) })
                }
            }
    }
}

@Composable
private fun FolderChips(
    state: LibraryUiState,
    onFolder: (String?) -> Unit,
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item { FilterChip(selected = state.folder == null, onClick = { onFolder(null) }, label = { Text(stringResource(R.string.folder_all)) }) }
        items(state.folders, key = { it.id }) { f ->
            FilterChip(selected = state.folder == f.id, onClick = { onFolder(f.id) }, label = { Text(f.name, maxLines = 1) })
        }
        if (state.folders.isNotEmpty()) {
            item {
                FilterChip(
                    selected = state.folder == FolderFilter.UNFILED,
                    onClick = { onFolder(FolderFilter.UNFILED) },
                    label = { Text(stringResource(R.string.folder_unfiled)) },
                )
            }
        }
        if (state.hasArchive) {
            item {
                FilterChip(
                    selected = state.folder == FolderFilter.ARCHIVE,
                    onClick = { onFolder(FolderFilter.ARCHIVE) },
                    label = { Text(stringResource(R.string.folder_archive)) },
                )
            }
        }
    }
}

@Composable
private fun LibraryRow(
    entry: DocEntry,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
    onPin: (Boolean) -> Unit,
    onShare: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val time =
        DateUtils
            .getRelativeTimeSpanString(entry.updatedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
            .toString()
    ListItem(
        modifier =
            Modifier.combinedClickable(
                onClick = onOpen,
                onLongClick = { menu = true },
                onLongClickLabel = stringResource(R.string.row_show_menu, entry.title),
            ),
        leadingContent =
            if (entry.unread) {
                {
                    val label = stringResource(R.string.label_unread)
                    Box(
                        Modifier
                            .size(8.dp)
                            .background(MaterialTheme.colorScheme.primary, CircleShape)
                            .semantics { contentDescription = label },
                    )
                }
            } else {
                null
            },
        headlineContent = { Text(entry.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            val parts =
                buildList {
                    add(stringResource(if (entry.synced) R.string.label_updated else R.string.label_imported, time))
                    if (entry.foreign) add(stringResource(R.string.label_foreign))
                    if (entry.busy) add(stringResource(R.string.label_busy))
                    if (entry.synced && !entry.available) add(stringResource(R.string.label_not_downloaded))
                }
            Text(parts.joinToString(" · "))
        },
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (entry.pinned) {
                    Icon(painterResource(R.drawable.ic_offline_pin), contentDescription = stringResource(R.string.label_pinned))
                }
                Box {
                    IconButton(onClick = { menu = true }) {
                        Icon(painterResource(R.drawable.ic_more_vert), contentDescription = stringResource(R.string.row_more, entry.title))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (entry.available) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.action_share)) },
                                onClick = {
                                    menu = false
                                    onShare()
                                },
                            )
                        }
                        if (entry.synced) {
                            DropdownMenuItem(
                                text = { Text(stringResource(if (entry.pinned) R.string.action_unpin else R.string.action_pin)) },
                                onClick = {
                                    menu = false
                                    onPin(!entry.pinned)
                                },
                            )
                        } else {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.action_remove)) },
                                onClick = {
                                    menu = false
                                    onRemove()
                                },
                            )
                        }
                    }
                }
            }
        },
    )
}

@Composable
private fun EmptyState(
    onImport: () -> Unit,
    waitingForMac: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            stringResource(if (waitingForMac) R.string.onboarding_waiting else R.string.library_empty_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(if (waitingForMac) R.string.onboarding_waiting_body else R.string.library_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onImport) { Text(stringResource(R.string.action_import)) }
    }
}
