package io.github.eli5learner.reader

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import io.github.eli5learner.R
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.sync.SyncRepository.FetchResult
import kotlinx.coroutines.launch

/** The Reader shows an earlier version from the Versions sheet (16 §6.2) instead of the phone's copy. */
data class ReaderPreview(
    val versionId: String,
    val sha: String,
    val label: String,
)

/** What the Reader knows about its document. */
private sealed interface Loaded {
    data object Loading : Loaded

    data class Done(
        val entry: DocEntry?,
    ) : Loaded
}

/**
 * Full-bleed reader for one document (16 §6.2, §6.3). When the Mac publishes a new version while it
 * is open, a "Updated on your Mac · Reload" banner appears; it never reloads by itself, and the
 * version on screen is kept on disk until the Reader leaves ([LibraryIndex.lease]). The reading
 * position is remembered per document and sha. A synced document that is not on the phone yet is
 * downloaded through [onFetch].
 *
 * Synced documents carry a version chip that opens the Versions sheet ([onVersions]); the overflow
 * offers Ask ([onAsk]) when the Mac accepts questions and the Reader shows the Mac's current version.
 * With [preview], the Reader shows that earlier version (downloaded through [onFetchVersion] when it
 * is not on the phone), never saves a reading position for it, and offers "Make current on your Mac"
 * ([onMakeCurrent]). A Share button sends the version on screen through the system share sheet
 * ([onShare]); it is hidden for a preview and while the document is not on the phone. The preview's file outlives this screen through a [PreviewLease] held by the
 * navigation entry, which also drops the downloaded copy once the entry is gone.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderScreen(
    key: String,
    index: LibraryIndex,
    store: DocStore,
    onBack: () -> Unit,
    onFetch: suspend (String) -> FetchResult = { FetchResult.NOT_CONNECTED },
    onSavePosition: (key: String, sha: String, position: Float) -> Unit = { _, _, _ -> },
    preview: ReaderPreview? = null,
    onFetchVersion: suspend (key: String, sha: String) -> FetchResult = { _, _ -> FetchResult.NOT_CONNECTED },
    versionLabel: String? = null,
    onVersions: (() -> Unit)? = null,
    onAsk: ((sha: String) -> Unit)? = null,
    onMakeCurrent: (() -> Unit)? = null,
    onShare: ((entry: DocEntry, sha: String) -> Unit)? = null,
) {
    val loaded by produceState<Loaded>(Loaded.Loading, key) {
        index.find(key) // the first load reconciles the index with the files
        index.observe(key).collect { value = Loaded.Done(it) }
    }
    val entry = (loaded as? Loaded.Done)?.entry
    val currentOnBack by rememberUpdatedState(onBack)
    val scope = rememberCoroutineScope()

    // The version on screen. A newer one only replaces it through Reload.
    var shownSha by rememberSaveable(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(entry?.sha) {
        if (preview != null) return@LaunchedEffect
        val sha = entry?.sha ?: return@LaunchedEffect
        val shown = shownSha
        if (shown == null || !store.exists(key, shown)) {
            shownSha = sha
            index.markOpened(key)
        }
    }
    // A preview is also leased by its navigation entry (PreviewLease), from before it downloads.
    var previewReady by remember(key, preview) { mutableStateOf(preview != null && store.exists(key, preview.sha)) }
    val shown = if (preview != null) preview.sha.takeIf { previewReady } else shownSha
    DisposableEffect(key, shown) {
        if (shown != null) index.lease(key, shown)
        onDispose { if (shown != null) index.release(key, shown) }
    }
    var menuOpen by remember { mutableStateOf(false) }
    val versionsLabel = stringResource(R.string.reader_versions_chip, versionLabel ?: stringResource(R.string.versions_title))
    val askSha = shown?.takeIf { preview == null && entry?.synced == true && !entry.foreign && it == entry.remoteSha }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(entry?.title.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (entry?.foreign == true) {
                            Text(stringResource(R.string.label_foreign), style = MaterialTheme.typography.labelMedium)
                        }
                        if (preview != null) {
                            Text(
                                stringResource(R.string.reader_preview_of, preview.label),
                                style = MaterialTheme.typography.labelMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    if (onVersions != null && entry?.synced == true && preview == null) {
                        AssistChip(
                            onClick = onVersions,
                            label = {
                                Text(
                                    versionLabel ?: stringResource(R.string.versions_title),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.widthIn(max = 140.dp),
                                )
                            },
                            modifier = Modifier.semantics { contentDescription = versionsLabel },
                        )
                    }
                    val shareEntry = entry
                    val shareSha = shown
                    if (onShare != null && preview == null && shareEntry != null && shareSha != null) {
                        IconButton(onClick = { onShare(shareEntry, shareSha) }) {
                            Icon(painterResource(R.drawable.ic_share), contentDescription = stringResource(R.string.action_share_document))
                        }
                    }
                    val ask = onAsk?.takeIf { askSha != null }
                    if (preview == null && (onVersions != null && entry?.synced == true || ask != null)) {
                        Box {
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(painterResource(R.drawable.ic_more_vert), contentDescription = stringResource(R.string.reader_more))
                            }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                if (onVersions != null && entry?.synced == true) {
                                    DropdownMenuItem(text = { Text(stringResource(R.string.versions_title)) }, onClick = {
                                        menuOpen = false
                                        onVersions()
                                    })
                                }
                                if (ask != null && askSha != null) {
                                    DropdownMenuItem(text = { Text(stringResource(R.string.ask_menu)) }, onClick = {
                                        menuOpen = false
                                        ask(askSha)
                                    })
                                }
                            }
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
        Column(Modifier.fillMaxSize().padding(padding)) {
            val e = entry
            when {
                loaded is Loaded.Done && e == null ->
                    Text(stringResource(R.string.reader_missing), modifier = Modifier.padding(24.dp))
                e == null -> Box(Modifier.fillMaxSize())
                preview != null && shown == null ->
                    NotOnPhone(key, { k -> onFetchVersion(k, preview.sha).also { r -> if (r == FetchResult.OK) previewReady = true } })
                shown == null -> NotOnPhone(key, onFetch)
                else -> {
                    if (preview != null) {
                        PreviewBanner(onMakeCurrent)
                    } else if (e.sha != null && e.sha != shown) {
                        UpdatedBanner(onReload = {
                            shownSha = e.sha
                            onSavePosition(key, e.sha, 0f)
                            scope.launch { index.markOpened(key) }
                        })
                    }
                    key(shown) {
                        DocWebView(
                            entry = e,
                            sha = shown,
                            store = store,
                            initialPosition = if (preview == null && e.readingSha == shown) e.readingPosition else 0f,
                            onRendererGone = { currentOnBack() },
                            onPosition = { if (preview == null) onSavePosition(key, shown, it) },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun UpdatedBanner(onReload: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.reader_updated), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = onReload) { Text(stringResource(R.string.action_reload)) }
        }
    }
}

/** An earlier version on screen; "Make current on your Mac" when the Mac accepts it. */
@Composable
private fun PreviewBanner(onMakeCurrent: (() -> Unit)?) {
    Surface(color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.reader_preview_banner), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            if (onMakeCurrent != null) TextButton(onClick = onMakeCurrent) { Text(stringResource(R.string.versions_make_current)) }
        }
    }
}

