package io.github.eli5learner.share

import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** What a share needs from the UI: the document and the version to send. */
data class ShareRequest(
    val key: String,
    val sha: String,
    val title: String,
    /** Used for the file name when the title leaves nothing usable: the `docId` or storage key. */
    val fallbackName: String,
) {
    companion object {
        fun of(
            entry: DocEntry,
            sha: String,
        ): ShareRequest = ShareRequest(entry.key, sha, entry.title, entry.docId ?: entry.key)
    }
}

sealed interface SharePrepared {
    data class Ready(
        val file: File,
        val title: String,
    ) : SharePrepared

    /** Not on this phone, or the stored file no longer matches its hash. */
    data object Missing : SharePrepared

    /** An IO error while copying. */
    data object Failed : SharePrepared
}

/** Prepares a shareable copy of a stored version (16 §6.5). All file work runs on [io]. */
class DocSharer(
    private val store: DocStore,
    private val index: LibraryIndex,
    val cache: ShareCache,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    suspend fun prepare(req: ShareRequest): SharePrepared =
        withContext(io) {
            cache.cleanup()
            // Keeps a concurrent sync prune from deleting the file mid-copy.
            index.lease(req.key, req.sha)
            try {
                // read() verifies the hash, so a torn or tampered file is never sent.
                val bytes = store.read(req.key, req.sha) ?: return@withContext SharePrepared.Missing
                SharePrepared.Ready(cache.stage(bytes, ShareFileName.of(req.title, req.fallbackName)), req.title)
            } catch (_: IOException) {
                SharePrepared.Failed
            } finally {
                index.release(req.key, req.sha)
            }
        }

    /** App start: drop old copies off the main thread. */
    fun cleanupIn(scope: CoroutineScope) {
        scope.launch(io) { cache.cleanup() }
    }
}
