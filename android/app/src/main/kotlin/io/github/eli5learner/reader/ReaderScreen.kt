package io.github.eli5learner.reader

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import io.github.eli5learner.R
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LocalIndex

/** Full-bleed reader for one document (16 §6.2, §6.3). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderScreen(
    key: String,
    index: LocalIndex,
    store: DocStore,
    onBack: () -> Unit,
) {
    var entry by remember(key) { mutableStateOf<DocEntry?>(null) }
    var missing by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key) {
        entry = index.find(key)
        missing = entry == null
    }
    val currentOnBack by rememberUpdatedState(onBack)

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(entry?.title.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (entry?.foreign == true) {
                            Text(stringResource(R.string.label_foreign), style = MaterialTheme.typography.labelMedium)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        val e = entry
        when {
            missing -> Text(stringResource(R.string.reader_missing), modifier = Modifier.padding(padding).padding(24.dp))
            e == null -> Box(Modifier.fillMaxSize().padding(padding))
            else -> DocWebView(e, store, onRendererGone = { currentOnBack() }, modifier = Modifier.fillMaxSize().padding(padding))
        }
    }
}

@Composable
private fun DocWebView(
    entry: DocEntry,
    store: DocStore,
    onRendererGone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var canGoBack by remember(entry.key, entry.sha) { mutableStateOf(false) }
    var webView by remember(entry.key, entry.sha) { mutableStateOf<WebView?>(null) }
    val docUrl = UrlPolicy.docUrl(entry.key, entry.sha)

    // Back goes through the document's own history (fragment jumps) first (16 §6.3).
    BackHandler(enabled = canGoBack) { webView?.goBack() }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            DocWebViewFactory
                .create(
                    context = ctx,
                    store = store,
                    docUrl = docUrl,
                    foreign = entry.foreign,
                    onExternal = { openExternal(context, it) },
                    onHistoryChanged = { canGoBack = it },
                    onRendererGone = onRendererGone,
                ).also {
                    webView = it
                    it.loadUrl(docUrl)
                }
        },
        onRelease = {
            webView = null
            it.stopLoading()
            it.destroy()
        },
    )
}

/** Opens an http(s) link in a Custom Tab, or the default browser if no Custom Tabs browser exists. */
private fun openExternal(
    context: Context,
    url: String,
) {
    val uri = url.toUri()
    try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // No browser: the link is dropped.
        }
    }
}
