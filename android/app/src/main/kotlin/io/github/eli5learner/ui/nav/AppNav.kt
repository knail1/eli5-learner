package io.github.eli5learner.ui.nav

import android.Manifest
import android.app.Activity
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.eli5learner.AppContainer
import io.github.eli5learner.BuildConfig
import io.github.eli5learner.R
import io.github.eli5learner.auth.AccountEvent
import io.github.eli5learner.auth.AccountViewModel
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.inbox.InboxActions
import io.github.eli5learner.inbox.InboxEvent
import io.github.eli5learner.inbox.InboxScreen
import io.github.eli5learner.inbox.InboxViewModel
import io.github.eli5learner.library.LibraryEvent
import io.github.eli5learner.library.LibraryScreen
import io.github.eli5learner.library.LibraryViewModel
import io.github.eli5learner.onboarding.OnboardingScreen
import io.github.eli5learner.ask.AskSheet
import io.github.eli5learner.ask.DocOutline
import io.github.eli5learner.ask.OutlineSection
import io.github.eli5learner.reader.PreviewLease
import io.github.eli5learner.reader.ReaderPreview
import io.github.eli5learner.reader.ReaderScreen
import io.github.eli5learner.share.ShareRequest
import io.github.eli5learner.share.rememberShareDocument
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.versions.VersionsActions
import io.github.eli5learner.versions.VersionsEvent
import io.github.eli5learner.versions.VersionsSheet
import io.github.eli5learner.versions.VersionsViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import io.github.eli5learner.sync.protocol.ProtocolException
import java.io.IOException
import io.github.eli5learner.settings.DiagnosticsScreen
import io.github.eli5learner.settings.DiagnosticsViewModel
import io.github.eli5learner.settings.ProbeActions
import io.github.eli5learner.settings.SettingsScreen
import io.github.eli5learner.settings.SyncSettingsActions
import io.github.eli5learner.settings.SyncSettingsViewModel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
data object LibraryKey : NavKey

@Serializable
data object InboxKey : NavKey

@Serializable
data object SettingsKey : NavKey

@Serializable
data object OnboardingKey : NavKey

@Serializable
data object DiagnosticsKey : NavKey

@Serializable
data class ReaderKey(
    val key: String,
    /** An earlier version to preview (16 §6.2 Versions); null for the phone's own copy. */
    val previewVersionId: String? = null,
    val previewSha: String? = null,
    val previewLabel: String? = null,
) : NavKey

private enum class TopLevel(
    val key: NavKey,
    val label: Int,
    val icon: Int,
) {
    Library(LibraryKey, R.string.nav_library, R.drawable.ic_library),
    Inbox(InboxKey, R.string.nav_inbox, R.drawable.ic_inbox),
    Settings(SettingsKey, R.string.nav_settings, R.drawable.ic_settings),
}

/**
 * Navigation 3 with a navigation suite (bar on phones, rail on wider windows): Library, Inbox,
 * Settings; the reader, onboarding and diagnostics are pushed on top and hide the suite (16 §6.2).
 * Onboarding shows once, on the first launch. Google consent is launched from here through
 * `StartIntentSenderForResult` (16 §3.3).
 */
