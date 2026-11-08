package io.github.eli5learner.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.auth.AuthState

/** Actions of the debug-only Drive probe (gate G1, 16 §13). */
data class ProbeActions(
    val write: () -> Unit,
    val list: () -> Unit,
    val read: () -> Unit,
    val startChanges: () -> Unit,
    val checkChanges: () -> Unit,
    val deleteOwn: () -> Unit,
    val clear: () -> Unit,
)

/**
 * Settings > Diagnostics (16 §6.2): counts only. In debug builds ([showProbe]) it adds the Drive
 * probe, the phone half of gate G1; release builds never show it. Stateless.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun DiagnosticsScreen(
    documents: Int,
    auth: AuthState,
    showProbe: Boolean,
    probe: ProbeUiState,
    actions: ProbeActions,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.diagnostics_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            ListItem(
                headlineContent = { Text(stringResource(R.string.diagnostics_documents, documents)) },
                supportingContent = { Text(stringResource(R.string.diagnostics_body)) },
            )
            ListItem(
                headlineContent = {
                    Text(
                        stringResource(
                            when (auth) {
                                is AuthState.Connected -> R.string.diagnostics_drive_connected
                                is AuthState.NeedsReconnect -> R.string.diagnostics_drive_reconnect
                                else -> R.string.diagnostics_drive_off
                            },
                        ),
                    )
                },
            )
            if (showProbe) {
                HorizontalDivider()
                Text(
                    stringResource(R.string.probe_title),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp),
                )
                Text(
                    stringResource(R.string.probe_body),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
                val enabled = auth is AuthState.Connected && !probe.busy
                FlowRow(
                    Modifier.padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(onClick = actions.write, enabled = enabled) { Text(stringResource(R.string.probe_write)) }
                    OutlinedButton(onClick = actions.list, enabled = enabled) { Text(stringResource(R.string.probe_list)) }
                    OutlinedButton(onClick = actions.read, enabled = enabled) { Text(stringResource(R.string.probe_read)) }
                    OutlinedButton(onClick = actions.startChanges, enabled = enabled) { Text(stringResource(R.string.probe_start)) }
                    OutlinedButton(onClick = actions.checkChanges, enabled = enabled && probe.changeToken != null) {
                        Text(stringResource(R.string.probe_changes))
                    }
                    OutlinedButton(onClick = actions.deleteOwn, enabled = enabled) { Text(stringResource(R.string.probe_delete)) }
                    OutlinedButton(onClick = actions.clear, enabled = probe.log.isNotEmpty()) { Text(stringResource(R.string.probe_clear)) }
                }
                SelectionContainer {
                    Column(Modifier.padding(16.dp)) {
                        probe.log.forEach { line ->
                            Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
    }
}
