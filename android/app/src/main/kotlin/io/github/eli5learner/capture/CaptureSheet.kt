package io.github.eli5learner.capture

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.sync.protocol.FocusChip

/** What the sheet's controls do. */
data class CaptureActions(
    val onClarifyingChange: (String) -> Unit = {},
    val onToggleFocus: (FocusChip) -> Unit = {},
    val onSend: () -> Unit = {},
)

/**
 * The share target's bottom sheet (16 §6.2 Capture): a preview of what was shared, the refusals,
 * "What do you want to understand?", focus chips and "Send to my Mac". The activity behind it is
 * translucent, so the sharing app stays visible.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureSheet(
    state: CaptureUiState,
    actions: CaptureActions,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        CaptureSheetContent(state, actions, Modifier.navigationBarsPadding().imePadding())
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CaptureSheetContent(
    state: CaptureUiState,
    actions: CaptureActions,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(R.string.capture_title), style = MaterialTheme.typography.titleLarge)
        if (state.loading) {
            CircularProgressIndicator(Modifier.padding(vertical = 8.dp))
            Text(stringResource(R.string.capture_reading), style = MaterialTheme.typography.bodyMedium)
        }
        state.urls.forEach { u ->
            Text(u, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (state.text.isNotBlank()) {
            Text(state.text, style = MaterialTheme.typography.bodyMedium, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
        if (state.textShortened) Note(stringResource(R.string.capture_text_shortened))
        state.files.forEach { f ->
            Text(
                stringResource(R.string.capture_file_row, f.name, Formatter.formatShortFileSize(context, f.size)),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (state.refusedUrls > 0) Note(pluralStringResource(R.plurals.capture_refused_urls, state.refusedUrls, state.refusedUrls))
        state.refusals.forEach { r -> Note(refusalText(r)) }
        if (!state.loading && !state.canSend && !state.sending) Note(stringResource(R.string.capture_nothing))
        when {
            !state.connected -> Note(stringResource(R.string.capture_not_connected))
            state.macPaused -> Note(stringResource(R.string.capture_mac_paused))
        }
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = state.clarifyingInput,
            onValueChange = actions.onClarifyingChange,
            label = { Text(stringResource(R.string.capture_question)) },
            modifier = Modifier.fillMaxWidth(),
            maxLines = 4,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FocusChip.entries.forEach { chip ->
                FilterChip(
                    selected = chip in state.focus,
                    onClick = { actions.onToggleFocus(chip) },
                    label = { Text(stringResource(focusLabel(chip))) },
                )
            }
        }
        Button(onClick = actions.onSend, enabled = state.canSend, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.capture_send))
        }
    }
}

/** "Tell you when it's ready?" after the first capture (16 §6.1). */
@Composable
fun NotifyDialog(
    onAnswer: (Boolean) -> Unit,
) {
    AlertDialog(
        onDismissRequest = { onAnswer(false) },
        title = { Text(stringResource(R.string.notify_ask_title)) },
        text = { Text(stringResource(R.string.notify_ask_body)) },
        confirmButton = { TextButton(onClick = { onAnswer(true) }) { Text(stringResource(R.string.notify_ask_yes)) } },
        dismissButton = { TextButton(onClick = { onAnswer(false) }) { Text(stringResource(R.string.notify_ask_no)) } },
    )
}

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun refusalText(r: Refusal): String {
    val name = r.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.capture_a_file)
    val res =
        when (r.reason) {
            RefusalReason.TOO_LARGE -> R.string.capture_refused_too_large
            RefusalReason.JOB_TOO_LARGE -> R.string.capture_refused_job_too_large
            RefusalReason.TOO_MANY -> R.string.capture_refused_too_many
            RefusalReason.TYPE -> R.string.capture_refused_type
            RefusalReason.UNREADABLE -> R.string.capture_refused_unreadable
        }
    return stringResource(res, name)
}

fun focusLabel(chip: FocusChip): Int =
    when (chip) {
        FocusChip.BIG_PICTURE -> R.string.focus_big_picture
        FocusChip.HOW_IT_WORKS -> R.string.focus_how_it_works
        FocusChip.NUMBERS -> R.string.focus_numbers
        FocusChip.BEGINNER -> R.string.focus_beginner
    }
