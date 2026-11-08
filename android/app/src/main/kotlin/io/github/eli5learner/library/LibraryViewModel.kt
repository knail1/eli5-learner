package io.github.eli5learner.library

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.AppContainer
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.FolderEntity
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.importer.ImportResult
import io.github.eli5learner.sync.SyncStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

data class LibraryUiState(
    val loaded: Boolean = false,
    val query: String = "",
    /** Every entry outside the Trash, unfiltered (the empty state depends on it, not on the search). */
    val total: Int = 0,
    val items: List<DocEntry> = emptyList(),
    /** Folder chips from the Mac's library, in its order (16 §6.2). */
    val folders: List<FolderEntity> = emptyList(),
    /** The selected chip: null for All, a folder id, or [FolderFilter.UNFILED] / [FolderFilter.ARCHIVE]. */
    val folder: String? = null,
    /** Some documents are archived on the Mac (the Archive chip shows). */
    val hasArchive: Boolean = false,
    val sync: SyncStatus = SyncStatus(),
    val lastSyncAt: Long? = null,
)

/** The non-folder chips. */
object FolderFilter {
    const val UNFILED = "@unfiled"
    const val ARCHIVE = "@archive"
}

/** What the library needs from sync; null in local-only tests. */
interface LibrarySync {
    val status: Flow<SyncStatus>
    val lastSyncAt: Flow<Long?>
    val folders: Flow<List<FolderEntity>>

    /** Pull-to-refresh and Sync now. */
    fun syncNow()
}

/** One-off messages for the snackbar. */
sealed interface LibraryEvent {
    data class Imported(
        val imported: Int,
        val skipped: Int,
    ) : LibraryEvent

    data object NothingToImport : LibraryEvent

    data class Removed(
        val title: String,
    ) : LibraryEvent
}

/** Reads a picked or shared file: display name and bytes, or null when it cannot be read. */
fun interface UriReader {
    fun read(uri: Uri): Pair<String?, ByteArray>?
}

