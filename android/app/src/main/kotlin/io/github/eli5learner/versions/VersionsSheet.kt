package io.github.eli5learner.versions

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R

data class VersionsActions(
    val onToggle: (String) -> Unit = {},
    val onPreview: (String) -> Unit = {},
    val onCheckout: (String) -> Unit = {},
)

/** The Versions sheet (16 §6.2), opened from the Reader's version chip. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VersionsSheet(
    state: VersionsUiState,
    actions: VersionsActions,
    onDismiss: () -> Unit,
    now: Long = System.currentTimeMillis(),
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState()) {
        VersionsContent(state, actions, Modifier.navigationBarsPadding(), now)
    }
}

/**
 * The read-only tree: one row per version, indented by lane, the current one marked; branch points
 * expand and collapse; a row the Mac uploaded opens a preview; others read "Not available on this
 * phone". "Make current on your Mac" appears only when the Mac accepts `checkout` jobs.
 */
@Composable
fun VersionsContent(
    state: VersionsUiState,
    actions: VersionsActions,
    modifier: Modifier = Modifier,
    now: Long = System.currentTimeMillis(),
) {
    Column(modifier.fillMaxWidth().padding(bottom = 16.dp)) {
        Text(
            stringResource(R.string.versions_title),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
        )
        if (state.busy) Note(stringResource(R.string.versions_busy))
        if (state.canCheckout && state.macNotTaking) Note(stringResource(R.string.versions_mac_not_taking))
        if (state.loaded && state.items.isEmpty()) {
            Note(stringResource(R.string.versions_empty))
            return
        }
        LazyColumn {
            items(state.items, key = { it.row.id }) { item -> VersionRowView(item, state.canCheckout, actions, now) }
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
    )
}

@Composable
private fun VersionRowView(
    item: VersionItem,
    canCheckout: Boolean,
    actions: VersionsActions,
    now: Long,
) {
    val r = item.row
    val current = stringResource(R.string.versions_current)
    val expandedText = stringResource(if (r.expanded) R.string.versions_expanded else R.string.versions_collapsed)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(enabled = item.available, role = Role.Button) { actions.onPreview(r.id) }
            .semantics { if (r.isCurrent) stateDescription = current }
            .padding(start = (8 + 16 * r.level).dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                item.label,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (r.onCurrentPath) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val time = DateUtils.getRelativeTimeSpanString(minOf(item.createdAt, now), now, DateUtils.MINUTE_IN_MILLIS).toString()
            Text(
                if (item.available) time else stringResource(R.string.versions_not_on_phone_line, time),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (r.isCurrent) AssistChip(onClick = {}, enabled = false, label = { Text(current) })
                if (canCheckout && !r.isCurrent) {
                    TextButton(onClick = { actions.onCheckout(r.id) }) { Text(stringResource(R.string.versions_make_current)) }
                }
            }
        }
        if (r.hasChildren && !r.forced) {
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = { actions.onToggle(r.id) }, modifier = Modifier.semantics { stateDescription = expandedText }) {
                Text(stringResource(if (r.expanded) R.string.versions_hide_branches else R.string.versions_show_branches))
            }
        }
    }
}
