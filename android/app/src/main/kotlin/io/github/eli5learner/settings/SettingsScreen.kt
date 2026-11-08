package io.github.eli5learner.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.eli5learner.BuildConfig
import io.github.eli5learner.R
import io.github.eli5learner.auth.AuthState

/**
 * Settings (16 §6.2): Account (Connect, Disconnect, Sign in again), Import HTML, Diagnostics and
 * About. Sync now, offline policy and storage arrive with library sync. Stateless apart from the
 * Disconnect confirmation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onImport: () -> Unit,
    modifier: Modifier = Modifier,
    auth: AuthState = AuthState.Disconnected,
    onConnect: () -> Unit = {},
    onDisconnect: () -> Unit = {},
    onDiagnostics: () -> Unit = {},
    versionName: String = BuildConfig.VERSION_NAME,
    commit: String = BuildConfig.GIT_COMMIT,
) {
    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            SectionTitle(stringResource(R.string.settings_account))
            AccountRow(auth, onConnect, onDisconnect)
            HorizontalDivider()
            ListItem(
                headlineContent = { Text(stringResource(R.string.action_import)) },
                supportingContent = { Text(stringResource(R.string.settings_import_body)) },
                trailingContent = { TextButton(onClick = onImport) { Text(stringResource(R.string.action_import)) } },
            )
            ListItem(
                modifier = Modifier.clickable(onClick = onDiagnostics),
                headlineContent = { Text(stringResource(R.string.diagnostics_title)) },
                supportingContent = { Text(stringResource(R.string.diagnostics_body)) },
            )
            HorizontalDivider()
            SectionTitle(stringResource(R.string.settings_about))
            ListItem(
                headlineContent = { Text(stringResource(R.string.about_sideloaded)) },
                supportingContent = {
                    Column {
                        Text(stringResource(R.string.about_version, versionName))
                        Text(stringResource(R.string.about_commit, commit))
                    }
                },
            )
            if (auth !is AuthState.Connected && auth !is AuthState.NeedsReconnect) {
                ListItem(headlineContent = { Text(stringResource(R.string.about_local_mode)) })
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp),
    )
}

@Composable
private fun AccountRow(
    auth: AuthState,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    var confirm by rememberSaveable { mutableStateOf(false) }
    when (auth) {
        is AuthState.Connected ->
            ListItem(
                headlineContent = {
                    Text(auth.email?.let { stringResource(R.string.account_connected_as, it) } ?: stringResource(R.string.account_connected))
                },
                trailingContent = { TextButton(onClick = { confirm = true }) { Text(stringResource(R.string.action_disconnect)) } },
            )
        is AuthState.NeedsReconnect ->
            ListItem(
                headlineContent = { Text(stringResource(R.string.account_needs_reconnect)) },
                supportingContent = {
                    Column {
                        Text(stringResource(R.string.account_needs_reconnect_body))
                        TextButton(onClick = { confirm = true }) { Text(stringResource(R.string.action_disconnect)) }
                    }
                },
                trailingContent = { Button(onClick = onConnect) { Text(stringResource(R.string.action_reconnect)) } },
            )
        else ->
            ListItem(
                headlineContent = { Text(stringResource(R.string.action_connect)) },
                supportingContent = { Text(stringResource(R.string.account_not_connected)) },
                trailingContent = {
                    val connecting = auth == AuthState.Connecting
                    Button(onClick = onConnect, enabled = !connecting && auth != AuthState.Unknown) {
                        Text(stringResource(if (connecting) R.string.action_connecting else R.string.action_connect))
                    }
                },
            )
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.disconnect_title)) },
            text = { Text(stringResource(R.string.disconnect_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    onDisconnect()
                }) { Text(stringResource(R.string.action_disconnect)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}
