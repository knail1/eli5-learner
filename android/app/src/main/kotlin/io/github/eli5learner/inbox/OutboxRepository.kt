package io.github.eli5learner.inbox

import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.capture.MimeSniffer
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.SyncPrefs
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.data.db.JobAttachmentEntity
import io.github.eli5learner.data.db.JobEntity
import io.github.eli5learner.data.db.RemoteFileEntity
import io.github.eli5learner.drive.DriveApi
import io.github.eli5learner.drive.DriveFile
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import io.github.eli5learner.sync.JobSync
import io.github.eli5learner.sync.SyncOutcome
import io.github.eli5learner.sync.protocol.Acks
import io.github.eli5learner.sync.protocol.Attachment
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.sync.protocol.JobCancel
import io.github.eli5learner.sync.protocol.JobRequest
import io.github.eli5learner.sync.protocol.JobState
import io.github.eli5learner.sync.protocol.Limits
import io.github.eli5learner.sync.protocol.PROTOCOL_VERSION
import io.github.eli5learner.sync.protocol.Patterns
import io.github.eli5learner.sync.protocol.ProtocolException
import io.github.eli5learner.sync.protocol.SyncProtocol
import io.github.eli5learner.util.AppVersions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.UUID

/** A capture ready to queue: the shared bytes are already staged under the job's outbox folder. */
data class CaptureDraft(
    val jobId: String,
    val urls: List<String>,
    val text: String,
    val clarifyingInput: String,
    val focus: List<FocusChip>,
    val attachments: List<Attachment>,
    /** Local label for the Inbox; never sent. */
    val title: String,
    /** Also write the Deadpan tab; the caller sends it only to a Mac that reads it (16 §5.1). */
    val deadpan: Boolean = false,
)

/**
 * The phone's outbox and job statuses (16 §5.2, §4.7): captures wait in `filesDir/outbox/<jobId>/`
 * (`request.json`, one file per attachment named by its sha, and an `uploaded` marker), mirrored in
 * Room. [upload] sends each waiting job's attachments, then its job file (attachments first, so the
 * desktop never sees a job whose files are missing), then cancel files and the acks file. [afterPull]
 * reads the desktop's `jobstatus` files from the pull's index, posts "Learnings ready", writes acks,
 * and forgets jobs the desktop has collected.
 *
 * Every file the phone writes is created under a preallocated id persisted first, so a retry after a
 * lost response finds the same file instead of a duplicate. Room is a cache: when its table is empty
 * the jobs are rebuilt from the outbox folders. Nothing here logs titles, URLs or text (16 §9).
 */
