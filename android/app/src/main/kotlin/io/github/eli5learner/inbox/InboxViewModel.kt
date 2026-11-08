package io.github.eli5learner.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.AppContainer
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.db.JobEntity
import io.github.eli5learner.sync.MacInfo
import io.github.eli5learner.sync.SyncStatus
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** The Inbox chips (16 §6.2). */
enum class InboxChip {
    /** Not connected: the capture waits until Google Drive is connected. */
    CONNECT_TO_SEND,
    WAITING_TO_UPLOAD,
    WAITING_FOR_MAC,
    QUEUED,
    GENERATING,
    CANCELLING,
    READY,
    BUILT_SKIPPED,
    FAILED,
    CANCELLED,
}

data class InboxItem(
    val jobId: String,
    val title: String,
    val createdAt: Long,
    val chip: InboxChip,
    /** The desktop's one-line stage while generating. */
    val stage: String? = null,
    /** The desktop's one-line reason for a failure; null for a local one. */
    val reason: String? = null,
    val skippedSources: Int = 0,
    val attachments: Int = 0,
    /** The finished document is in the library: Open. */
    val openKey: String? = null,
    val canCancel: Boolean = false,
    val canRetry: Boolean = false,
    val canDelete: Boolean = false,
    val terminal: Boolean = false,
)

data class InboxUiState(
    val items: List<InboxItem> = emptyList(),
    val connected: Boolean = false,
    val needsReconnect: Boolean = false,
    val mac: MacInfo? = null,
    val waitingForMac: Boolean = false,
    /** Offer "Notify me when learnings are ready" (asked, and the user said no or never answered). */
    val offerNotifications: Boolean = false,
)

sealed interface InboxEvent {
    /** Retry could not resend: the shared files are no longer on this phone. */
    data object RetryUnavailable : InboxEvent

    data object Retried : InboxEvent
}

/** What the Inbox needs from the rest of the app; fakes in tests. */
interface InboxDeps {
    val jobs: Flow<List<JobEntity>>
    val auth: Flow<AuthState>
    val sync: Flow<SyncStatus>

    /** Library keys (synced documents use their docId), so a finished job can open its document. */
    val libraryKeys: Flow<Set<String>>
    val notificationsOn: Flow<Boolean?>

    suspend fun cancel(jobId: String)

    suspend fun delete(jobId: String)

    suspend fun retry(jobId: String): Boolean

    suspend fun markShown(jobIds: Collection<String>)

    suspend fun setNotifications(on: Boolean)

    fun syncNow()
}

class InboxViewModel(
    private val deps: InboxDeps,
) : ViewModel() {
    private val events = Channel<InboxEvent>(Channel.BUFFERED)
    val messages: Flow<InboxEvent> = events.receiveAsFlow()

    val state: StateFlow<InboxUiState> =
        combine(deps.jobs, deps.auth, deps.sync, deps.libraryKeys, deps.notificationsOn) { jobs, auth, sync, keys, notify ->
            val connected = auth is AuthState.Connected
            InboxUiState(
                items = jobs.map { itemOf(it, connected, keys) },
                connected = connected,
                needsReconnect = auth is AuthState.NeedsReconnect,
                mac = sync.mac,
                waitingForMac = sync.waitingForMac,
                offerNotifications = notify != true && jobs.isNotEmpty(),
            )
        }.stateIn(viewModelScope, SharingStarted.Eagerly, InboxUiState())

    fun cancel(jobId: String) = launch { deps.cancel(jobId) }

    fun delete(jobId: String) = launch { deps.delete(jobId) }

    fun retry(jobId: String) =
        launch {
            events.send(if (deps.retry(jobId)) InboxEvent.Retried else InboxEvent.RetryUnavailable)
        }

    /** The Inbox is on screen with these terminal jobs (16 §5.2 step 4). */
    fun shown(jobIds: Collection<String>) {
        if (jobIds.isNotEmpty()) launch { deps.markShown(jobIds) }
    }

    fun enableNotifications(on: Boolean) = launch { deps.setNotifications(on) }

    fun syncNow() = deps.syncNow()

    private fun launch(block: suspend () -> Unit) {
        viewModelScope.launch { block() }
    }

    companion object {
        /** How one job reads in the Inbox. */
        fun itemOf(
            job: JobEntity,
            connected: Boolean,
            libraryKeys: Set<String> = emptySet(),
        ): InboxItem {
            val remote = job.remoteState
            val chip =
                when {
                    job.local == JobEntity.BROKEN -> InboxChip.FAILED
                    job.local == JobEntity.CANCELLED || remote == "cancelled" -> InboxChip.CANCELLED
                    // Cancel on a job whose upload may already have reached Drive: a cancel file follows.
                    job.local == JobEntity.LOCAL && job.cancelRequested -> InboxChip.CANCELLING
                    job.local == JobEntity.LOCAL -> if (connected) InboxChip.WAITING_TO_UPLOAD else InboxChip.CONNECT_TO_SEND
                    remote == "done" -> if ((job.skippedSources ?: 0) > 0) InboxChip.BUILT_SKIPPED else InboxChip.READY
                    remote == "failed" || remote == "rejected" -> InboxChip.FAILED
                    job.cancelRequested && remote != "running" -> InboxChip.CANCELLING
                    remote == "running" -> InboxChip.GENERATING
                    remote == "queued" -> InboxChip.QUEUED
                    else -> InboxChip.WAITING_FOR_MAC
                }
            val failed = chip == InboxChip.FAILED
            val cancellable =
                !job.cancelRequested &&
                    (job.local == JobEntity.LOCAL || (job.local == JobEntity.UPLOADED && (remote == null || remote == "received" || remote == "queued")))
            return InboxItem(
                jobId = job.jobId,
                title = job.title,
                createdAt = job.createdAt,
                chip = chip,
                stage = job.stage?.takeIf { chip == InboxChip.GENERATING },
                reason = job.reason?.takeIf { failed },
                skippedSources = (job.skippedSources ?: 0).toInt(),
                attachments = job.attachmentCount,
                openKey = job.docId?.takeIf { remote == "done" && it in libraryKeys },
                canCancel = cancellable,
                canRetry = failed && job.kind == "capture",
                canDelete = job.terminal,
                terminal = job.terminal,
            )
        }

        fun factory(container: AppContainer): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    val outbox = container.outbox
                    InboxViewModel(
                        object : InboxDeps {
                            override val jobs = outbox.jobs
                            override val auth = container.authorizer.state
                            override val sync = container.syncRepository.status
                            override val libraryKeys = container.libraryIndex.entries.map { l -> l.map { it.key }.toSet() }
                            override val notificationsOn = container.preferences.readyNotifications

                            override suspend fun cancel(jobId: String) = outbox.cancel(jobId)

                            override suspend fun delete(jobId: String) = outbox.delete(jobId)

                            override suspend fun retry(jobId: String) = outbox.retry(jobId)

                            override suspend fun markShown(jobIds: Collection<String>) = outbox.markShown(jobIds)

                            override suspend fun setNotifications(on: Boolean) {
                                container.preferences.setReadyNotifications(on)
                                if (on) container.readyNotifier.ensureChannel()
                            }

                            override fun syncNow() {
                                container.syncScheduler.syncNow()
                            }
                        },
                    )
                }
            }
    }
}
