package io.github.eli5learner.inbox

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind

/** What the Inbox's controls do. */
data class InboxActions(
    val onCancel: (String) -> Unit = {},
    val onRetry: (String) -> Unit = {},
    val onDelete: (String) -> Unit = {},
    /** Opens a finished job's document by its library key. */
    val onOpen: (String) -> Unit = {},
    /** These terminal jobs are on screen (they go into the acks file). */
    val onShown: (List<String>) -> Unit = {},
    val onConnect: () -> Unit = {},
    val onReconnect: () -> Unit = {},
    val onNotifications: (Boolean) -> Unit = {},
)

/**
 * The Inbox (16 §6.2): jobs sent from this phone with their chips (Waiting to upload, Waiting for
 * your Mac, Queued, Generating with the stage, Ready, Built · N sources skipped, Failed with the
 * reason, Retry and Delete), and the "Mac last seen" line.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    state: InboxUiState,
    actions: InboxActions,
    modifier: Modifier = Modifier,
    now: Long = System.currentTimeMillis(),
) {
    val terminal = remember(state.items) { state.items.filter { it.terminal }.map { it.jobId } }
    LaunchedEffect(terminal) { actions.onShown(terminal) }
    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.inbox_title)) }) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            StatusLines(state, actions, now)
            if (state.items.isEmpty()) {
                Text(
                    stringResource(R.string.inbox_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(32.dp),
                )
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(state.items, key = { it.jobId }) { item ->
                        InboxRow(item, actions, now)
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusLines(
    state: InboxUiState,
    actions: InboxActions,
    now: Long,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val mac = state.mac
        when {
            state.needsReconnect ->
                Banner(stringResource(R.string.account_needs_reconnect), stringResource(R.string.action_reconnect), actions.onReconnect)
            !state.connected ->
                if (state.items.any { it.chip == InboxChip.CONNECT_TO_SEND }) {
                    Banner(stringResource(R.string.inbox_connect_to_send), stringResource(R.string.action_connect), actions.onConnect)
                }
            state.waitingForMac -> Line(stringResource(R.string.onboarding_waiting))
            mac != null -> {
                Line(mac.lastSeenMs?.let { stringResource(R.string.sync_mac_seen, relative(it, now)) } ?: stringResource(R.string.sync_mac_never_seen))
                if (mac.inbox != InboxState.ON || JobKind.CAPTURE !in mac.accepts) Line(stringResource(R.string.sync_mac_no_jobs))
            }
        }
        if (state.offerNotifications && state.items.isNotEmpty()) {
            Banner(stringResource(R.string.inbox_notify_offer), stringResource(R.string.notify_ask_yes)) { actions.onNotifications(true) }
        }
    }
}

@Composable
private fun InboxRow(
    item: InboxItem,
    actions: InboxActions,
    now: Long,
) {
    val open = item.openKey
    Column(
        Modifier
            .fillMaxWidth()
            .then(if (open != null) Modifier.clickable { actions.onOpen(open) } else Modifier)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            item.title.ifBlank { stringResource(R.string.inbox_untitled) },
            style = MaterialTheme.typography.titleMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip(chipText(item))
            Text(relative(item.createdAt, now), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item.stage?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        when {
            item.reason != null -> Text(item.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            item.chip == InboxChip.FAILED -> Text(stringResource(R.string.inbox_failed_local), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        if (item.canCancel || item.canRetry || item.canDelete || open != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (open != null) TextButton(onClick = { actions.onOpen(open) }) { Text(stringResource(R.string.inbox_open)) }
                if (item.canRetry) TextButton(onClick = { actions.onRetry(item.jobId) }) { Text(stringResource(R.string.action_retry)) }
                if (item.canCancel) TextButton(onClick = { actions.onCancel(item.jobId) }) { Text(stringResource(R.string.action_cancel)) }
                if (item.canDelete) TextButton(onClick = { actions.onDelete(item.jobId) }) { Text(stringResource(R.string.inbox_delete)) }
            }
        }
    }
}

@Composable
private fun chipText(item: InboxItem): String =
    when (item.chip) {
        InboxChip.CONNECT_TO_SEND -> stringResource(R.string.inbox_chip_connect)
        InboxChip.WAITING_TO_UPLOAD -> stringResource(R.string.inbox_chip_waiting_upload)
        InboxChip.WAITING_FOR_MAC -> stringResource(R.string.inbox_chip_waiting_mac)
        InboxChip.QUEUED -> stringResource(R.string.inbox_chip_queued)
        InboxChip.GENERATING -> stringResource(R.string.inbox_chip_generating)
        InboxChip.CANCELLING -> stringResource(R.string.inbox_chip_cancelling)
        InboxChip.READY -> stringResource(R.string.inbox_chip_ready)
        InboxChip.BUILT_SKIPPED -> pluralStringResource(R.plurals.inbox_built_skipped, item.skippedSources, item.skippedSources)
        InboxChip.FAILED -> stringResource(R.string.inbox_chip_failed)
        InboxChip.CANCELLED -> stringResource(R.string.inbox_chip_cancelled)
    }

@Composable
private fun Chip(text: String) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
    }
}

@Composable
private fun Line(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Banner(
    text: String,
    action: String,
    onClick: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = onClick) { Text(action) }
        }
    }
}

private fun relative(
    ms: Long,
    now: Long,
): String = DateUtils.getRelativeTimeSpanString(minOf(ms, now), now, DateUtils.MINUTE_IN_MILLIS).toString()
