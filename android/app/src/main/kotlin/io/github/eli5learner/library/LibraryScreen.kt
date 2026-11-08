package io.github.eli5learner.library

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.eli5learner.R
import io.github.eli5learner.data.DocEntry

/** The library list (16 §6.2), local mode: search, rows, empty state with Import. Stateless. */
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
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_library)) },
                actions = {
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
            LibraryBody(state, onQueryChange, onImport, onOpen, onRemove)
        }
    }
}

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
) {
    when {
        !state.loaded -> Box(Modifier.fillMaxSize())
        state.total == 0 -> EmptyState(onImport, Modifier.fillMaxSize())
        else ->
            Column(Modifier.fillMaxSize()) {
                OutlinedTextField(
                    value = state.query,
                    onValueChange = onQueryChange,
                    placeholder = { Text(stringResource(R.string.library_search)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
                if (state.items.isEmpty()) {
                    Text(
                        stringResource(R.string.library_no_match),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(24.dp),
                    )
                }
                LazyColumn(contentPadding = PaddingValues(bottom = 16.dp)) {
                    items(state.items, key = { it.key }) { entry ->
                        LibraryRow(entry, onOpen = { onOpen(entry) }, onRemove = { onRemove(entry) })
                    }
                }
            }
    }
}

@Composable
private fun LibraryRow(
    entry: DocEntry,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val imported =
        DateUtils
            .getRelativeTimeSpanString(entry.importedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
            .toString()
    ListItem(
        modifier = Modifier.clickable(onClick = onOpen),
        headlineContent = { Text(entry.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            val label = stringResource(R.string.label_imported, imported)
            Text(if (entry.foreign) "${stringResource(R.string.label_foreign)} · $label" else label)
        },
        trailingContent = {
            Box {
                IconButton(onClick = { menu = true }) {
                    Icon(painterResource(R.drawable.ic_more_vert), contentDescription = stringResource(R.string.row_more, entry.title))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_remove)) },
                        onClick = {
                            menu = false
                            onRemove()
                        },
                    )
                }
            }
        },
    )
}

@Composable
private fun EmptyState(
    onImport: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.library_empty_title), style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(R.string.library_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onImport) { Text(stringResource(R.string.action_import)) }
    }
}