@Composable
fun AppNav(
    container: AppContainer,
    library: LibraryViewModel,
    account: AccountViewModel,
    /** Bumped by a "Learnings ready" tap: show the Inbox. */
    openInbox: StateFlow<Int>? = null,
) {
    val backStack = rememberNavBackStack(LibraryKey)
    val state by library.state.collectAsStateWithLifecycle()
    val auth by account.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val shareDocument = rememberShareDocument(container.docSharer, snackbar)
    val consent =
        rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
            account.onConsentResult(r.resultCode == Activity.RESULT_OK, r.data)
        }

    // "Notify me" from the Inbox: on Android 13+ the system asks; a refusal turns the option back off.
    val notificationPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) container.appScope.launch { container.preferences.setReadyNotifications(false) }
        }
    val requestNotifications = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    LaunchedEffect(openInbox) {
        openInbox?.collect { n ->
            if (n > 0) {
                backStack.clear()
                backStack.add(LibraryKey)
                backStack.add(InboxKey)
            }
        }
    }

    LaunchedEffect(Unit) {
        if (!container.preferences.onboardingDone.first() && backStack.lastOrNull() == LibraryKey) {
            backStack.add(OnboardingKey)
        }
    }
    val finishOnboarding = {
        scope.launch { container.preferences.setOnboardingDone() }
        if (backStack.lastOrNull() == OnboardingKey) backStack.removeAt(backStack.lastIndex)
    }

    LaunchedEffect(account) {
        account.messages.collect { e ->
            val text =
                when (e) {
                    is AccountEvent.LaunchConsent -> {
                        consent.launch(IntentSenderRequest.Builder(e.pendingIntent).build())
                        null
                    }
                    is AccountEvent.Connected ->
                        e.email?.let { resources.getString(R.string.account_connected_as, it) }
                            ?: resources.getString(R.string.account_connected)
                    is AccountEvent.Failed ->
                        e.statusCode?.let { resources.getString(R.string.account_failed_code, it) }
                            ?: resources.getString(R.string.account_failed)
                    AccountEvent.Cancelled -> resources.getString(R.string.account_cancelled)
                    is AccountEvent.Disconnected ->
                        resources.getString(if (e.revoked) R.string.account_disconnected else R.string.account_disconnected_not_revoked)
                }
            if (text != null) snackbar.showSnackbar(text)
        }
    }
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            if (uris.isNotEmpty()) library.import(uris)
        }
    val onImport = { picker.launch(arrayOf("text/html")) }

    LaunchedEffect(library) {
        library.messages.collect { e ->
            val text =
                when (e) {
                    is LibraryEvent.Imported ->
                        if (e.skipped == 0) {
                            resources.getString(R.string.import_done, e.imported)
                        } else {
                            resources.getString(R.string.import_done_skipped, e.imported, e.skipped)
                        }
                    LibraryEvent.NothingToImport -> resources.getString(R.string.import_none)
                    is LibraryEvent.Removed -> resources.getString(R.string.removed, e.title)
                }
            snackbar.showSnackbar(text)
        }
    }

    val top = backStack.lastOrNull()
    val inReader = top is ReaderKey || top is OnboardingKey || top is DiagnosticsKey
    val selected = TopLevel.entries.firstOrNull { it.key == top } ?: TopLevel.Library
    val defaultType = NavigationSuiteScaffoldDefaults.navigationSuiteType(currentWindowAdaptiveInfoV2())

    NavigationSuiteScaffold(
        layoutType = if (inReader) NavigationSuiteType.None else defaultType,
        navigationSuiteItems = {
            TopLevel.entries.forEach { dest ->
                item(
                    selected = !inReader && dest == selected,
                    onClick = {
                        backStack.clear()
                        backStack.add(LibraryKey)
                        if (dest.key != LibraryKey) backStack.add(dest.key)
                    },
                    icon = { Icon(painterResource(dest.icon), contentDescription = null) },
                    label = { Text(stringResource(dest.label)) },
                )
            }
        },
    ) {
        Scaffold(
            contentWindowInsets = WindowInsets(0),
            snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                NavDisplay(
                    backStack = backStack,
                    onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                    entryDecorators =
                        listOf(
                            rememberSaveableStateHolderNavEntryDecorator(),
                            rememberViewModelStoreNavEntryDecorator(),
                        ),
                    entryProvider =
                        entryProvider {
                            entry<LibraryKey> {
                                LibraryScreen(
                                    state = state,
                                    onQueryChange = library::setQuery,
                                    onImport = onImport,
                                    onOpen = { backStack.add(ReaderKey(it.key)) },
                                    onRemove = { library.remove(it.key) },
                                    needsReconnect = auth is AuthState.NeedsReconnect,
                                    onReconnect = account::connect,
                                    connected = auth is AuthState.Connected,
                                    onRefresh = library::syncNow,
                                    onFolder = library::setFolder,
                                    onPin = { e, pin -> library.setPinned(e.key, pin) },
                                    onShare = { e -> e.sha?.let { shareDocument(ShareRequest.of(e, it)) } },
                                )
                            }
                            entry<InboxKey> {
                                val vm: InboxViewModel = viewModel(factory = InboxViewModel.factory(container))
                                val inbox by vm.state.collectAsStateWithLifecycle()
                                LaunchedEffect(vm) {
                                    vm.messages.collect { e ->
                                        val res =
                                            when (e) {
                                                InboxEvent.Retried -> R.string.inbox_retried
                                                InboxEvent.RetryUnavailable -> R.string.inbox_retry_unavailable
                                            }
                                        snackbar.showSnackbar(resources.getString(res))
                                    }
                                }
                                InboxScreen(
                                    state = inbox,
                                    actions =
                                        InboxActions(
                                            onCancel = vm::cancel,
                                            onRetry = vm::retry,
                                            onDelete = vm::delete,
                                            onOpen = { backStack.add(ReaderKey(it)) },
                                            onShown = vm::shown,
                                            onConnect = account::connect,
                                            onReconnect = account::connect,
                                            onNotifications = { on ->
                                                vm.enableNotifications(on)
                                                if (on) requestNotifications()
                                            },
                                        ),
                                )
                            }
                            entry<SettingsKey> {
                                val vm: SyncSettingsViewModel = viewModel(factory = SyncSettingsViewModel.factory(container))
                                val sync by vm.state.collectAsStateWithLifecycle()
                                LaunchedEffect(vm) {
                                    vm.cleared.collect { snackbar.showSnackbar(resources.getString(R.string.cache_cleared)) }
                                }
                                SettingsScreen(
                                    onImport = onImport,
                                    auth = auth,
                                    onConnect = account::connect,
                                    onDisconnect = account::disconnect,
                                    onDiagnostics = { backStack.add(DiagnosticsKey) },
                                    sync = sync,
                                    syncActions =
                                        SyncSettingsActions(
                                            syncNow = vm::syncNow,
                                            setPolicy = vm::setPolicy,
                                            setLargeOnWifiOnly = vm::setLargeOnWifiOnly,
                                            clearCache = vm::clearCache,
                                        ),
                                )
                            }
                            entry<OnboardingKey> {
                                OnboardingScreen(
                                    auth = auth,
                                    onUseLocally = {
                                        finishOnboarding()
                                        onImport()
                                    },
                                    onConnect = account::connect,
                                    onDone = { finishOnboarding() },
                                    waitingForMac = state.sync.mac == null,
                                )
                            }
                            entry<DiagnosticsKey> {
                                val vm: DiagnosticsViewModel =
                                    viewModel(
                                        factory =
                                            DiagnosticsViewModel.factory(
                                                container.libraryIndex,
                                                container.driveProbe,
                                                container.preferences::deviceId,
                                            ),
                                    )
                                val docs by vm.documents.collectAsStateWithLifecycle()
                                val probe by vm.probeState.collectAsStateWithLifecycle()
                                DiagnosticsScreen(
                                    documents = docs.size,
                                    auth = auth,
                                    showProbe = BuildConfig.DEBUG,
                                    probe = probe,
                                    actions =
                                        ProbeActions(
                                            write = vm::write,
                                            list = vm::list,
                                            read = vm::read,
                                            startChanges = vm::startChanges,
                                            checkChanges = vm::checkChanges,
                                            deleteOwn = vm::deleteOwn,
                                            clear = vm::clear,
                                        ),
                                    onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                                )
                            }
                            entry<ReaderKey> { k ->
                                ReaderEntry(
                                    container = container,
                                    k = k,
                                    snackbar = snackbar,
                                    onShare = shareDocument,
                                    onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                                    onPreview = { p ->
                                        // From a preview, another preview replaces it instead of stacking up.
                                        if (k.previewSha != null && backStack.lastOrNull() == k) backStack.removeAt(backStack.lastIndex)
                                        backStack.add(ReaderKey(k.key, p.versionId, p.sha, p.label))
                                    },
                                )
                            }
                        },
                )
            }
        }
    }
}

