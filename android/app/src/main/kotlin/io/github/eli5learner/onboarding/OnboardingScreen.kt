package io.github.eli5learner.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.auth.AuthState

/**
 * First-run choice (16 §6.2): "Use on this phone only" (import) or "Connect Google Drive" (one-line
 * rationale, then authorize). After connecting it shows "Waiting for your Mac…"; the check for a
 * desktop device file arrives with library sync. Skippable. Stateless.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OnboardingScreen(
    auth: AuthState,
    onUseLocally: () -> Unit,
    onConnect: () -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
    /** Connected but no Mac seen yet (16 §6.2: "Waiting for your Mac" until a desktop device file appears). */
    waitingForMac: Boolean = true,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = {},
                actions = { TextButton(onClick = onDone) { Text(stringResource(R.string.onboarding_skip)) } },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 560.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(stringResource(R.string.onboarding_title), style = MaterialTheme.typography.headlineMedium)
                Text(stringResource(R.string.onboarding_body), style = MaterialTheme.typography.bodyLarge)

                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.onboarding_local_title), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.onboarding_local_body), style = MaterialTheme.typography.bodyMedium)
                        OutlinedButton(onClick = onUseLocally) { Text(stringResource(R.string.onboarding_local_action)) }
                    }
                }

                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.onboarding_drive_title), style = MaterialTheme.typography.titleMedium)
                        when (auth) {
                            is AuthState.Connected -> {
                                Text(
                                    auth.email?.let { stringResource(R.string.account_connected_as, it) }
                                        ?: stringResource(R.string.account_connected),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                if (waitingForMac) {
                                    Text(stringResource(R.string.onboarding_waiting), style = MaterialTheme.typography.titleSmall)
                                    Text(stringResource(R.string.onboarding_waiting_body), style = MaterialTheme.typography.bodyMedium)
                                }
                                Button(onClick = onDone) { Text(stringResource(R.string.onboarding_continue)) }
                            }
                            else -> {
                                Text(stringResource(R.string.onboarding_drive_body), style = MaterialTheme.typography.bodyMedium)
                                val connecting = auth == AuthState.Connecting
                                Button(onClick = onConnect, enabled = !connecting && auth != AuthState.Unknown) {
                                    Text(stringResource(if (connecting) R.string.action_connecting else R.string.action_connect))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
