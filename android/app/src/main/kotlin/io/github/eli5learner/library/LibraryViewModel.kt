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
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LocalIndex
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.importer.ImportResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
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
    /** Every entry, unfiltered (the empty state depends on it, not on the search). */
    val total: Int = 0,
    val items: List<DocEntry> = emptyList(),
)

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
class LibraryViewModel(
    private val index: LocalIndex,
    private val store: DocStore,
    private val importer: HtmlImporter,
    private val reader: UriReader,
) : ViewModel() {
    private val query = MutableStateFlow("")
    private val loaded = MutableStateFlow(false)
    private val events = Channel<LibraryEvent>(Channel.BUFFERED)

    /**
     * Imports and removals run one at a time: an import writes the file before it updates the index,
     * so a concurrent removal of the same key could otherwise delete the file under a fresh entry.
     */
    private val writes = Mutex()

    val messages: Flow<LibraryEvent> = events.receiveAsFlow()

    val state: StateFlow<LibraryUiState> =
        combine(index.entries, query, loaded) { entries, q, isLoaded ->
            LibraryUiState(loaded = isLoaded, query = q, total = entries.size, items = filterEntries(entries, q))
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

    fun remove(key: String) {
        viewModelScope.launch {
            val gone =
                writes.withLock {
                    val removed = index.remove(key) ?: return@withLock null
                    withContext(Dispatchers.IO) { store.delete(removed.key) }
                    removed
                } ?: return@launch
            events.send(LibraryEvent.Removed(gone.title))
        }
    }

    companion object {
        /** Case-insensitive match on title, tab labels and section headings. */
        fun filterEntries(
            entries: List<DocEntry>,
            query: String,
        ): List<DocEntry> {
            val terms = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (terms.isEmpty()) return entries
            return entries.filter { e ->
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
                    LibraryViewModel(container.localIndex, container.docStore, container.importer, contentReader(resolver))
                }
            }
    }
}
