package io.github.eli5learner.data

import io.github.eli5learner.data.db.DocumentDao
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.data.db.FtsQuery
import io.github.eli5learner.importer.HtmlImporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** One document as the screens see it. Everything here can be re-derived from the file or the next pull. */
data class DocEntry(
    /** Storage key: the folder under `filesDir/docs` (`local-<sha>` for imports, the `docId` when synced). */
    val key: String,
    /** The sha of the copy on this phone; null while a synced document is not downloaded yet. */
    val sha: String?,
    val title: String,
    /** The ELI5 model's `docId`; null for a foreign file. */
    val docId: String? = null,
    val foreign: Boolean,
    /** Epoch ms: when it was imported, or the Mac's `updatedAt`. */
    val updatedAt: Long,
    val tabs: List<String> = emptyList(),
    val headings: List<String> = emptyList(),
    val source: String = DocumentEntity.SOURCE_IMPORTED,
    val summary: String = "",
    val placement: String = DocumentEntity.PLACEMENT_UNFILED,
    val folderId: String? = null,
    /** The Mac's current sha (synced only). */
    val remoteSha: String? = null,
    val currentVersionId: String? = null,
    val sizeBytes: Long = 0,
    val busy: Boolean = false,
    val pinned: Boolean = false,
    val unread: Boolean = false,
    val readingSha: String? = null,
    val readingPosition: Float = 0f,
) {
    val synced: Boolean get() = source == DocumentEntity.SOURCE_SYNCED

    /** A copy is on this phone and can be read offline. */
    val available: Boolean get() = sha != null

    val trashed: Boolean get() = placement == DocumentEntity.PLACEMENT_TRASH
}

/**
 * The library (16 §6.4): Room rows over the files in [DocStore]. Room is a cache: on the first
 * [load] of a process the rows are checked against the files and rebuilt from them where they
 * disagree (rows whose file is gone, files without a row), and the S2 JSON index ([legacyFile]) is
 * migrated in and deleted. Writes from the importer and the sync go through [write], one at a time,
 * so a file is never deleted under a fresh row.
 */
