package io.github.eli5learner.sync

import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.OfflinePolicy
import io.github.eli5learner.data.SyncPrefs
import io.github.eli5learner.data.db.DeviceEntity
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.data.db.FolderEntity
import io.github.eli5learner.data.db.RemoteFileEntity
import io.github.eli5learner.data.db.VersionEntity
import io.github.eli5learner.drive.DriveApi
import io.github.eli5learner.drive.DriveFile
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.sync.protocol.DeviceRecord
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.sync.protocol.LibraryManifest
import io.github.eli5learner.sync.protocol.Placement
import io.github.eli5learner.sync.protocol.ProtocolException
import io.github.eli5learner.sync.protocol.SYNC_FORMAT_VERSION
import io.github.eli5learner.sync.protocol.SyncProtocol
import io.github.eli5learner.sync.protocol.VersionChangeKind
import io.github.eli5learner.sync.protocol.VersionTree
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.zip.GZIPInputStream

/** How one sync ended; the worker maps it to a WorkManager result. */
sealed interface SyncOutcome {
    data object Synced : SyncOutcome

    /** Local mode: not connected, so no request was made. */
    data object NotConnected : SyncOutcome

    /** The grant is gone; only the user can fix it ("Sign in again"). No retry. */
    data object NeedsReconnect : SyncOutcome

    /** The store was written by a newer app; the library stays read-only (`E_SYNC_FORMAT`). */
    data object FormatTooNew : SyncOutcome

    /** Network, server or Play services trouble: try again later. */
    data class Transient(
        val code: SyncErrorCode,
    ) : SyncOutcome

    /** A failure retrying soon will not fix (for example a full Drive). */
    data class Failed(
        val code: SyncErrorCode,
    ) : SyncOutcome
}

/** The worker's view of the repository; tests pass a fake. */
fun interface SyncRunner {
    suspend fun runSync(): SyncOutcome
}

/** What the sync icon and its status sheet show (16 §6.2). Offline is a state, not an error. */
enum class SyncProblem { OFFLINE, NEEDS_RECONNECT, FORMAT_TOO_NEW, DRIVE_FULL, ERROR }

/** The primary Mac as this phone last saw it (16 §4.3). */
data class MacInfo(
    val name: String,
    /** Epoch ms of the newest heartbeat, if any. */
    val lastSeenMs: Long?,
    val inbox: InboxState,
    val accepts: List<JobKind>,
)

data class SyncStatus(
    val syncing: Boolean = false,
    val problem: SyncProblem? = null,
    val mac: MacInfo? = null,
    /** Connected, but no Mac has set up the store yet (or none has claimed it). */
    val waitingForMac: Boolean = false,
    /** Documents the offline policy wants that are not on the phone yet (blob not visible, Wi-Fi only, failed). */
    val pendingDownloads: Int = 0,
)

/**
 * Library sync on the phone (16 §4.8, §6.4): pull only. The phone reads the store the primary Mac
 * writes and writes nothing but its own device file ([DeviceWriter]).
 *
 * One pass: refresh the file index (full `files.list` at bootstrap or after a lost token, else the
 * change feed), check `sync-info.json`, find the primary from the newest claim, read device files,
 * apply the primary's manifest when its `seq` is greater than the one held, apply changed version
 * trees, download current versions the offline policy wants (gunzip, sha-verify, atomic write), then
 * touch this phone's device file. A blob the listing does not show yet is retried on the next pass
 * without an error (Drive listings are eventually consistent). Nothing here logs titles, names or
 * tokens (16 §9).
 */
