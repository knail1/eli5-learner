package io.github.eli5learner.data

import io.github.eli5learner.importer.HtmlImporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** One document in the library. Everything here can be re-derived from the file itself. */
@Serializable
data class DocEntry(
    /** Storage key: the folder under `filesDir/docs` (`local-<sha>` for imports, 16 §6.4). */
    val key: String,
    val sha: String,
    val title: String,
    /** The ELI5 model's `docId`; null for a foreign file. */
    val docId: String? = null,
    val foreign: Boolean,
    val importedAt: Long,
    val tabs: List<String> = emptyList(),
    val headings: List<String> = emptyList(),
    /** `imported` in local mode; `synced` arrives with sync (16 §6.4). */
    val source: String = SOURCE_IMPORTED,
) {
    companion object {
        const val SOURCE_IMPORTED = "imported"
    }
}

@Serializable
private data class IndexFile(
    val version: Int = 1,
    val entries: List<DocEntry> = emptyList(),
)

/**
 * The library index for local mode (16 §6.4, §7): a small JSON file next to the documents. It is a
 * cache: when it is missing or unreadable it is rebuilt from the files in [DocStore], so losing it
 * loses nothing but import times. Sync replaces it with Room in a later slice.
 */
class LocalIndex(
    private val file: File,
    private val store: DocStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private val state = MutableStateFlow<List<DocEntry>>(emptyList())
    private var loaded = false

    /** Library entries, newest import first. Empty until [load] runs. */
    val entries: StateFlow<List<DocEntry>> = state.asStateFlow()

    suspend fun load(): List<DocEntry> =
        mutex.withLock {
            ensureLoaded()
            state.value
        }

    suspend fun find(key: String): DocEntry? = load().firstOrNull { it.key == key }

    /**
     * Inserts or replaces [entry]. A previous entry with the same key, or with the same ELI5 `docId`,
     * is replaced. Returns the keys of the replaced entries (their files are the caller's to delete).
     */
    suspend fun upsert(entry: DocEntry): List<String> =
        mutex.withLock {
            ensureLoaded()
            val replaced = state.value.filter { it.key == entry.key || (entry.docId != null && it.docId == entry.docId) }
            commit(listOf(entry) + (state.value - replaced.toSet()))
            replaced.map { it.key }
        }

    suspend fun remove(key: String): DocEntry? =
        mutex.withLock {
            ensureLoaded()
            val gone = state.value.firstOrNull { it.key == key } ?: return@withLock null
            commit(state.value - gone)
            gone
        }

    private suspend fun ensureLoaded() {
        if (loaded) return
        val fromFile = withContext(Dispatchers.IO) { readFile() }
        val present = withContext(Dispatchers.IO) { store.list().toSet() }
        val entries =
            if (fromFile != null &&
                fromFile.all { (it.key to it.sha) in present } &&
                fromFile.map { it.key }.toSet() == present.map { it.first }.toSet()
            ) {
                fromFile
            } else {
                withContext(Dispatchers.IO) { rebuild(fromFile.orEmpty(), present) }
            }
        state.value = sorted(entries)
        loaded = true
        if (entries != fromFile) withContext(Dispatchers.IO) { writeFile(state.value) }
    }

    /** Re-derives entries from the files, keeping the import times the old index still knows. */
    private fun rebuild(
        old: List<DocEntry>,
        present: Set<Pair<String, String>>,
    ): List<DocEntry> {
        val known = old.associateBy { it.key to it.sha }
        return present.groupBy({ it.first }, { it.second }).mapNotNull { (key, shas) ->
            // A key holds one current file; when several are left over, the one the index knows wins.
            val sha = shas.firstOrNull { (key to it) in known } ?: shas.first()
            known[key to sha] ?: run {
                val bytes = store.read(key, sha) ?: return@run null
                val i = HtmlImporter.inspect(bytes.toString(Charsets.UTF_8))
                DocEntry(
                    key = key,
                    sha = sha,
                    title = i.title,
                    docId = i.docId,
                    foreign = !i.isEli5,
                    importedAt = clock(),
                    tabs = i.tabs,
                    headings = i.headings,
                )
            }
        }
    }

    private suspend fun commit(next: List<DocEntry>) {
        val sortedNext = sorted(next)
        withContext(Dispatchers.IO) { writeFile(sortedNext) }
        state.value = sortedNext
    }

    private fun sorted(list: List<DocEntry>) = list.sortedWith(compareByDescending<DocEntry> { it.importedAt }.thenBy { it.key })

    private fun readFile(): List<DocEntry>? =
        runCatching { JSON.decodeFromString(IndexFile.serializer(), file.readText()).entries }.getOrNull()

    private fun writeFile(entries: List<DocEntry>) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(JSON.encodeToString(IndexFile.serializer(), IndexFile(entries = entries)).toByteArray())
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) error("cannot write the library index")
        } finally {
            tmp.delete()
        }
    }

    private companion object {
        val JSON = Json { ignoreUnknownKeys = true }
    }
}