class LibraryIndex(
    private val db: Eli5Db,
    private val store: DocStore,
    private val legacyFile: File? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val dao: DocumentDao = db.documents()
    private val mutex = Mutex()

    @Volatile private var loaded = false

    /** `key` to the shas a Reader is showing; those files survive a prune (16 §6.4). */
    private val leases = ConcurrentHashMap<String, MutableMap<String, Int>>()

    /** Every entry, newest first (trash included; screens filter it). */
    val entries: Flow<List<DocEntry>> = dao.observeAll().map { rows -> sorted(rows.map(::toEntry)) }

    fun observe(key: String): Flow<DocEntry?> = dao.observe(key).map { it?.let(::toEntry) }

    suspend fun load(): List<DocEntry> {
        ensureLoaded()
        return sorted(dao.all().map(::toEntry))
    }

    suspend fun find(key: String): DocEntry? {
        ensureLoaded()
        return dao.get(key)?.let(::toEntry)
    }

    /** Keys matching [query] in the search index, or null when the query has no searchable term. */
    suspend fun search(query: String): Set<String>? {
        val match = FtsQuery.of(query) ?: return null
        ensureLoaded()
        return dao.search(match).toSet()
    }

    /** Runs [block] under the library's write lock, after the first load. */
    suspend fun <T> write(block: suspend (DocumentDao) -> T): T {
        ensureLoaded()
        return mutex.withLock { block(dao) }
    }

    sealed interface ImportSave {
        /** Saved; [replaced] are the keys of older copies (their files are the caller's to delete). */
        data class Saved(
            val replaced: List<String>,
        ) : ImportSave

        /** A copy synced from the Mac has the same `docId`; it wins (16 §6.4). */
        data object AlreadySynced : ImportSave
    }

    /**
     * Saves an import. [writeFile] runs under the lock before the row is written. An older import of
     * the same key or ELI5 `docId` is replaced.
     */
    suspend fun saveImport(
        entry: DocEntry,
        body: String,
        writeFile: () -> Unit,
    ): ImportSave =
        write { d ->
            val sameDoc = entry.docId?.let { d.byDocId(it) }.orEmpty()
            if (sameDoc.any { it.source == DocumentEntity.SOURCE_SYNCED }) return@write ImportSave.AlreadySynced
            withContext(Dispatchers.IO) { writeFile() }
            val replaced = (sameDoc.map { it.key } + listOfNotNull(d.get(entry.key)?.key)).distinct()
            replaced.filter { it != entry.key }.forEach { d.delete(it) }
            d.save(fromImport(entry), body)
            ImportSave.Saved(replaced)
        }

    /** Removes an entry and its files. */
    suspend fun remove(key: String): DocEntry? =
        write { d ->
            val gone = d.get(key) ?: return@write null
            d.delete(key)
            withContext(Dispatchers.IO) { store.delete(key) }
            toEntry(gone)
        }

    suspend fun setPinned(
        key: String,
        pinned: Boolean,
    ) = update(key) { it.copy(pinned = pinned) }

    /** The Reader opened [key]: the unread dot goes. */
    suspend fun markOpened(key: String) = update(key) { if (it.unread) it.copy(unread = false) else it }

    /** Remembers where the reader was in one version (16 §6.2: per document and sha). */
    suspend fun saveReadingPosition(
        key: String,
        sha: String,
        position: Float,
    ) = update(key) { it.copy(readingSha = sha, readingPosition = position.coerceIn(0f, 1f)) }

    private suspend fun update(
        key: String,
        change: (DocumentEntity) -> DocumentEntity,
    ) {
        write { d ->
            val row = d.get(key) ?: return@write
            val next = change(row)
            if (next != row) d.upsert(next)
        }
    }

    /** While a Reader shows `key/sha`, that file is kept when a newer version arrives. */
    fun lease(
        key: String,
        sha: String,
    ) {
        leases.compute(key) { _, m -> (m ?: mutableMapOf()).apply { merge(sha, 1, Int::plus) } }
    }

    fun release(
        key: String,
        sha: String,
    ) {
        leases.computeIfPresent(key) { _, m ->
            m.computeIfPresent(sha) { _, n -> if (n > 1) n - 1 else null }
            m.ifEmpty { null }
        }
    }

    fun leased(key: String): Set<String> = leases[key]?.keys?.toSet().orEmpty()

    /** Bytes used by document files. */
    suspend fun storageBytes(): Long = withContext(Dispatchers.IO) { store.root.walkTopDown().filter { it.isFile }.sumOf { it.length() } }

    /**
     * Clear cache (16 §6.2): drops downloaded copies of synced documents that are not open; they
     * download again on the next sync or when opened. Imported documents are the user's and stay.
     */
    suspend fun clearDownloads(): Int =
        write { d ->
            var n = 0
            for (row in d.all()) {
                if (row.source != DocumentEntity.SOURCE_SYNCED || row.localSha == null) continue
                val keep = leased(row.key)
                withContext(Dispatchers.IO) { store.pruneExcept(row.key, keep) }
                if (row.localSha !in keep) {
                    d.upsert(row.copy(localSha = null))
                    n++
                }
            }
            n
        }

    // ------------------------------------------------------------------------------ rebuild

    private suspend fun ensureLoaded() {
        if (loaded) return
        mutex.withLock {
            if (loaded) return
            reconcile()
            loaded = true
        }
    }

    /** Checks rows against files (16 §6.4: Room can always be rebuilt from `filesDir/docs`). */
    private suspend fun reconcile() {
        val present = withContext(Dispatchers.IO) { store.list() }.groupBy({ it.first }, { it.second })
        val legacy = withContext(Dispatchers.IO) { readLegacy() }.associateBy { it.key }
        val rows = dao.all().associateBy { it.key }

        for (row in rows.values) {
            val shas = present[row.key].orEmpty()
            when {
                row.localSha == null || row.localSha in shas -> Unit
                // A synced copy whose file is gone downloads again on the next pull.
                row.source == DocumentEntity.SOURCE_SYNCED -> dao.upsert(row.copy(localSha = null))
                else -> dao.delete(row.key)
            }
        }
        for ((key, shas) in present) {
            if (key in rows) continue
            val old = legacy[key]
            val sha = shas.firstOrNull { it == old?.sha } ?: shas.first()
            val bytes = withContext(Dispatchers.IO) { store.read(key, sha) } ?: continue
            val html = bytes.toString(Charsets.UTF_8)
            val i = HtmlImporter.inspect(html)
            val imported = key.startsWith(IMPORTED_PREFIX)
            val row =
                DocumentEntity(
                    key = key,
                    docId = i.docId ?: if (imported) null else key,
                    source = if (imported) DocumentEntity.SOURCE_IMPORTED else DocumentEntity.SOURCE_SYNCED,
                    title = old?.title ?: i.title,
                    tabs = i.tabs.joinToString("\n"),
                    headings = i.headings.joinToString("\n"),
                    foreign = !i.isEli5,
                    updatedAt = old?.importedAt ?: clock(),
                    localSha = sha,
                    remoteSha = if (imported) null else sha,
                )
            dao.save(row, if (i.isEli5) HtmlImporter.modelText(html) else "")
        }
        legacyFile?.let { f -> withContext(Dispatchers.IO) { f.delete() } }
    }

    @Serializable
    private data class LegacyEntry(
        val key: String,
        val sha: String,
        val title: String,
        val importedAt: Long,
    )

    @Serializable
    private data class LegacyFile(
        val entries: List<LegacyEntry> = emptyList(),
    )

    /** The S2 JSON index, read once for titles and import times. */
    private fun readLegacy(): List<LegacyEntry> {
        val f = legacyFile?.takeIf { it.isFile } ?: return emptyList()
        return runCatching { LEGACY_JSON.decodeFromString(LegacyFile.serializer(), f.readText()).entries }.getOrDefault(emptyList())
    }

    companion object {
        const val IMPORTED_PREFIX = "local-"
        private val LEGACY_JSON = Json { ignoreUnknownKeys = true }

        fun sorted(list: List<DocEntry>): List<DocEntry> = list.sortedWith(compareByDescending<DocEntry> { it.updatedAt }.thenBy { it.key })

        fun lines(s: String): List<String> = if (s.isEmpty()) emptyList() else s.split('\n')

        fun toEntry(r: DocumentEntity): DocEntry =
            DocEntry(
                key = r.key,
                sha = r.localSha,
                title = r.title,
                docId = r.docId,
                foreign = r.foreign,
                updatedAt = r.updatedAt,
                tabs = lines(r.tabs),
                headings = lines(r.headings),
                source = r.source,
                summary = r.summary,
                placement = r.placement,
                folderId = r.folderId,
                remoteSha = r.remoteSha,
                currentVersionId = r.currentVersionId,
                sizeBytes = r.sizeBytes,
                busy = r.busy,
                pinned = r.pinned,
                unread = r.unread,
                readingSha = r.readingSha,
                readingPosition = r.readingPosition,
            )

        fun fromImport(e: DocEntry): DocumentEntity =
            DocumentEntity(
                key = e.key,
                docId = e.docId,
                source = DocumentEntity.SOURCE_IMPORTED,
                title = e.title,
                tabs = e.tabs.joinToString("\n"),
                headings = e.headings.joinToString("\n"),
                foreign = e.foreign,
                updatedAt = e.updatedAt,
                localSha = e.sha,
            )
    }
}