class SyncRepository(
    private val db: Eli5Db,
    private val index: LibraryIndex,
    private val store: DocStore,
    private val drive: DriveApi,
    private val prefs: SyncPrefs,
    private val deviceWriter: DeviceWriter,
    /** The grant as it stands; never shows consent. */
    private val authState: suspend () -> AuthState,
    /** Called before every pass: a fresh `authorize()` (16 §3.3). */
    private val prepareAuth: suspend () -> Unit = {},
    /** True on an unmetered network ("Large downloads on Wi-Fi only"). */
    private val isUnmetered: () -> Boolean = { true },
    private val now: () -> Long = System::currentTimeMillis,
) : SyncRunner {
    private val run = Mutex()
    private val remote = db.remoteFiles()

    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    val devices: Flow<List<DeviceEntity>> = db.devices().observe()
    val folders: Flow<List<FolderEntity>> = db.folders().observe()

    /** Parsed device files by file id, keyed on `modifiedTime` so unchanged ones are not downloaded again. */
    private val deviceCache = HashMap<String, Pair<String?, DeviceRecord?>>()
    private var infoCache: Pair<String, Boolean>? = null

    override suspend fun runSync(): SyncOutcome = sync()

    suspend fun sync(): SyncOutcome =
        run.withLock {
            when (authState()) {
                is AuthState.Connected -> Unit
                is AuthState.NeedsReconnect -> {
                    _status.update { it.copy(syncing = false, problem = SyncProblem.NEEDS_RECONNECT) }
                    return@withLock SyncOutcome.NeedsReconnect
                }
                else -> {
                    _status.value = SyncStatus()
                    return@withLock SyncOutcome.NotConnected
                }
            }
            _status.update { it.copy(syncing = true) }
            val outcome =
                try {
                    prepareAuth()
                    pull()
                } catch (e: CancellationException) {
                    _status.update { it.copy(syncing = false) }
                    throw e
                } catch (e: SyncException) {
                    outcomeOf(e)
                } catch (e: IOException) {
                    // A full disk or an unwritable folder: retrying soon will not help.
                    SyncOutcome.Failed(SyncErrorCode.E_SYNC_HTTP)
                } catch (e: RuntimeException) {
                    // Room or SQLite trouble (for example a full disk). Never crash the app scope.
                    SyncOutcome.Failed(SyncErrorCode.E_SYNC_HTTP)
                }
            _status.update { it.copy(syncing = false, problem = problemOf(outcome)) }
            if (outcome == SyncOutcome.Synced) prefs.setLastSyncAt(now())
            outcome
        }

    /**
     * Downloads the current version of one synced document now (the Reader opened one that is not on
     * the phone yet). Ignores the offline policy and the Wi-Fi rule: the user asked for it.
     */
    suspend fun fetch(key: String): FetchResult {
        if (authState() !is AuthState.Connected) return FetchResult.NOT_CONNECTED
        val row = db.documents().get(key) ?: return FetchResult.FAILED
        if (row.source != DocumentEntity.SOURCE_SYNCED || row.remoteSha == null) return FetchResult.FAILED
        if (row.localSha == row.remoteSha) return FetchResult.OK
        return try {
            val files = remote.all()
            fetchBlob(row, files, primaryOf(files), allowLarge = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: SyncException) {
            if (e.code == SyncErrorCode.E_SYNC_AUTH) FetchResult.NOT_CONNECTED else FetchResult.OFFLINE
        } catch (e: IOException) {
            FetchResult.FAILED
        } catch (e: RuntimeException) {
            FetchResult.FAILED
        }
    }

    /**
     * Disconnect (16 §3.3, §4.8): forget the remote index, cursors and devices so the next Connect
     * (perhaps to another account) starts from a full listing. Documents on the phone stay.
     */
    suspend fun forget() =
        run.withLock {
            remote.clear()
            db.devices().clear()
            prefs.resetCursor()
            deviceCache.clear()
            infoCache = null
            _status.value = SyncStatus()
        }

    // --------------------------------------------------------------------------------- the pass

    private suspend fun pull(): SyncOutcome {
        refreshIndex()
        val files = remote.all()

        val info = files.filter { it.kind == KIND_INFO }
        if (info.isEmpty()) {
            // No Mac has set up the store yet. The phone still says hello, so the Mac can list it.
            _status.update { it.copy(waitingForMac = true, mac = null, pendingDownloads = 0) }
            heartbeat(files)
            return SyncOutcome.Synced
        }
        if (!formatKnown(info)) return SyncOutcome.FormatTooNew

        val primary = primaryOf(files)
        val devices = readDevices(files)
        val mac = primary?.let { devices[it] }
        _status.update {
            it.copy(
                waitingForMac = primary == null,
                mac =
                    mac?.let { (rec, seen) ->
                        MacInfo(rec.name, seen?.let { s -> s * 1000 }, rec.inbox, rec.accepts)
                    },
            )
        }

        if (primary != null) {
            applyManifest(files, primary)
            applyTrees(files, primary)
        }
        val pending = downloadWanted(files, primary)
        _status.update { it.copy(pendingDownloads = pending) }
        heartbeat(files)
        return SyncOutcome.Synced
    }

    /** Full listing at bootstrap, after a lost token, or when the cache was rebuilt; else the change feed. */
    private suspend fun refreshIndex() {
        val cursor = prefs.cursor()
        val emptyCache = remote.count() == 0
        val token = cursor.startToken
        if (token != null && !emptyCache) {
            try {
                val page = drive.changes(token)
                val upserts = mutableListOf<RemoteFileEntity>()
                val removed = mutableListOf<String>()
                for (c in page.changes) {
                    val row = if (c.removed) null else c.file?.let(::rowOf)
                    if (row != null) upserts += row else removed += c.fileId
                }
                remote.apply(upserts, removed)
                prefs.updateCursor { it.copy(startToken = page.newStartPageToken) }
                return
            } catch (e: SyncException) {
                if (e.code != SyncErrorCode.E_SYNC_TOKEN) throw e
                // 410 or an invalid token: full rescan, no user text (16 §10).
            }
        }
        // The token is taken before the listing, so a change made during the listing is replayed, not lost.
        val start = drive.startPageToken()
        val listed = drive.list().mapNotNull(::rowOf)
        remote.replace(listed)
        // A rebuilt cache (no rows) must accept the current manifest and trees again.
        if (emptyCache) {
            db.documents().all().filter { it.treeSeq != 0L }.forEach { db.documents().upsert(it.copy(treeSeq = 0)) }
        }
        prefs.updateCursor { it.copy(startToken = start, manifestSeq = if (emptyCache) 0 else it.manifestSeq) }
    }

    /** `sync-info.json` (16 §4.5 step 6): only the version fields are read; an unreadable one counts as unknown. */
    private suspend fun formatKnown(info: List<RemoteFileEntity>): Boolean {
        val f = info.minBy { it.fileId }
        val cacheKey = "${f.fileId}@${f.modifiedTime}"
        infoCache?.takeIf { it.first == cacheKey }?.let { return it.second }
        val text = smallJson(f) ?: return true.also { infoCache = null } // vanished meanwhile: decide next pass
        val known =
            runCatching {
                val o = LENIENT.parseToJsonElement(text) as JsonObject
                val format = (o["formatVersion"] as JsonPrimitive).intOrNull!!
                val minReader = (o["minReaderVersion"] as JsonPrimitive).intOrNull!!
                format in 1..SYNC_FORMAT_VERSION && minReader <= READER_VERSION
            }.getOrDefault(false)
        infoCache = cacheKey to known
        return known
    }

    /** Device files with their heartbeat; invalid ones are skipped. Also stored for Settings. */
    private suspend fun readDevices(files: List<RemoteFileEntity>): Map<String, Pair<DeviceRecord, Long?>> {
        val out = HashMap<String, Pair<DeviceRecord, Long?>>()
        // This phone's own file changes on every heartbeat; it is never read back.
        val me = prefs.deviceId()
        val present = files.filter { it.kind == KIND_DEVICE && it.dev != null && it.dev != me }
        deviceCache.keys.retainAll(present.map { it.fileId }.toSet())
        for (f in present) {
            val cached = deviceCache[f.fileId]
            val record =
                if (cached != null && cached.first == f.modifiedTime) {
                    cached.second
                } else {
                    val parsed = smallJson(f)?.let { runCatching { SyncProtocol.decodeDevice(it) }.getOrNull() }
                    deviceCache[f.fileId] = f.modifiedTime to parsed
                    parsed
                } ?: continue
            // The record must describe the device that wrote it.
            if (record.deviceId != f.dev) continue
            val prev = out[record.deviceId]
            if (prev == null || (f.seen ?: 0) > (prev.second ?: 0)) out[record.deviceId] = record to f.seen
        }
        db.devices().replace(
            out.values.map { (r, seen) ->
                DeviceEntity(
                    deviceId = r.deviceId,
                    platform = r.platform.name.lowercase(),
                    name = r.name,
                    role = r.role.name.lowercase(),
                    accepts = r.accepts.joinToString(",") { it.name.lowercase() },
                    inbox = r.inbox.name.lowercase(),
                    seen = seen,
                )
            },
        )
        return out
    }

    // ------------------------------------------------------------------------------ manifest

    private suspend fun applyManifest(
        files: List<RemoteFileEntity>,
        primary: String,
    ) {
        val held = prefs.cursor().manifestSeq
        val lib = files.filter { it.kind == KIND_LIB && it.dev == primary }.maxByOrNull { it.n ?: Long.MAX_VALUE } ?: return
        val n = lib.n
        if (n != null && n <= held) return
        val manifest = smallJson(lib, MAX_MANIFEST_BYTES)?.let { decodeOrNull { SyncProtocol.decodeManifest(it) } } ?: return
        // 16 §4.4: a reader ignores a manifest whose seq is not greater than the one it holds.
        if (manifest.seq <= held) return
        apply(manifest, firstManifest = held == 0L)
        prefs.updateCursor { it.copy(manifestSeq = manifest.seq) }
    }

    private suspend fun apply(
        m: LibraryManifest,
        firstManifest: Boolean,
    ) {
        db.folders().replace(m.folders.mapIndexed { i, f -> FolderEntity(f.id, f.name, i) })
        val versions = db.versions()
        val removedKeys = mutableListOf<String>()
        index.write { d ->
            val rows = d.all().associateBy { it.key }
            val listed = m.docs.map { it.docId }.toSet()
            val bootstrap = firstManifest && rows.values.none { it.source == DocumentEntity.SOURCE_SYNCED && it.remoteSha != null }
            for (doc in m.docs) {
                val old = rows[doc.docId]?.takeIf { it.source == DocumentEntity.SOURCE_SYNCED }
                val replaced = doc.replaces?.let { rows[it] }?.takeIf { it.source == DocumentEntity.SOURCE_SYNCED && it.key !in listed }
                // A synced copy replaces an imported one of the same document (16 §6.4).
                for (imp in d.byDocId(doc.docId)) {
                    if (imp.source == DocumentEntity.SOURCE_IMPORTED) {
                        d.delete(imp.key)
                        removedKeys += imp.key
                    }
                }
                val newVersion = old != null && old.remoteSha != doc.currentSha
                val placement = doc.placement
                val row =
                    DocumentEntity(
                        key = doc.docId,
                        docId = doc.docId,
                        source = DocumentEntity.SOURCE_SYNCED,
                        title = doc.title,
                        summary = doc.summary,
                        // The manifest names tab keys; the downloaded file's own labels win once it is here.
                        tabs = old?.tabs?.takeIf { it.isNotEmpty() } ?: tabLabels(doc.tabs),
                        headings = doc.headings.joinToString("\n"),
                        foreign = old?.foreign ?: false,
                        updatedAt = epochMs(doc.updatedAt),
                        createdAt = epochMs(doc.createdAt),
                        placement = placementName(placement),
                        folderId = (placement as? Placement.Folder)?.folderId,
                        currentVersionId = doc.currentVersionId,
                        remoteSha = doc.currentSha,
                        sizeBytes = doc.sizeBytes,
                        busy = doc.busy,
                        localSha = old?.localSha,
                        pinned = old?.pinned ?: replaced?.pinned ?: false,
                        unread =
                            when {
                                old == null -> !bootstrap && replaced == null
                                newVersion -> true
                                else -> old.unread
                            },
                        readingSha = old?.readingSha,
                        readingPosition = old?.readingPosition ?: 0f,
                        treeSeq = old?.treeSeq ?: 0,
                    )
                d.save(row, if (old != null) d.ftsBody(old.key) else null)
                if (replaced != null) {
                    d.delete(replaced.key)
                    removedKeys += replaced.key
                }
            }
            for (row in rows.values) {
                if (row.source == DocumentEntity.SOURCE_SYNCED && row.key !in listed && row.key !in removedKeys) {
                    d.delete(row.key)
                    removedKeys += row.key
                }
            }
            withContext(Dispatchers.IO) { removedKeys.forEach { store.delete(it) } }
        }
        removedKeys.forEach { versions.deleteDoc(it) }
    }

    private suspend fun applyTrees(
        files: List<RemoteFileEntity>,
        primary: String,
    ) {
        val trees =
            files
                .filter { it.kind == KIND_TREE && it.dev == primary && it.docId != null }
                .groupBy { it.docId!! }
                .mapValues { (_, l) -> l.maxBy { it.n ?: Long.MAX_VALUE } }
        for (row in db.documents().all()) {
            if (row.source != DocumentEntity.SOURCE_SYNCED) continue
            val f = trees[row.key] ?: continue
            val n = f.n
            if (n != null && n <= row.treeSeq) continue
            val tree = smallJson(f, MAX_MANIFEST_BYTES)?.let { decodeOrNull { SyncProtocol.decodeTree(it) } } ?: continue
            if (tree.docId != row.key || tree.seq <= row.treeSeq) continue
            db.versions().replace(row.key, versionRows(tree))
            index.write { d -> d.get(row.key)?.let { d.upsert(it.copy(treeSeq = tree.seq)) } }
        }
    }

    // ----------------------------------------------------------------------------- downloads

    /** Downloads current versions per the offline policy; returns how many are still pending. */
    private suspend fun downloadWanted(
        files: List<RemoteFileEntity>,
        primary: String?,
    ): Int {
        val options = prefs.options.first()
        val rows =
            db
                .documents()
                .all()
                .filter { it.source == DocumentEntity.SOURCE_SYNCED && it.remoteSha != null && it.placement != DocumentEntity.PLACEMENT_TRASH }
        val byPolicy =
            when (options.offlinePolicy) {
                OfflinePolicy.ALL -> rows
                OfflinePolicy.RECENT -> rows.sortedWith(compareByDescending<DocumentEntity> { it.updatedAt }.thenBy { it.key }).take(OfflinePolicy.RECENT_COUNT)
                OfflinePolicy.PINNED -> emptyList()
            }
        val wanted = (byPolicy + rows.filter { it.pinned }).distinctBy { it.key }.filter { it.localSha != it.remoteSha }
        val allowLarge = !options.largeOnWifiOnly || isUnmetered()
        var pending = 0
        for (row in wanted) {
            if (fetchBlob(row, files, primary, allowLarge) != FetchResult.OK) pending++
        }
        return pending
    }

    enum class FetchResult { OK, MISSING, WIFI_ONLY, FAILED, OFFLINE, NOT_CONNECTED }

    private suspend fun fetchBlob(
        row: DocumentEntity,
        files: List<RemoteFileEntity>,
        primary: String?,
        allowLarge: Boolean,
    ): FetchResult {
        val sha = row.remoteSha ?: return FetchResult.FAILED
        val blob =
            files
                .filter { it.kind == KIND_BLOB && it.docId == row.key && it.s == sha }
                .minByOrNull { if (it.dev == primary) 0 else 1 }
                ?: return FetchResult.MISSING // not visible yet: retried on the next pass, no error
        val size = blob.size ?: 0
        if (size > MAX_BLOB_BYTES) return FetchResult.FAILED
        if (size > LARGE_BLOB_BYTES && !allowLarge) return FetchResult.WIFI_ONLY
        val gz =
            try {
                drive.downloadAtMost(blob.fileId, MAX_BLOB_BYTES)
            } catch (e: SyncException) {
                if (e.code == SyncErrorCode.E_SYNC_NOT_FOUND) return FetchResult.MISSING
                throw e
            } ?: return FetchResult.FAILED
        val html = withContext(Dispatchers.Default) { gunzip(gz, HtmlImporter.MAX_BYTES) } ?: return FetchResult.FAILED
        if (DocStore.sha256Hex(html) != sha) return FetchResult.FAILED
        val text = html.toString(Charsets.UTF_8)
        val inspection = HtmlImporter.inspect(text)
        val body = if (inspection.isEli5) HtmlImporter.modelText(text) else ""
        return index.write { d ->
            // The manifest may have moved on while this downloaded; only the current sha is written.
            val cur = d.get(row.key)?.takeIf { it.remoteSha == sha } ?: return@write FetchResult.MISSING
            try {
                withContext(Dispatchers.IO) {
                    store.write(row.key, html)
                    store.pruneExcept(row.key, setOf(sha) + index.leased(row.key))
                }
            } catch (e: IOException) {
                // This document only (for example a full disk); it stays pending and is retried next pass.
                return@write FetchResult.FAILED
            }
            val labelled =
                if (inspection.isEli5) cur.copy(tabs = inspection.tabs.joinToString("\n")) else cur
            d.save(labelled.copy(localSha = sha, foreign = !inspection.isEli5), body)
            FetchResult.OK
        }
    }

    // ------------------------------------------------------------------------------- helpers

    private suspend fun heartbeat(files: List<RemoteFileEntity>) {
        try {
            deviceWriter.heartbeat(files)
        } catch (e: SyncException) {
            // Reading worked; a lost heartbeat is retried next pass. Only a lost grant matters now.
            if (e.code == SyncErrorCode.E_SYNC_AUTH) throw e
        }
    }

    /** Small JSON written by another device (16 §4.8: at most 4 MiB), or null when too large or gone. */
    private suspend fun smallJson(
        f: RemoteFileEntity,
        max: Long = MAX_JSON_BYTES,
    ): String? {
        if ((f.size ?: 0) > max) return null
        val bytes =
            try {
                drive.downloadAtMost(f.fileId, max)
            } catch (e: SyncException) {
                if (e.code == SyncErrorCode.E_SYNC_NOT_FOUND) return null
                throw e
            } ?: return null
        return bytes.decodeToString()
    }

    private inline fun <T> decodeOrNull(block: () -> T): T? =
        try {
            block()
        } catch (_: ProtocolException) {
            null
        }

    private fun outcomeOf(e: SyncException): SyncOutcome =
        when (e.code) {
            SyncErrorCode.E_SYNC_AUTH -> SyncOutcome.NeedsReconnect
            SyncErrorCode.E_SYNC_QUOTA -> SyncOutcome.Failed(e.code)
            SyncErrorCode.E_SYNC_FORMAT -> SyncOutcome.FormatTooNew
            else -> SyncOutcome.Transient(e.code)
        }

    private fun problemOf(o: SyncOutcome): SyncProblem? =
        when (o) {
            SyncOutcome.Synced, SyncOutcome.NotConnected -> null
            SyncOutcome.NeedsReconnect -> SyncProblem.NEEDS_RECONNECT
            SyncOutcome.FormatTooNew -> SyncProblem.FORMAT_TOO_NEW
            is SyncOutcome.Failed -> if (o.code == SyncErrorCode.E_SYNC_QUOTA) SyncProblem.DRIVE_FULL else SyncProblem.ERROR
            is SyncOutcome.Transient -> if (o.code == SyncErrorCode.E_SYNC_HTTP) SyncProblem.OFFLINE else SyncProblem.ERROR
        }

    companion object {
        const val KIND_INFO = "info"
        const val KIND_CLAIM = "claim"
        const val KIND_DEVICE = "device"
        const val KIND_LIB = "lib"
        const val KIND_TREE = "tree"
        const val KIND_BLOB = "blob"

        /** The newest `minReaderVersion` this app reads. */
        const val READER_VERSION = 1

        const val MAX_JSON_BYTES = 4L * 1024 * 1024

        /** Manifests and trees are bounded by their own caps (10,000 docs, 300 nodes) rather than 4 MiB. */
        const val MAX_MANIFEST_BYTES = 32L * 1024 * 1024

        /** "Large downloads on Wi-Fi only" applies above this (16 §6.4). */
        const val LARGE_BLOB_BYTES = 5L * 1024 * 1024
        const val MAX_BLOB_BYTES = HtmlImporter.MAX_BYTES.toLong()

        private val LENIENT = Json { ignoreUnknownKeys = true }

        /** One remote file as an index row; null for a file without a kind (not ours to read). */
        fun rowOf(f: DriveFile): RemoteFileEntity? {
            val p = f.appProperties ?: return null
            val kind = p["k"] ?: return null
            return RemoteFileEntity(
                fileId = f.id,
                kind = kind,
                dev = p["dev"],
                docId = p["d"],
                s = p["s"],
                n = p["n"]?.toLongOrNull(),
                seen = p["seen"]?.toLongOrNull(),
                size = f.size?.toLongOrNull(),
                modifiedTime = f.modifiedTime,
            )
        }

        /**
         * The primary desktop: the device of the newest claim, by `n` (claim time in ms), then the
         * larger device id, then the larger file id (16 §4.6, the desktop's `compareClaims`).
         */
        fun primaryOf(files: List<RemoteFileEntity>): String? =
            files
                .filter { it.kind == KIND_CLAIM && it.n != null && it.dev != null }
                .maxWithOrNull(compareBy<RemoteFileEntity>({ it.n }, { it.dev }, { it.fileId }))
                ?.dev

        fun versionRows(tree: VersionTree): List<VersionEntity> =
            tree.nodes.mapIndexed { i, n ->
                VersionEntity(
                    docId = tree.docId,
                    id = n.id,
                    parentId = n.parentId,
                    kind = VersionChangeKind.serializer().descriptor.getElementName(n.kind.ordinal),
                    label = n.label,
                    createdAt = n.createdAt,
                    sha = n.sha,
                    uploaded = n.uploaded,
                    position = i,
                )
            }

        /** Display labels for the manifest's tab keys (07 §3). */
        fun tabLabels(keys: List<String>): String =
            keys
                .map {
                    when (it) {
                        "indepth" -> "In depth"
                        "eli5" -> "ELI5"
                        else -> ""
                    }
                }.filter { it.isNotEmpty() }
                .joinToString("\n")

        fun placementName(p: Placement): String =
            when (p) {
                is Placement.Folder -> DocumentEntity.PLACEMENT_FOLDER
                Placement.Unfiled -> DocumentEntity.PLACEMENT_UNFILED
                Placement.Archive -> DocumentEntity.PLACEMENT_ARCHIVE
                Placement.Trash -> DocumentEntity.PLACEMENT_TRASH
            }

        fun epochMs(iso: String): Long =
            try {
                Instant.parse(iso).toEpochMilli()
            } catch (_: DateTimeParseException) {
                0L
            }

        /** Gunzips at most [limit] bytes; null for a corrupt stream or one that inflates past the limit. */
        fun gunzip(
            bytes: ByteArray,
            limit: Int,
        ): ByteArray? =
            try {
                GZIPInputStream(ByteArrayInputStream(bytes)).use { input ->
                    val out = ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val r = input.read(buf)
                        if (r < 0) break
                        if (out.size() + r > limit) return null
                        out.write(buf, 0, r)
                    }
                    out.toByteArray()
                }
            } catch (_: IOException) {
                null
            }
    }
}
