package io.github.eli5learner.share

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/**
 * Copies of documents handed to other apps, under `cacheDir/share/<random>/<name>.html` (16 §6.5).
 * The FileProvider exposes only this folder. Each copy gets its own random subfolder, so two
 * documents with the same title never clash and a copy a recipient is still reading is not
 * overwritten. Copies older than [MAX_AGE_MS] are removed on the next share and at app start; a
 * recipient such as a mail draft may read the URI lazily, so fresh copies are kept.
 */
class ShareCache(
    val root: File,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** Writes [bytes] to a new `root/<random>/<fileName>` and returns that file. */
    @Throws(IOException::class)
    fun stage(
        bytes: ByteArray,
        fileName: String,
    ): File {
        require(fileName.isNotEmpty() && fileName == File(fileName).name && fileName != "." && fileName != "..") { "invalid file name" }
        val dir = File(root, UUID.randomUUID().toString())
        if (!dir.mkdirs()) throw IOException("cannot create share folder")
        try {
            val tmp = File(dir, ".tmp-${UUID.randomUUID()}")
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            val target = File(dir, fileName)
            if (!tmp.renameTo(target)) throw IOException("cannot move share copy into place")
            return target
        } catch (e: IOException) {
            dir.deleteRecursively()
            throw e
        }
    }

    /** Removes entries under [root] last modified before `now - maxAgeMs`. Never throws. Returns the count. */
    fun cleanup(maxAgeMs: Long = MAX_AGE_MS): Int =
        runCatching {
            val cutoff = now() - maxAgeMs
            var removed = 0
            for (child in root.listFiles().orEmpty()) {
                val newest =
                    if (child.isDirectory) {
                        maxOf(child.lastModified(), child.listFiles().orEmpty().maxOfOrNull { it.lastModified() } ?: 0L)
                    } else {
                        child.lastModified()
                    }
                if (newest < cutoff && child.deleteRecursively()) removed++
            }
            removed
        }.getOrDefault(0)

    companion object {
        const val MAX_AGE_MS = 24L * 60 * 60 * 1000
    }
}
