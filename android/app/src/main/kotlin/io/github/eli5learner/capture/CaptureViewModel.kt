package io.github.eli5learner.capture

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.AppContainer
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.inbox.CaptureDraft
import io.github.eli5learner.inbox.JobIds
import io.github.eli5learner.inbox.OutboxRepository
import io.github.eli5learner.sync.SyncStatus
import io.github.eli5learner.sync.protocol.Attachment
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.sync.protocol.Limits
import io.github.eli5learner.sync.protocol.ProtocolException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** One shared file as read from the sharing app: at most [Limits.ATTACHMENT_BYTES] + 1 bytes. */
class SharedFile(
    val name: String?,
    val declaredType: String?,
    val bytes: ByteArray,
)

/** Reads a shared `content:` URI; null when it cannot be read. */
fun interface ShareReader {
    fun read(uri: Uri): SharedFile?
}

/** Why a shared item is not part of the capture (one line each in the sheet). */
enum class RefusalReason { TOO_LARGE, JOB_TOO_LARGE, TOO_MANY, TYPE, UNREADABLE }

data class Refusal(
    val name: String?,
    val reason: RefusalReason,
)

/** A file copied into the outbox, ready to be an attachment. */
data class StagedFile(
    val sha: String,
    val name: String,
    val mime: String,
    val size: Long,
)

data class CaptureUiState(
    /** Shared files are still being copied. */
    val loading: Boolean = true,
    val urls: List<String> = emptyList(),
    val text: String = "",
    val textShortened: Boolean = false,
    val refusedUrls: Int = 0,
    val files: List<StagedFile> = emptyList(),
    val refusals: List<Refusal> = emptyList(),
    val clarifyingInput: String = "",
    val focus: Set<FocusChip> = emptySet(),
    val sending: Boolean = false,
    /** Google Drive is connected; otherwise the capture waits in the Inbox. */
    val connected: Boolean = false,
    /** The primary Mac is known and not taking jobs (inbox off, or capture not accepted). */
    val macPaused: Boolean = false,
) {
    val canSend: Boolean get() = !loading && !sending && (urls.isNotEmpty() || text.isNotBlank() || files.isNotEmpty())
}

sealed interface CaptureEvent {
    /** Queued; [askNotifications] on the first capture (16 §6.1: the channel is opt-in after it). */
    data class Sent(
        val askNotifications: Boolean,
    ) : CaptureEvent

    /** The capture could not be queued (a full disk, or it failed the wire rules). */
    data object Failed : CaptureEvent
}

/**
 * The capture sheet (16 §5.2 step 1, §6.2): copies the shared bytes into the outbox at once (URI
 * grants are short-lived), sniffs each file's type, refuses what is over the caps with a one-line
 * reason, and queues the job on Send. Never waits for the network.
 */
