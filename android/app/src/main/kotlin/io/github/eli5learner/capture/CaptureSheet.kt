package io.github.eli5learner.capture

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.sync.protocol.Limits
import io.github.eli5learner.util.AppVersions
import kotlinx.coroutines.launch

/** What the sheet's controls do. */
data class CaptureActions(
    val onClarifyingChange: (String) -> Unit = {},
    val onToggleFocus: (FocusChip) -> Unit = {},
    val onSend: () -> Unit = {},
    /** The link field changed ("Send a link" only). */
    val onLinkChange: (String) -> Unit = {},
    val onToggleDeadpan: () -> Unit = {},
    /** The user is done with the link field (Next, focus left it, or a Paste), so a bad link shows as one. */
    val onLinkDone: () -> Unit = {},
)

/**
 * The share target's bottom sheet (16 §6.2 Capture): a preview of what was shared, the refusals,
 * instructions for the Mac, focus chips, the Deadpan tab and "Send to my Mac". The activity behind
 * it is translucent, so the sharing app stays visible. The Inbox's "Send a link" opens the same
 * sheet in [CaptureUiState.manual] mode, with a link field in place of the preview.
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
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var linkFocused by remember { mutableStateOf(false) }
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(if (state.manual) R.string.capture_link_title else R.string.capture_title),
            style = MaterialTheme.typography.titleLarge,
        )
        if (state.manual) {
            OutlinedTextField(
                value = state.linkInput,
                onValueChange = actions.onLinkChange,
                label = { Text(stringResource(R.string.capture_link_field)) },
                singleLine = true,
                isError = state.linkInvalid,
                supportingText =
                    if (state.linkInvalid) {
                        { Text(stringResource(R.string.capture_link_invalid)) }
                    } else {
                        null
                    },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { actions.onLinkDone() }),
                trailingIcon = {
                    TextButton(
                        onClick = {
                            scope.launch {
                                val clip = clipboard.getClipEntry()?.clipData
                                val pasted = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
                                if (!pasted.isNullOrBlank()) {
                                    actions.onLinkChange(pasted.trim())
                                    actions.onLinkDone()
                                }
                            }
                        },
                    ) { Text(stringResource(R.string.capture_link_paste)) }
                },
                modifier =
                    Modifier.fillMaxWidth().onFocusChanged { f ->
                        // Typing is not an error yet; leaving the field is when a bad link shows.
                        if (linkFocused && !f.isFocused) actions.onLinkDone()
                        linkFocused = f.isFocused
                    },
            )
        }
        if (state.loading) {
            CircularProgressIndicator(Modifier.padding(vertical = 8.dp))
            Text(stringResource(R.string.capture_reading), style = MaterialTheme.typography.bodyMedium)
        }
        if (!state.manual) state.urls.forEach { u ->
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
        // In "Send a link" the field's own error covers a refused link.
        if (!state.manual && state.refusedUrls > 0) Note(pluralStringResource(R.plurals.capture_refused_urls, state.refusedUrls, state.refusedUrls))
        state.refusals.forEach { r -> Note(refusalText(r)) }
        if (!state.manual && !state.loading && !state.canSend && !state.sending) Note(stringResource(R.string.capture_nothing))
        when {
            !state.connected -> Note(stringResource(R.string.capture_not_connected))
            state.macPaused -> Note(stringResource(R.string.capture_mac_paused))
        }
        Spacer(Modifier.height(4.dp))
        val used = state.clarifyingInput.codePointCount(0, state.clarifyingInput.length)
        OutlinedTextField(
            value = state.clarifyingInput,
            onValueChange = actions.onClarifyingChange,
            label = { Text(stringResource(R.string.capture_instructions)) },
            placeholder = { Text(stringResource(R.string.capture_instructions_hint)) },
            supportingText = {
                Text(
                    stringResource(R.string.capture_instructions_count, used, Limits.CLARIFYING_INPUT_CHARS),
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.End,
                )
            },
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
        DeadpanRow(state, actions.onToggleDeadpan)
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

/** "Deadpan tab": on only for a Mac that writes it; otherwise disabled, with what is needed. */
@Composable
private fun DeadpanRow(
    state: CaptureUiState,
    onToggle: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(
                value = state.sendsDeadpan,
                enabled = state.deadpanAvailable,
                role = Role.Switch,
                onValueChange = { onToggle() },
            ).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.capture_deadpan), style = MaterialTheme.typography.bodyLarge)
            Note(
                if (state.deadpanAvailable) {
                    stringResource(R.string.capture_deadpan_hint)
                } else if (state.macVersionUnknown && state.connected) {
                    // Not known yet is not "too old": a pass is reading the Mac's device file.
                    stringResource(R.string.capture_deadpan_checking)
                } else {
                    stringResource(R.string.capture_deadpan_needs_update, AppVersions.DEADPAN_MIN_MAC)
                },
            )
        }
        Switch(checked = state.sendsDeadpan, onCheckedChange = null, enabled = state.deadpanAvailable)
    }
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