/**
 * The Reader with its Versions sheet and Ask sheet (16 §6.2). The sheets' view model is scoped to
 * this back stack entry. Ask is offered only while the primary Mac accepts `ask` jobs.
 */
@Composable
private fun ReaderEntry(
    container: AppContainer,
    k: ReaderKey,
    snackbar: SnackbarHostState,
    onShare: (ShareRequest) -> Unit,
    onBack: () -> Unit,
    onPreview: (ReaderPreview) -> Unit,
) {
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val versions: VersionsViewModel = viewModel(factory = VersionsViewModel.factory(container, k.key))
    val vstate by versions.state.collectAsStateWithLifecycle()
    val status by container.syncRepository.status.collectAsStateWithLifecycle()
    var showVersions by rememberSaveable { mutableStateOf(false) }
    var askSections by remember { mutableStateOf<List<OutlineSection>?>(null) }

    LaunchedEffect(versions) {
        versions.messages.collect { e ->
            when (e) {
                is VersionsEvent.Preview -> {
                    showVersions = false
                    onPreview(ReaderPreview(e.versionId, e.sha, e.label))
                }
                VersionsEvent.CheckoutQueued -> {
                    showVersions = false
                    snackbar.showSnackbar(resources.getString(R.string.versions_checkout_sent))
                }
                VersionsEvent.CheckoutFailed -> snackbar.showSnackbar(resources.getString(R.string.versions_checkout_failed))
            }
        }
    }

    val preview = k.previewSha?.let { sha -> k.previewVersionId?.let { ReaderPreview(it, sha, k.previewLabel.orEmpty()) } }
    if (preview != null) {
        // Entry-scoped: the preview's file stays through rotation and goes when the entry is popped.
        viewModel<PreviewLease>(
            key = "preview-${preview.sha}",
            factory = PreviewLease.factory(container.libraryIndex, k.key, preview.sha, container.appScope),
        )
    }
    val currentLabel = vstate.items.firstOrNull { it.row.isCurrent }?.label
    val acceptsAsk = status.mac?.accepts?.contains(JobKind.ASK) == true
    ReaderScreen(
        key = k.key,
        index = container.libraryIndex,
        store = container.docStore,
        onBack = onBack,
        onFetch = container.syncRepository::fetch,
        onSavePosition = { key, sha, pos ->
            // App scope: the screen's own scope is gone by the time the WebView is released.
            container.appScope.launch { container.libraryIndex.saveReadingPosition(key, sha, pos) }
        },
        preview = preview,
        onFetchVersion = container.syncRepository::fetchVersion,
        versionLabel = currentLabel,
        onVersions = { showVersions = true },
        onAsk =
            if (acceptsAsk) {
                { sha ->
                    scope.launch {
                        // Reading and parsing a whole document stays off the main thread.
                        askSections =
                            withContext(Dispatchers.Default) {
                                container.docStore.read(k.key, sha)?.let { DocOutline.of(it.toString(Charsets.UTF_8)) }.orEmpty()
                            }
                    }
                }
            } else {
                null
            },
        onMakeCurrent =
            preview
                ?.takeIf { p -> vstate.canCheckout && vstate.items.none { it.row.id == p.versionId && it.row.isCurrent } }
                ?.let { p -> { versions.checkout(p.versionId) } },
        onShare = { e, sha -> onShare(ShareRequest.of(e, sha)) },
    )
    if (showVersions) {
        VersionsSheet(
            state = vstate,
            actions = VersionsActions(onToggle = versions::toggle, onPreview = versions::preview, onCheckout = versions::checkout),
            onDismiss = { showVersions = false },
        )
    }
    val sections = askSections
    if (sections != null) {
        AskSheet(
            sections = sections,
            onSend = { section, question ->
                askSections = null
                val docId = vstate.docId
                scope.launch {
                    val ok =
                        docId != null &&
                            try {
                                container.outbox.queueAsk(docId, section.id, section.hash, question, question)
                                true
                            } catch (_: ProtocolException) {
                                false
                            } catch (_: IOException) {
                                false
                            }
                    snackbar.showSnackbar(resources.getString(if (ok) R.string.ask_sent else R.string.ask_failed))
                }
            },
            onDismiss = { askSections = null },
        )
    }
}