/** A synced document whose current version is not on the phone yet: download it now. */
@Composable
private fun NotOnPhone(
    key: String,
    onFetch: suspend (String) -> FetchResult,
) {
    var attempt by remember(key) { mutableIntStateOf(0) }
    var result by remember(key) { mutableStateOf<FetchResult?>(null) }
    LaunchedEffect(key, attempt) {
        result = null
        result = onFetch(key)
    }
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        val r = result
        when (r) {
            null, FetchResult.OK -> Text(stringResource(R.string.reader_downloading))
            FetchResult.MISSING -> Text(stringResource(R.string.reader_waiting_blob))
            else -> Text(stringResource(R.string.reader_not_offline))
        }
        if (r != null && r != FetchResult.OK) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = { attempt++ }) { Text(stringResource(R.string.action_retry)) }
        }
    }
}

@Composable
private fun DocWebView(
    entry: DocEntry,
    sha: String,
    store: DocStore,
    initialPosition: Float,
    onRendererGone: () -> Unit,
    onPosition: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var canGoBack by remember(entry.key, sha) { mutableStateOf(false) }
    var webView by remember(entry.key, sha) { mutableStateOf<WebView?>(null) }
    val docUrl = UrlPolicy.docUrl(entry.key, sha)
    val restore = remember(entry.key, sha) { initialPosition }

    // Back goes through the document's own history (fragment jumps) first (16 §6.3).
    BackHandler(enabled = canGoBack) { webView?.goBack() }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            var restored = false
            DocWebViewFactory
                .create(
                    context = ctx,
                    store = store,
                    docUrl = docUrl,
                    foreign = entry.foreign,
                    onExternal = { openExternal(context, it) },
                    onHistoryChanged = { canGoBack = it },
                    onRendererGone = onRendererGone,
                    onPageFinished = { view ->
                        if (!restored && restore > 0f) {
                            restored = true
                            // After layout, so the content height is known.
                            view.postDelayed({ view.scrollTo(0, (scrollRange(view) * restore).toInt()) }, RESTORE_DELAY_MS)
                        }
                    },
                ).also {
                    webView = it
                    it.loadUrl(docUrl)
                }
        },
        onRelease = {
            val range = scrollRange(it)
            if (range > 0) onPosition((it.scrollY.toFloat() / range).coerceIn(0f, 1f))
            webView = null
            it.stopLoading()
            it.destroy()
        },
    )
}

private const val RESTORE_DELAY_MS = 150L

/** Scrollable height in pixels. */
private fun scrollRange(view: WebView): Int = ((view.contentHeight * view.resources.displayMetrics.density) - view.height).toInt().coerceAtLeast(0)

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
