package io.github.eli5learner.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.eli5learner.BuildConfig
import io.github.eli5learner.R

/** Settings in local mode (16 §6.2): Import HTML and About. Account and sync rows arrive with sync. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onImport: () -> Unit,
    modifier: Modifier = Modifier,
    versionName: String = BuildConfig.VERSION_NAME,
    commit: String = BuildConfig.GIT_COMMIT,
) {
    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            ListItem(
                headlineContent = { Text(stringResource(R.string.action_import)) },
                supportingContent = { Text(stringResource(R.string.settings_import_body)) },
                trailingContent = { TextButton(onClick = onImport) { Text(stringResource(R.string.action_import)) } },
            )
            HorizontalDivider()
            Text(
                stringResource(R.string.settings_about),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp),
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.about_sideloaded)) },
                supportingContent = {
                    Column {
                        Text(stringResource(R.string.about_version, versionName))
                        Text(stringResource(R.string.about_commit, commit))
                    }
                },
            )
            ListItem(headlineContent = { Text(stringResource(R.string.about_local_mode)) })
        }
    }
}