class OutboxRepository(
    private val db: Eli5Db,
    val root: File,
    private val drive: DriveApi,
    private val prefs: SyncPrefs,
    private val authState: suspend () -> AuthState,
    private val prepareAuth: suspend () -> Unit = {},
    /** Enqueues the [UploadWorker] (expedited, network-constrained). */
    private val kickUpload: () -> Unit = {},
    /** Posts "Learnings ready" for a finished job; true when a notification was shown. */
    private val notifyReady: suspend (JobEntity) -> Boolean = { false },
    private val now: () -> Long = System::currentTimeMillis,
    /** The primary Mac's app version as last seen (null when unknown); Retry re-checks the Deadpan gate with it. */
    private val macVersion: suspend () -> String? = { null },
) : JobSync {
    private val dao = db.jobs()

    /** Serializes uploads and status passes; short row updates take [writes] instead. */
    private val pass = Mutex()

    /** Row and folder changes from the UI and the passes, so a cancel never races a half-written row. */
    private val writes = Mutex()

    /** One Retry at a time, so a double tap resends a capture once. */
    private val retrying = Mutex()

    @Volatile private var rebuilt = false

    val jobs: Flow<List<JobEntity>> = dao.observeVisible()

    /** A job waits to upload or for a terminal status (the foreground poll, 16 §4.8). */
    val active: Flow<Boolean> = dao.observeActive()

    // ------------------------------------------------------------------------------- capture

    /** The job's outbox folder, created on demand. */
    fun dir(jobId: String): File {
        require(Patterns.JOB_ID.matches(jobId)) { "invalid job id" }
        return File(root, jobId)
    }

    /** Copies one shared file into the job's folder (atomic write) and returns its sha. */
    @Throws(IOException::class)
    fun stage(
        jobId: String,
        bytes: ByteArray,
    ): String {
        val sha = DocStore.sha256Hex(bytes)
        writeAtomic(File(dir(jobId), sha), bytes)
        return sha
    }

    /** Removes a capture that was never queued (the sheet was dismissed). */
    fun discard(jobId: String) {
        val d = dir(jobId)
        if (!File(d, REQUEST).exists()) d.deleteRecursively()
    }

    /**
     * Queues a capture (16 §5.2 step 2): validates it against the wire rules, writes `request.json`,
     * stores the rows as waiting, and asks for an upload. Never touches the network.
     */
    @Throws(ProtocolException::class, IOException::class)
    suspend fun queueCapture(draft: CaptureDraft): JobEntity {
        val request =
            JobRequest.Capture(
                v = PROTOCOL_VERSION,
                jobId = draft.jobId,
                deviceId = prefs.deviceId(),
                createdAt = iso(now()),
                urls = draft.urls,
                text = draft.text,
                clarifyingInput = draft.clarifyingInput,
                focus = draft.focus,
                attachments = draft.attachments,
                deadpan = draft.deadpan,
            )
        return queue(request, draft.title)
    }

    /**
     * "Make current on your Mac" (16 §6.2 Versions): a `checkout` job for [versionId] of [docId].
     * [title] is the Inbox label and never leaves the phone.
     */
    @Throws(ProtocolException::class, IOException::class)
    suspend fun queueCheckout(
        docId: String,
        versionId: String,
        title: String,
    ): JobEntity =
        queue(
            JobRequest.Checkout(
                v = PROTOCOL_VERSION,
                jobId = JobIds.new(now()),
                deviceId = prefs.deviceId(),
                createdAt = iso(now()),
                docId = docId,
                versionId = versionId,
            ),
            title,
        )

    /**
     * A question about one section (16 §5.1 `ask`, §6.2 Ask). [sectionHash] is the 08 §6.3 hash of
     * the section as this phone shows it; the desktop answers `E_STALE` when the section has changed.
     */
    @Throws(ProtocolException::class, IOException::class)
    suspend fun queueAsk(
        docId: String,
        sectionId: String,
        sectionHash: String,
        question: String,
        title: String,
    ): JobEntity =
        queue(
            JobRequest.Ask(
                v = PROTOCOL_VERSION,
                jobId = JobIds.new(now()),
                deviceId = prefs.deviceId(),
                createdAt = iso(now()),
                docId = docId,
                sectionId = sectionId,
                sectionHash = sectionHash,
                question = question,
            ),
            title,
        )

    /** Validates [request] (encode checks the wire rules), writes `request.json`, stores the rows, asks for an upload. */
    private suspend fun queue(
        request: JobRequest,
        title: String,
    ): JobEntity {
        val body = SyncProtocol.encode(JobRequest.serializer(), request)
        val d = dir(request.jobId)
        withContext(Dispatchers.IO) {
            for (a in (request as? JobRequest.Capture)?.attachments.orEmpty()) {
                val f = File(d, a.sha)
                if (!f.isFile || f.length() != a.size) throw IOException("attachment not staged")
            }
            writeAtomic(File(d, REQUEST), body.toByteArray())
        }
        val row = rowOf(request, title.ifBlank { titleOf(request) }, uploaded = false)
        writes.withLock { dao.insert(row, attachmentRows(request)) }
        kickUpload()
        return row
    }

    // -------------------------------------------------------------------------------- upload

    /**
     * Sends everything the phone owes the store: waiting jobs (attachments, then the job file), cancel
     * files, then the acks file. Local mode makes no request; a lost grant stops without retries.
     */
    suspend fun upload(): SyncOutcome =
        pass.withLock {
            when (authState()) {
                is AuthState.Connected -> Unit
                is AuthState.NeedsReconnect -> return@withLock SyncOutcome.NeedsReconnect
                else -> return@withLock SyncOutcome.NotConnected
            }
            try {
                ensureRebuilt()
                prepareAuth()
                val me = prefs.deviceId()
                for (job in dao.waiting()) uploadJob(job, me)
                for (job in dao.uploaded()) if (job.cancelRequested && job.cancelFileId == null && !job.terminal) writeCancel(job, me)
                writeAcks(me)
                SyncOutcome.Synced
            } catch (e: CancellationException) {
                throw e
            } catch (e: SyncException) {
                when (e.code) {
                    SyncErrorCode.E_SYNC_AUTH -> SyncOutcome.NeedsReconnect
                    SyncErrorCode.E_SYNC_QUOTA, SyncErrorCode.E_SYNC_API_DISABLED -> SyncOutcome.Failed(e.code)
                    else -> SyncOutcome.Transient(e.code)
                }
            } catch (e: IOException) {
                SyncOutcome.Failed(SyncErrorCode.E_SYNC_HTTP)
            } catch (e: RuntimeException) {
                SyncOutcome.Failed(SyncErrorCode.E_SYNC_HTTP)
            }
        }

    private suspend fun uploadJob(
        job: JobEntity,
        me: String,
    ) {
        val d = dir(job.jobId)
        val body = withContext(Dispatchers.IO) { runCatching { File(d, REQUEST).readBytes() }.getOrNull() }
        val request = body?.let { runCatching { SyncProtocol.decodeJob(it.decodeToString()) }.getOrNull() }
        if (request == null || request.jobId != job.jobId || request.deviceId != me) {
            // Unreadable, or written under another device id (app data restored elsewhere): never sent.
            update(job.jobId) { it.copy(local = JobEntity.BROKEN, terminalAt = now()) }
            return
        }
        // A job file from an earlier attempt whose response was lost: done already.
        job.pendingJobFileId?.let { pending ->
            ownJobFile(pending, job.jobId, me)?.let {
                markUploaded(job.jobId, it.id)
                return
            }
        }
        if (cancelledBeforeSend(job.jobId)) return

        for (att in dao.attachments(job.jobId)) {
            if (att.remoteFileId != null) continue
            uploadAttachment(job.jobId, att, me) ?: return
        }

        if (cancelledBeforeSend(job.jobId)) return
        // The id is persisted under the same lock Cancel takes, and only while the job is not being
        // cancelled: a Cancel that lands meanwhile either removes the job first (nothing is sent) or
        // sees the id and asks for a cancel file.
        val id =
            job.pendingJobFileId ?: allocate { fileId ->
                writes.withLock {
                    val row = dao.get(job.jobId)
                    if (row == null || row.cancelRequested) return@withLock false
                    dao.upsert(row.copy(pendingJobFileId = fileId))
                    true
                }
            } ?: run {
                cancelledBeforeSend(job.jobId)
                return
            }
        val props = mapOf("k" to KIND_JOB, "dev" to me, "s" to job.jobId)
        val created = drive.create(id, "job-${job.jobId}.json", props, JSON_MIME, body)
        checkOwn(created, props) { update(job.jobId) { it.copy(pendingJobFileId = null) } }
        markUploaded(job.jobId, created.id)
    }

    /** Uploads one attachment unless the store already has it; null when the job went away meanwhile. */
    private suspend fun uploadAttachment(
        jobId: String,
        att: JobAttachmentEntity,
        me: String,
    ): Unit? {
        val existing = drive.list(mapOf("k" to KIND_ATT, "s" to att.sha)).firstOrNull { it.sha256Checksum == null || it.sha256Checksum == att.sha }
        if (existing != null) {
            return writes.withLock {
                if (dao.get(jobId) == null) return@withLock null
                dao.upsertAttachment(att.copy(remoteFileId = existing.id))
            }
        }
        val bytes = withContext(Dispatchers.IO) { runCatching { File(dir(jobId), att.sha).readBytes() }.getOrNull() }
        if (bytes == null || DocStore.sha256Hex(bytes) != att.sha) {
            // The job may have been cancelled and its folder removed meanwhile.
            update(jobId) { it.copy(local = JobEntity.BROKEN, terminalAt = now()) }
            return null
        }
        val id =
            att.pendingFileId ?: allocate { fileId ->
                writes.withLock {
                    if (dao.get(jobId) == null) return@withLock false
                    dao.upsertAttachment(att.copy(pendingFileId = fileId))
                    true
                }
            } ?: return null
        val props = mapOf("k" to KIND_ATT, "dev" to me, "s" to att.sha)
        val created = drive.create(id, "att-${att.sha}.${MimeSniffer.extension(att.mime)}", props, att.mime, bytes)
        checkOwn(created, props) { writes.withLock { dao.upsertAttachment(att.copy(pendingFileId = null)) } }
        if (created.sha256Checksum != null && created.sha256Checksum != att.sha) {
            // Drive stored other bytes: remove it and try again with a new id next time.
            drive.delete(created.id)
            writes.withLock { if (dao.get(jobId) != null) dao.upsertAttachment(att.copy(pendingFileId = null)) }
            throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Attachment checksum mismatch")
        }
        return writes.withLock {
            if (dao.get(jobId) == null) return@withLock null
            dao.upsertAttachment(att.copy(pendingFileId = id, remoteFileId = created.id))
        }
    }

    /**
     * The user cancelled a job that was never sent: stop before the job file. A job file from an
     * earlier attempt whose response was lost counts as sent, and gets a cancel file instead.
     */
    private suspend fun cancelledBeforeSend(jobId: String): Boolean {
        val row = dao.get(jobId) ?: return true
        if (!row.cancelRequested) return false
        row.pendingJobFileId?.let { pending ->
            ownJobFile(pending, jobId, prefs.deviceId())?.let {
                markUploaded(jobId, it.id)
                return true
            }
        }
        update(jobId) { it.copy(local = JobEntity.CANCELLED, terminalAt = now()) }
        return true
    }

    /**
     * The job file created under [fileId] by an earlier attempt, read by id (a listing may not show
     * it yet, and the job must not be called unsent while it is on Drive).
     */
    private suspend fun ownJobFile(
        fileId: String,
        jobId: String,
        me: String,
    ): DriveFile? =
        drive.get(fileId)?.takeIf { f ->
            val p = f.appProperties.orEmpty()
            p["k"] == KIND_JOB && p["s"] == jobId && p["dev"] == me
        }

    private suspend fun markUploaded(
        jobId: String,
        fileId: String,
    ) {
        withContext(Dispatchers.IO) { runCatching { File(dir(jobId), UPLOADED_MARKER).createNewFile() } }
        update(jobId) { it.copy(local = JobEntity.UPLOADED, jobFileId = fileId) }
    }

    /** `jobcancel-<jobId>.json` (16 §5.2 step 3); the desktop honours it only while the job is not running. */
    private suspend fun writeCancel(
        job: JobEntity,
        me: String,
    ) {
        val body = SyncProtocol.encode(JobCancel.serializer(), JobCancel(job.jobId, iso(now()))).toByteArray()
        val id = job.pendingCancelFileId ?: allocate { fileId -> update(job.jobId) { it.copy(pendingCancelFileId = fileId) } } ?: return
        val props = mapOf("k" to KIND_CANCEL, "dev" to me, "s" to job.jobId)
        val created = drive.create(id, "jobcancel-${job.jobId}.json", props, JSON_MIME, body)
        checkOwn(created, props) { update(job.jobId) { it.copy(pendingCancelFileId = null) } }
        update(job.jobId) { it.copy(cancelFileId = created.id) }
    }

    /**
     * `acks-<deviceId>.json` (16 §4.7): the terminal job ids this phone has shown, newest first up to
     * the cap. Rewritten only when the list changes; created under a preallocated id.
     */
    private suspend fun writeAcks(me: String) {
        val ids =
            dao
                .all()
                .filter { it.shown && it.local == JobEntity.UPLOADED && it.remoteState in JobEntity.TERMINAL_STATES }
                .sortedByDescending { it.terminalAt ?: 0 }
                .take(Limits.ACKED_JOBS)
                .map { it.jobId }
                .sorted()
        val cursor = prefs.cursor()
        if (ids.isEmpty() && cursor.acksFileId == null) return
        val body = SyncProtocol.encode(Acks.serializer(), Acks(ids)).toByteArray()
        val hash = DocStore.sha256Hex(body)
        cursor.acksFileId?.let { fileId ->
            if (cursor.acksHash == hash) return
            try {
                drive.updateContent(fileId, body, JSON_MIME)
                prefs.updateCursor { it.copy(acksHash = hash) }
                return
            } catch (e: SyncException) {
                if (e.code != SyncErrorCode.E_SYNC_NOT_FOUND) throw e
                // Gone (the desktop collected a silent phone's files, or "Delete cloud copy"): create it again.
                prefs.updateCursor { it.copy(acksFileId = null, acksHash = null) }
            }
        }
        val id =
            prefs.cursor().pendingAcksFileId
                ?: drive.generateIds(1).single().also { id -> prefs.updateCursor { it.copy(pendingAcksFileId = id) } }
        val props = mapOf("k" to KIND_ACKS, "dev" to me)
        val created = drive.create(id, "acks-$me.json", props, JSON_MIME, body)
        checkOwn(created, props) { prefs.updateCursor { it.copy(pendingAcksFileId = null) } }
        if (created.id == id && cursor.pendingAcksFileId == id) {
            // A retry found the file from a lost response: make sure it carries this list.
            drive.updateContent(created.id, body, JSON_MIME)
        }
        prefs.updateCursor { it.copy(acksFileId = created.id, pendingAcksFileId = null, acksHash = hash) }
    }

    // ------------------------------------------------------------------------------ statuses

    /**
     * After each pull (16 §5.3, §4.7): applies changed `jobstatus` files, notifies finished jobs,
     * forgets jobs the desktop has collected, writes the acks file when it changed, and asks for an
     * upload when something is still waiting. Network trouble here never fails the pull.
     */
    override suspend fun afterPull(
        files: List<RemoteFileEntity>,
        primary: String?,
    ) = pass.withLock {
        ensureRebuilt()
        val me = prefs.deviceId()
        applyStatuses(files, primary, me)
        purge(files)
        val cursor = prefs.cursor()
        val owesAcks = dao.all().any { it.shown && it.local == JobEntity.UPLOADED && it.remoteState in JobEntity.TERMINAL_STATES } || cursor.acksFileId != null
        if (owesAcks) {
            try {
                writeAcks(me)
            } catch (e: SyncException) {
                if (e.code == SyncErrorCode.E_SYNC_AUTH) throw e
            }
        }
        val all = dao.all()
        if (all.any { it.local == JobEntity.LOCAL } ||
            all.any { it.local == JobEntity.UPLOADED && it.cancelRequested && it.cancelFileId == null && !it.terminal }
        ) {
            kickUpload()
        }
    }

    private suspend fun applyStatuses(
        files: List<RemoteFileEntity>,
        primary: String?,
        me: String,
    ) {
        val open = dao.uploaded().filter { it.remoteState !in JobEntity.TERMINAL_STATES }.associateBy { it.jobId }
        if (open.isEmpty()) return
        val byJob =
            files
                .filter { it.kind == KIND_STATUS && it.s in open && it.dev != null && it.dev != me }
                .groupBy { it.s!! }
        for ((jobId, candidates) in byJob) {
            val job = open.getValue(jobId)
            // The primary's status first, then the newest from any desktop (a takeover keeps statuses readable).
            val f = candidates.sortedWith(compareByDescending<RemoteFileEntity> { it.dev == primary }.thenByDescending { it.modifiedTime }).first()
            if (f.modifiedTime != null && f.modifiedTime == job.statusModified) continue
            if ((f.size ?: 0) > MAX_JSON_BYTES) continue
            val text =
                try {
                    drive.downloadAtMost(f.fileId, MAX_JSON_BYTES)?.decodeToString()
                } catch (e: SyncException) {
                    if (e.code == SyncErrorCode.E_SYNC_AUTH) throw e
                    null
                } ?: continue
            val status =
                try {
                    SyncProtocol.decodeJobStatus(text)
                } catch (_: ProtocolException) {
                    null
                }
            if (status == null || status.jobId != jobId) continue
            val state = JobState.serializer().descriptor.getElementName(status.state.ordinal)
            val becameTerminal = status.state.terminal
            var updated: JobEntity? = null
            update(jobId) {
                it
                    .copy(
                        remoteState = state,
                        stage = status.stage,
                        docId = status.docId,
                        versionId = status.versionId,
                        skippedSources = status.skippedSources,
                        anchorId = status.anchorId,
                        code = status.code,
                        reason = status.reason,
                        statusModified = f.modifiedTime,
                        terminalAt = if (becameTerminal) it.terminalAt ?: now() else null,
                    ).also { u -> updated = u }
            }
            val row = updated ?: continue
            if (status.state == JobState.DONE) {
                // The document lives on the Mac now; the shared bytes are no longer needed for a retry.
                withContext(Dispatchers.IO) { dao.attachments(jobId).forEach { File(dir(jobId), it.sha).delete() } }
                if (!row.notified && !row.hidden && notifyReady(row)) update(jobId) { it.copy(notified = true, shown = true) }
            }
        }
    }

    /**
     * Forgets jobs the desktop has collected (no job, status or cancel file left) once their terminal
     * status was shown and they were deleted from the Inbox or are older than 30 days; and jobs that
     * were never sent and were deleted.
     */
    private suspend fun purge(files: List<RemoteFileEntity>) {
        val remoteJobs = files.filter { it.kind == KIND_JOB || it.kind == KIND_STATUS || it.kind == KIND_CANCEL }.mapNotNull { it.s }.toSet()
        val cutoff = now() - KEEP_TERMINAL_MS
        for (job in dao.all()) {
            val sentAndDone = job.local == JobEntity.UPLOADED && job.shown && job.remoteState in JobEntity.TERMINAL_STATES
            val collected = job.jobId !in remoteJobs
            val old = (job.terminalAt ?: Long.MAX_VALUE) < cutoff
            val neverSent = job.local == JobEntity.CANCELLED || job.local == JobEntity.BROKEN
            if ((sentAndDone && collected && (job.hidden || old)) || (neverSent && old)) forget(job.jobId)
        }
    }

    // --------------------------------------------------------------------------- user actions

    /** Inbox Cancel (16 §5.2 step 3). A job never sent is removed outright; a sent one gets a cancel file. */
    suspend fun cancel(jobId: String) {
        val removed =
            writes.withLock {
                val job = dao.get(jobId) ?: return
                if (job.terminal) return
                if (job.local == JobEntity.LOCAL && job.pendingJobFileId == null) {
                    dao.delete(jobId)
                    true
                } else {
                    dao.requestCancel(jobId)
                    false
                }
            }
        if (removed) {
            withContext(Dispatchers.IO) { dir(jobId).deleteRecursively() }
        } else {
            kickUpload()
        }
    }

    /**
     * Inbox Delete: hides a finished job. It stays as a tombstone (in the acks file) until the desktop
     * collects it; a job that was never sent is removed at once.
     */
    suspend fun delete(jobId: String) {
        val gone =
            writes.withLock {
                val job = dao.get(jobId) ?: return
                if (!job.terminal) return
                if (job.local != JobEntity.UPLOADED) {
                    dao.delete(jobId)
                    true
                } else {
                    dao.upsert(job.copy(hidden = true, shown = true))
                    false
                }
            }
        withContext(Dispatchers.IO) {
            if (gone) {
                dir(jobId).deleteRecursively()
            } else {
                // Keep only what a rebuild needs; the attachments can no longer be retried.
                dir(jobId).listFiles()?.filter { it.name != REQUEST && it.name != UPLOADED_MARKER }?.forEach { it.delete() }
                // A rebuild keeps it hidden (and acknowledged) instead of listing it again.
                runCatching { File(dir(jobId), HIDDEN_MARKER).createNewFile() }
            }
        }
        if (!gone) kickUpload()
    }

    /**
     * Inbox Retry for a failed, rejected or broken job: the same capture under a new job id (job files
     * are immutable). False when the shared files are no longer on the phone.
     */
    suspend fun retry(jobId: String): Boolean = retrying.withLock { retryLocked(jobId) }

    private suspend fun retryLocked(jobId: String): Boolean {
        val job = dao.get(jobId) ?: return false
        // Hidden: already retried (or deleted), so a second tap never sends the capture twice.
        if (job.hidden || !job.terminal || job.remoteState == JobState.DONE.name.lowercase()) return false
        val old = dir(jobId)
        val request =
            withContext(Dispatchers.IO) { runCatching { SyncProtocol.decodeJob(File(old, REQUEST).readText()) }.getOrNull() }
                as? JobRequest.Capture ?: return false
        val newId = JobIds.new(now())
        val d = dir(newId)
        val copied =
            withContext(Dispatchers.IO) {
                try {
                    for (a in request.attachments) {
                        val bytes = File(old, a.sha).takeIf { it.isFile }?.readBytes() ?: return@withContext false
                        if (DocStore.sha256Hex(bytes) != a.sha) return@withContext false
                        writeAtomic(File(d, a.sha), bytes)
                    }
                    true
                } catch (_: IOException) {
                    false
                }
            }
        if (!copied) {
            withContext(Dispatchers.IO) { d.deleteRecursively() }
            return false
        }
        // The Mac may have changed since: an older one rejects `deadpan`, so the gate is checked again.
        // An unknown version (no pass has read the Mac yet) keeps it: it passed the gate when sent.
        val version = macVersion()
        val deadpan = request.deadpan && (version == null || AppVersions.macTakesDeadpan(version))
        queueCapture(
            CaptureDraft(
                newId,
                request.urls,
                request.text,
                request.clarifyingInput,
                request.focus,
                request.attachments,
                job.title,
                deadpan = deadpan,
            ),
        )
        delete(jobId)
        return true
    }

    /** The Inbox showed these terminal jobs (16 §5.2 step 4): they go into the acks file. */
    suspend fun markShown(jobIds: Collection<String>) {
        var changed = false
        writes.withLock {
            for (id in jobIds) {
                val job = dao.get(id) ?: continue
                if (job.terminal && !job.shown) {
                    dao.upsert(job.copy(shown = true))
                    if (job.local == JobEntity.UPLOADED) changed = true
                }
            }
        }
        if (changed) kickUpload()
    }

    // ------------------------------------------------------------------------------- rebuild

    /** Rebuilds rows from the outbox folders when Room lost them, and clears abandoned staging. */
    suspend fun ensureRebuilt() {
        if (rebuilt) return
        writes.withLock {
            if (rebuilt) return
            val known = dao.ids().toSet()
            val dirs = withContext(Dispatchers.IO) { root.listFiles()?.filter { it.isDirectory }.orEmpty() }
            val stale = now() - STAGING_TTL_MS
            for (d in dirs) {
                if (!Patterns.JOB_ID.matches(d.name)) continue
                if (d.name in known) continue
                val req = File(d, REQUEST)
                val request = withContext(Dispatchers.IO) { runCatching { SyncProtocol.decodeJob(req.readText()) }.getOrNull() }
                if (request == null || request.jobId != d.name) {
                    // A dismissed or crashed capture sheet: nothing was queued.
                    if (d.lastModified() < stale) withContext(Dispatchers.IO) { d.deleteRecursively() }
                    continue
                }
                val uploaded = File(d, UPLOADED_MARKER).exists()
                val hidden = uploaded && File(d, HIDDEN_MARKER).exists()
                dao.insert(rowOf(request, titleOf(request), uploaded).copy(hidden = hidden, shown = hidden), attachmentRows(request))
            }
            rebuilt = true
        }
    }

    // ------------------------------------------------------------------------------- helpers

    private suspend fun forget(jobId: String) {
        writes.withLock { dao.delete(jobId) }
        withContext(Dispatchers.IO) { dir(jobId).deleteRecursively() }
    }

    private suspend fun update(
        jobId: String,
        change: (JobEntity) -> JobEntity,
    ) = writes.withLock {
        val job = dao.get(jobId) ?: return@withLock
        val next = change(job)
        if (next != job) dao.upsert(next)
    }

    /** Preallocates one Drive file id and persists it with [persist]; null when the row went away. */
    private suspend fun allocate(persist: suspend (String) -> Any?): String? {
        val id = drive.generateIds(1).single()
        val ok = persist(id)
        return if (ok == false) null else id
    }

    /** A create that returned someone else's file (the preallocated id was taken): start over next time. */
    private suspend fun checkOwn(
        created: DriveFile,
        props: Map<String, String>,
        reset: suspend () -> Unit,
    ) {
        val p = created.appProperties.orEmpty()
        if (props.any { (k, v) -> p[k] != v }) {
            reset()
            throw SyncException(SyncErrorCode.E_SYNC_HTTP, "File id is taken")
        }
    }

    companion object {
        const val REQUEST = "request.json"
        const val UPLOADED_MARKER = "uploaded"
        const val HIDDEN_MARKER = "hidden"
        const val JSON_MIME = "application/json"

        const val KIND_ATT = "att"
        const val KIND_JOB = "job"
        const val KIND_CANCEL = "cancel"
        const val KIND_STATUS = "status"
        const val KIND_ACKS = "acks"

        const val MAX_JSON_BYTES = 4L * 1024 * 1024

        /** Finished jobs stay in the Inbox this long (the desktop keeps their files 30 days at most, 16 §4.7). */
        const val KEEP_TERMINAL_MS = 30L * 24 * 60 * 60 * 1000

        /** A staging folder without a request this old belongs to a sheet that is long gone. */
        const val STAGING_TTL_MS = 24L * 60 * 60 * 1000

        fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString()

        private fun epochMs(iso: String): Long =
            try {
                Instant.parse(iso).toEpochMilli()
            } catch (_: DateTimeParseException) {
                0L
            }

        fun kindOf(r: JobRequest): String =
            when (r) {
                is JobRequest.Capture -> "capture"
                is JobRequest.Checkout -> "checkout"
                is JobRequest.Ask -> "ask"
            }

        /** A short local label: the first link's host, the first file's name, or the first line of text. */
        fun titleOf(r: JobRequest): String {
            val label =
                when (r) {
                    is JobRequest.Capture ->
                        r.urls.firstOrNull()?.let { u -> runCatching { URI(u).host?.removePrefix("www.") }.getOrNull() }
                            ?: r.attachments.firstOrNull()?.name
                            ?: r.text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
                    is JobRequest.Checkout -> null
                    is JobRequest.Ask -> r.question
                }
            return label?.take(TITLE_CHARS).orEmpty()
        }

        const val TITLE_CHARS = 120

        private fun rowOf(
            r: JobRequest,
            title: String,
            uploaded: Boolean,
        ) = JobEntity(
            jobId = r.jobId,
            kind = kindOf(r),
            createdAt = epochMs(r.createdAt),
            title = title.take(TITLE_CHARS),
            local = if (uploaded) JobEntity.UPLOADED else JobEntity.LOCAL,
            attachmentCount = (r as? JobRequest.Capture)?.attachments?.size ?: 0,
        )

        private fun attachmentRows(r: JobRequest): List<JobAttachmentEntity> =
            (r as? JobRequest.Capture)?.attachments.orEmpty().mapIndexed { i, a ->
                JobAttachmentEntity(jobId = r.jobId, sha = a.sha, name = a.name, mime = a.mime, size = a.size, position = i)
            }

        /** Temp file, fsync, rename: a crash never leaves a torn file under the final name. */
        @Throws(IOException::class)
        fun writeAtomic(
            target: File,
            bytes: ByteArray,
        ) {
            val parent = target.parentFile ?: throw IOException("no folder")
            if (!parent.isDirectory && !parent.mkdirs()) throw IOException("cannot create outbox folder")
            val tmp = File(parent, ".tmp-${UUID.randomUUID()}")
            try {
                FileOutputStream(tmp).use { out ->
                    out.write(bytes)
                    out.fd.sync()
                }
                if (!tmp.renameTo(target)) throw IOException("cannot move file into place")
            } finally {
                tmp.delete()
            }
        }
    }
}