/**
 * Library state and the import entry point for picker, share sheet and "Open with" (16 §7). Scoped
 * to the activity so imports from intents and from the screens share one queue.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LibraryViewModel(
    private val index: LibraryIndex,
    private val importer: HtmlImporter,
    private val reader: UriReader,
    private val sync: LibrarySync? = null,
) : ViewModel() {
    private val query = MutableStateFlow("")
    private val folder = MutableStateFlow<String?>(null)
    private val loaded = MutableStateFlow(false)
    private val events = Channel<LibraryEvent>(Channel.BUFFERED)

    /**
     * Imports and removals run one at a time: an import writes the file before it updates the index,
     * so a concurrent removal of the same key could otherwise delete the file under a fresh entry.
     */
    private val writes = Mutex()

    val messages: Flow<LibraryEvent> = events.receiveAsFlow()

    private data class Inputs(
        val entries: List<DocEntry>,
        val query: String,
        val folder: String?,
        val loaded: Boolean,
        val folders: List<FolderEntity>,
    )

    private val inputs =
        combine(index.entries, query, folder, loaded, sync?.folders ?: flowOf(emptyList())) { e, q, f, l, fs -> Inputs(e, q, f, l, fs) }

    private val syncInputs =
        combine(sync?.status ?: flowOf(SyncStatus()), sync?.lastSyncAt ?: flowOf(null)) { s, t -> s to t }

    val state: StateFlow<LibraryUiState> =
        combine(
            inputs.mapLatest { i ->
                // Search runs against the full-text index (title, summary, headings, document text).
                val hits = if (i.query.isBlank()) null else index.search(i.query)
                i to hits
            },
            syncInputs,
        ) { (i, hits), (status, lastSync) ->
            val visible = i.entries.filter { !it.trashed }
            val folderIds = i.folders.map { it.id }.toSet()
            LibraryUiState(
                loaded = i.loaded,
                query = i.query,
                total = visible.size,
                items = filterEntries(visible, i.query, hits, i.folder, folderIds),
                folders = i.folders.filter { f -> visible.any { it.folderId == f.id } },
                folder = i.folder,
                hasArchive = visible.any { it.placement == DocumentEntity.PLACEMENT_ARCHIVE },
                sync = status,
                lastSyncAt = lastSync,
            )
        }.stateIn(viewModelScope, SharingStarted.Eagerly, LibraryUiState())

    init {
        viewModelScope.launch {
            index.load()
            loaded.value = true
        }
    }

    fun setQuery(q: String) {
        query.value = q
    }

    /** Selects a folder chip; selecting the current one again goes back to All. */
    fun setFolder(id: String?) {
        folder.value = if (folder.value == id) null else id
    }

    fun syncNow() {
        sync?.syncNow()
    }

    /** "Keep offline" (16 §6.2 offline pin); the next pull downloads it under any policy. */
    fun setPinned(
        key: String,
        pinned: Boolean,
    ) {
        viewModelScope.launch {
            index.setPinned(key, pinned)
            if (pinned) sync?.syncNow()
        }
    }

    /** Imports every readable `content:` URI; anything else is skipped (no `file:` confused deputy). */
    fun import(uris: List<Uri>) {
        if (uris.isEmpty()) {
            events.trySend(LibraryEvent.NothingToImport)
            return
        }
        viewModelScope.launch {
            val (ok, skipped) = writes.withLock { importAll(uris) }
            events.send(LibraryEvent.Imported(ok, skipped))
        }
    }

    /** Imports [uris] in order; returns (imported, skipped). */
    private suspend fun importAll(uris: List<Uri>): Pair<Int, Int> {
        var ok = 0
        var skipped = 0
        for (uri in uris.distinct()) {
            val result =
                if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
                    null
                } else {
                    withContext(Dispatchers.IO) {
                        val (name, bytes) = reader.read(uri) ?: return@withContext null
                        try {
                            importer.import(bytes, name)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: IOException) {
                            null
                        } catch (_: RuntimeException) {
                            // A full disk or an unwritable index: skip this file rather than crash.
                            null
                        }
                    }
                }
            if (result is ImportResult.Imported) ok++ else skipped++
        }
        return ok to skipped
    }

    /** Removes an imported document. Synced documents belong to the Mac and are not removed here. */
    fun remove(key: String) {
        viewModelScope.launch {
            val gone =
                writes.withLock {
                    if (index.find(key)?.synced != false) return@withLock null
                    index.remove(key)
                } ?: return@launch
            events.send(LibraryEvent.Removed(gone.title))
        }
    }

    companion object {
        /**
         * The rows for a folder chip and a search. [hits] are the full-text matches (null: no search
         * term); entries are also matched case-insensitively on title, tab labels and headings, so a
         * row whose index row is not written yet still shows. All excludes archived documents.
         */
        fun filterEntries(
            entries: List<DocEntry>,
            query: String,
            hits: Set<String>? = null,
            folder: String? = null,
            folderIds: Set<String> = emptySet(),
        ): List<DocEntry> {
            val inFolder =
                entries.filter { e ->
                    when (folder) {
                        null -> e.placement != DocumentEntity.PLACEMENT_ARCHIVE
                        FolderFilter.ARCHIVE -> e.placement == DocumentEntity.PLACEMENT_ARCHIVE
                        FolderFilter.UNFILED ->
                            e.placement == DocumentEntity.PLACEMENT_UNFILED ||
                                (e.placement == DocumentEntity.PLACEMENT_FOLDER && e.folderId !in folderIds)
                        else -> e.folderId == folder && e.placement == DocumentEntity.PLACEMENT_FOLDER
                    }
                }
            val terms = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (terms.isEmpty()) return inFolder
            return inFolder.filter { e ->
                if (hits != null && e.key in hits) return@filter true
                val hay = (listOf(e.title) + e.tabs + e.headings).joinToString("\n").lowercase()
                terms.all { it in hay }
            }
        }

        /** Reads at most [HtmlImporter.MAX_BYTES] + 1 bytes, so an oversized file is rejected, not loaded. */
        fun contentReader(resolver: ContentResolver): UriReader =
            UriReader { uri ->
                runCatching {
                    val name =
                        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                            if (c.moveToFirst()) c.getString(0) else null
                        }
                    val bytes =
                        resolver.openInputStream(uri)?.use { input -> readAtMost(input, HtmlImporter.MAX_BYTES + 1) }
                            ?: return@runCatching null
                    name to bytes
                }.getOrNull()
            }

        /** Reads up to [limit] bytes (InputStream.readNBytes needs API 33). */
        fun readAtMost(
            input: InputStream,
            limit: Int,
        ): ByteArray {
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            while (out.size() < limit) {
                val n = input.read(buf, 0, minOf(buf.size, limit - out.size()))
                if (n < 0) break
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }

        fun factory(
            container: AppContainer,
            resolver: ContentResolver,
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    val repo = container.syncRepository
                    val sync =
                        object : LibrarySync {
                            override val status = repo.status
                            override val lastSyncAt = container.preferences.lastSyncAt
                            override val folders = repo.folders
                            override fun syncNow() {
                                container.syncScheduler.syncNow()
                            }
                        }
                    LibraryViewModel(container.libraryIndex, container.importer, contentReader(resolver), sync)
                }
            }
    }
}
