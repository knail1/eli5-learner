package io.github.eli5learner.ask

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.sync.protocol.Limits

/** The Ask sheet (16 §6.2), from the Reader's overflow when the primary Mac accepts `ask` jobs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AskSheet(
    sections: List<OutlineSection>,
    onSend: (OutlineSection, String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        AskSheetContent(sections, onSend, Modifier.navigationBarsPadding().imePadding())
    }
}

/** Section picker from the document outline and a one-line question; nothing waits for the network. */
@Composable
fun AskSheetContent(
    sections: List<OutlineSection>,
    onSend: (OutlineSection, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var question by rememberSaveable { mutableStateOf("") }
    val section = sections.firstOrNull { it.id == selected }
    val normalized = AskQuestion.normalize(question)
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp)) {
        Text(stringResource(R.string.ask_title), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.ask_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
        )
        if (sections.isEmpty()) {
            Text(stringResource(R.string.ask_no_sections), style = MaterialTheme.typography.bodyMedium)
            return@Column
        }
        Text(stringResource(R.string.ask_pick_section), style = MaterialTheme.typography.labelLarge)
        LazyColumn(Modifier.heightIn(max = 280.dp)) {
            items(sections, key = { it.id }) { s ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .selectable(selected = s.id == selected, role = Role.RadioButton) { selected = s.id },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = s.id == selected, onClick = null)
                    Column(Modifier.padding(start = 8.dp)) {
                        Text(s.heading.ifEmpty { stringResource(R.string.ask_untitled_section) }, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (s.tab.isNotEmpty()) {
                            Text(s.tab, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        OutlinedTextField(
            value = question,
            onValueChange = { question = it.replace('\n', ' ').take(Limits.QUESTION_MAX_CHARS + 50) },
            label = { Text(stringResource(R.string.ask_question)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        Button(
            onClick = { if (section != null && normalized != null) onSend(section, normalized) },
            enabled = section != null && normalized != null,
            modifier = Modifier.padding(top = 12.dp),
        ) { Text(stringResource(R.string.ask_send)) }
    }
}

/** The question rules both sides share (16 §5.1): one line, 3 to 500 characters (code points). */
object AskQuestion {
    /** Whitespace and line breaks, including U+2028/U+2029 and the BOM (what the wire's BLANK rule counts). */
    private val WHITESPACE = Regex("[\\s\\u000b\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

    /** Collapsed to one line and cut to 500 code points; null when shorter than 3. */
    fun normalize(raw: String): String? {
        val one = raw.replace(WHITESPACE, " ").trim()
        val cut =
            if (one.codePointCount(0, one.length) > Limits.QUESTION_MAX_CHARS) {
                one.substring(0, one.offsetByCodePoints(0, Limits.QUESTION_MAX_CHARS)).trimEnd()
            } else {
                one
            }
        return cut.takeIf { it.codePointCount(0, it.length) >= Limits.QUESTION_MIN_CHARS }
    }
}
