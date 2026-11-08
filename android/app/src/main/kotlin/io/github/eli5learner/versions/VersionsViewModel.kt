package io.github.eli5learner.versions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.AppContainer
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.db.VersionEntity
import io.github.eli5learner.sync.MacInfo
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.sync.protocol.ProtocolException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeParseException

/** One row of the Versions sheet. */
data class VersionItem(
    val row: VersionRow,
    val label: String,
    /** The kind of change, as the wire names it (`expand`, `ask`, …). */
    val kind: String,
    /** Epoch ms. */
    val createdAt: Long,
    /** The Mac uploaded this version, or it is on the phone already: it can be previewed. */
    val available: Boolean,
    val sha: String?,
)

data class VersionsUiState(
    val loaded: Boolean = false,
    val docId: String? = null,
    val title: String = "",
    val items: List<VersionItem> = emptyList(),
    /** The primary Mac runs `checkout` jobs: "Make current on your Mac" is offered (16 §4.3). */
    val canCheckout: Boolean = false,
    /** The Mac has the inbox off or paused: a request waits until it is on again. */
    val macNotTaking: Boolean = false,
    /** "Your Mac is updating this document" (16 §4.4 `busy`). */
    val busy: Boolean = false,
)

sealed interface VersionsEvent {
    /** A checkout job is in the outbox. */
    data object CheckoutQueued : VersionsEvent

    data object CheckoutFailed : VersionsEvent

    /** Open the Reader on this version. */
    data class Preview(
        val versionId: String,
        val sha: String,
        val label: String,
    ) : VersionsEvent
}

/** What the Versions sheet needs from the rest of the app; fakes in tests. */
interface VersionsDeps {
    val doc: Flow<DocEntry?>
    val versions: Flow<List<VersionEntity>>
    val mac: Flow<MacInfo?>

    /** Whether `<key>/<sha>.html` is on the phone. */
    fun onPhone(sha: String): Boolean

    suspend fun checkout(
        docId: String,
        versionId: String,
        title: String,
    )
}

/**
 * The read-only version tree of one synced document (16 §6.2 Versions): lanes from
 * [VersionTreeLayout], a preview of any version the Mac uploaded (older ones download on demand), and
 * "Make current on your Mac", which queues a `checkout` job (16 §5.1) when the primary accepts it.
 * Versions without an uploaded copy read "Not available on this phone".
 */
class VersionsViewModel(
    private val deps: VersionsDeps,
) : ViewModel() {
    private val collapsed = MutableStateFlow<Set<String>>(emptySet())
    private val events = Channel<VersionsEvent>(Channel.BUFFERED)
    val messages: Flow<VersionsEvent> = events.receiveAsFlow()

    val state: StateFlow<VersionsUiState> =
        combine(deps.doc, deps.versions, deps.mac, collapsed) { doc, versions, mac, closed ->
            stateOf(doc, versions, mac, closed, deps::onPhone)
        }.stateIn(viewModelScope, SharingStarted.Eagerly, VersionsUiState())

    /** Expands or collapses a branch point (a forced one, holding the current version, stays open). */
    fun toggle(id: String) = collapsed.update { if (id in it) it - id else it + id }

    fun preview(versionId: String) {
        val item = state.value.items.firstOrNull { it.row.id == versionId } ?: return
        val sha = item.sha ?: return
        if (!item.available) return
        viewModelScope.launch { events.send(VersionsEvent.Preview(versionId, sha, item.label)) }
    }

    /** "Make current on your Mac" for [versionId]. */
    fun checkout(versionId: String) {
        val s = state.value
        val docId = s.docId ?: return
        val item = s.items.firstOrNull { it.row.id == versionId } ?: return
        if (!s.canCheckout || item.row.isCurrent) return
        viewModelScope.launch {
            val ok =
                try {
                    deps.checkout(docId, versionId, checkoutTitle(s.title, item.label))
                    true
                } catch (_: ProtocolException) {
                    false
                } catch (_: IOException) {
                    false
                }
            events.send(if (ok) VersionsEvent.CheckoutQueued else VersionsEvent.CheckoutFailed)
        }
    }

    companion object {
        /** The Inbox label of a checkout; local only. */
        fun checkoutTitle(
            docTitle: String,
            versionLabel: String,
        ): String = "$docTitle · $versionLabel"

        fun stateOf(
            doc: DocEntry?,
            versions: List<VersionEntity>,
            mac: MacInfo?,
            collapsed: Set<String>,
            onPhone: (String) -> Boolean,
        ): VersionsUiState {
            if (doc == null || !doc.synced) return VersionsUiState(loaded = true, title = doc?.title.orEmpty())
            val byId = versions.associateBy { it.id }
            val rows =
                VersionTreeLayout.layout(
                    versions.map { LayoutNode(it.id, it.parentId, it.createdAt) },
                    doc.currentVersionId,
                    collapsed,
                )
            val items =
                rows.map { r ->
                    val v = byId.getValue(r.id)
                    VersionItem(
                        row = r,
                        label = v.label,
                        kind = v.kind,
                        createdAt = epochMs(v.createdAt),
                        available = v.sha != null && (v.uploaded || onPhone(v.sha)),
                        sha = v.sha,
                    )
                }
            val accepts = mac?.accepts.orEmpty()
            return VersionsUiState(
                loaded = true,
                docId = doc.docId ?: doc.key,
                title = doc.title,
                items = items,
                canCheckout = JobKind.CHECKOUT in accepts,
                macNotTaking = mac != null && mac.inbox != InboxState.ON,
                busy = doc.busy,
            )
        }

        private fun epochMs(iso: String): Long =
            try {
                Instant.parse(iso).toEpochMilli()
            } catch (_: DateTimeParseException) {
                0L
            }

        fun factory(
            container: AppContainer,
            key: String,
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    VersionsViewModel(
                        object : VersionsDeps {
                            override val doc = container.libraryIndex.observe(key)
                            override val versions = container.db.versions().observe(key)
                            override val mac = container.syncRepository.status.map { it.mac }

                            override fun onPhone(sha: String) = container.docStore.exists(key, sha)

                            override suspend fun checkout(
                                docId: String,
                                versionId: String,
                                title: String,
                            ) {
                                container.outbox.queueCheckout(docId, versionId, title)
                            }
                        },
                    )
                }
            }
    }
}