class CaptureViewModel(
    input: ShareInput,
    private val outbox: OutboxRepository,
    private val reader: ShareReader,
    auth: Flow<AuthState> = flowOf(AuthState.Disconnected),
    sync: Flow<SyncStatus> = flowOf(SyncStatus()),
    /** True until the user answered "Tell you when it's ready?". */
    private val shouldAskNotifications: suspend () -> Boolean = { false },
    val jobId: String = JobIds.new(),
) : ViewModel() {
    private val _state = MutableStateFlow(CaptureUiState())
    val state: StateFlow<CaptureUiState> = _state.asStateFlow()

    private val events = Channel<CaptureEvent>(Channel.BUFFERED)
    val messages: Flow<CaptureEvent> = events.receiveAsFlow()

    private val subject = input.subject
    private var queued = false

    init {
        viewModelScope.launch {
            val t = TextExtractor.extract(input.text)
            val (files, refusals) = withContext(Dispatchers.IO) { stageAll(input) }
            _state.update {
                it.copy(
                    loading = false,
                    urls = t.urls,
                    text = t.text,
                    textShortened = t.shortened,
                    refusedUrls = t.refusedUrls,
                    files = files,
                    refusals = refusals,
                )
            }
        }
        viewModelScope.launch { auth.collect { a -> _state.update { it.copy(connected = a is AuthState.Connected) } } }
        viewModelScope.launch {
            sync.collect { s ->
                val mac = s.mac
                _state.update { it.copy(macPaused = mac != null && (mac.inbox != InboxState.ON || JobKind.CAPTURE !in mac.accepts)) }
            }
        }
    }

    private fun stageAll(input: ShareInput): Pair<List<StagedFile>, List<Refusal>> {
        val files = mutableListOf<StagedFile>()
        val refusals = mutableListOf<Refusal>()
        repeat(input.droppedStreams) { refusals += Refusal(null, RefusalReason.UNREADABLE) }
        var total = 0L
        for (uri in input.streams) {
            if (files.size >= Limits.ATTACHMENTS) {
                refusals += Refusal(null, RefusalReason.TOO_MANY)
                continue
            }
            val shared =
                try {
                    reader.read(uri)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: RuntimeException) {
                    null
                }
            if (shared == null || shared.bytes.isEmpty()) {
                refusals += Refusal(shared?.name, RefusalReason.UNREADABLE)
                continue
            }
            val size = shared.bytes.size.toLong()
            if (size > Limits.ATTACHMENT_BYTES) {
                refusals += Refusal(shared.name, RefusalReason.TOO_LARGE)
                continue
            }
            val mime = MimeSniffer.sniff(shared.bytes, shared.declaredType, shared.name)
            if (mime == null) {
                refusals += Refusal(shared.name, RefusalReason.TYPE)
                continue
            }
            val sha = DocStore.sha256Hex(shared.bytes)
            if (files.any { it.sha == sha }) continue
            if (total + size > Limits.JOB_ATTACHMENT_BYTES) {
                refusals += Refusal(shared.name, RefusalReason.JOB_TOO_LARGE)
                continue
            }
            try {
                outbox.stage(jobId, shared.bytes)
            } catch (_: IOException) {
                refusals += Refusal(shared.name, RefusalReason.UNREADABLE)
                continue
            }
            total += size
            files += StagedFile(sha, AttachmentNames.sanitize(shared.name, mime, files.size), mime, size)
        }
        return files to refusals
    }

    fun setClarifyingInput(s: String) {
        val capped = if (s.codePointCount(0, s.length) > Limits.CLARIFYING_INPUT_CHARS) s.substring(0, s.offsetByCodePoints(0, Limits.CLARIFYING_INPUT_CHARS)) else s
        _state.update { it.copy(clarifyingInput = capped) }
    }

    fun toggleFocus(chip: FocusChip) {
        _state.update { it.copy(focus = if (chip in it.focus) it.focus - chip else it.focus + chip) }
    }

    /** "Send to my Mac": queue and return at once; the upload runs in the background. */
    fun send() {
        val s = _state.value
        if (!s.canSend) return
        _state.update { it.copy(sending = true) }
        viewModelScope.launch {
            val draft =
                CaptureDraft(
                    jobId = jobId,
                    urls = s.urls,
                    text = s.text,
                    clarifyingInput = s.clarifyingInput.trim(),
                    focus = FocusChip.entries.filter { it in s.focus },
                    attachments = s.files.map { Attachment(it.sha, it.name, it.mime, it.size) },
                    title = subject.orEmpty(),
                )
            val ok =
                try {
                    outbox.queueCapture(draft)
                    true
                } catch (e: CancellationException) {
                    throw e
                } catch (_: ProtocolException) {
                    false
                } catch (_: IOException) {
                    false
                } catch (_: RuntimeException) {
                    false
                }
            if (ok) {
                queued = true
                events.send(CaptureEvent.Sent(askNotifications = shouldAskNotifications()))
            } else {
                _state.update { it.copy(sending = false) }
                events.send(CaptureEvent.Failed)
            }
        }
    }

    override fun onCleared() {
        // Dismissed without sending: the staged copies go.
        if (!queued) runCatching { outbox.discard(jobId) }
    }

    companion object {
        /**
         * Reads the name and at most the attachment cap plus one byte, so an oversized file is refused,
         * not loaded. A URI served by this app itself ([isOwn]) is refused: another app must not be
         * able to make the capture read (and upload) this app's own files.
         */
        fun contentReader(
            resolver: ContentResolver,
            isOwn: (Uri) -> Boolean = { false },
        ): ShareReader =
            ShareReader { uri ->
                if (uri.scheme != ContentResolver.SCHEME_CONTENT || isOwn(uri)) return@ShareReader null
                runCatching {
                    val name =
                        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                            if (c.moveToFirst()) c.getString(0) else null
                        }
                    val bytes = resolver.openInputStream(uri)?.use { readAtMost(it, Limits.ATTACHMENT_BYTES + 1) } ?: return@runCatching null
                    SharedFile(name, resolver.getType(uri), bytes)
                }.getOrNull()
            }

        fun factory(
            container: AppContainer,
            input: ShareInput,
            resolver: ContentResolver,
            isOwn: (Uri) -> Boolean = { false },
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    CaptureViewModel(
                        input = input,
                        outbox = container.outbox,
                        reader = contentReader(resolver, isOwn),
                        auth = container.authorizer.state,
                        sync = container.syncRepository.status,
                        shouldAskNotifications = { container.preferences.readyNotificationsAnswer() == null },
                    )
                }
            }
    }
}
