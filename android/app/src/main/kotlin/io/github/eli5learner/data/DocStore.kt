package io.github.eli5learner.data

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

/**
 * Document files on the phone (16 §6.4): `<root>/<key>/<sha>.html`, where `sha` is the lowercase hex
 * SHA-256 of the bytes. Writes are atomic (temp file, fsync, rename) and reads verify the hash, so a
 * torn or tampered file is never served. `root` is `filesDir/docs` in the app.
 */
class DocStore(
    val root: File,
) {
    /** Writes [bytes] under [key] and returns their sha. Idempotent for identical bytes. */
    @Throws(IOException::class)
    fun write(
        key: String,
        bytes: ByteArray,
    ): String {
        requireKey(key)
        val sha = sha256Hex(bytes)
        val dir = File(root, key)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create document folder")
        val target = File(dir, "$sha.html")
        // Idempotent only for an intact copy; a torn or tampered file of the same name is replaced.
        if (target.isFile && target.length() == bytes.size.toLong() && read(key, sha) != null) return sha
        val tmp = File(dir, ".tmp-${UUID.randomUUID()}")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            if (!tmp.renameTo(target)) throw IOException("cannot move document into place")
        } finally {
            tmp.delete()
        }
        return sha
    }

    /** The bytes of `<key>/<sha>.html` when the file exists and its hash matches, else null. */
    fun read(
        key: String,
        sha: String,
    ): ByteArray? {
        if (!isValidKey(key) || !isValidSha(sha)) return null
        val f = File(File(root, key), "$sha.html")
        if (!f.isFile) return null
        val bytes = runCatching { f.readBytes() }.getOrNull() ?: return null
        return bytes.takeIf { sha256Hex(it) == sha }
    }

    /** Whether `<key>/<sha>.html` exists (not verified; [read] verifies). */
    fun exists(
        key: String,
        sha: String,
    ): Boolean = isValidKey(key) && isValidSha(sha) && File(File(root, key), "$sha.html").isFile

    /** Every stored `(key, sha)` pair, for rebuilding the index from the files. */
    fun list(): List<Pair<String, String>> =
        root
            .listFiles()
            .orEmpty()
            .filter { it.isDirectory && isValidKey(it.name) }
            .flatMap { dir ->
                dir
                    .listFiles()
                    .orEmpty()
                    .filter { it.isFile && it.name.endsWith(".html") && isValidSha(it.name.removeSuffix(".html")) }
                    .map { dir.name to it.name.removeSuffix(".html") }
            }.sortedWith(compareBy({ it.first }, { it.second }))

    /** Removes every file under [key]. */
    fun delete(key: String) {
        requireKey(key)
        File(root, key).deleteRecursively()
    }

    /** Removes the other shas under [key], keeping [sha]. */
    fun prune(
        key: String,
        sha: String,
    ) = pruneExcept(key, setOf(sha))

    /** Removes every file under [key] except the shas in [keep]; the folder goes when nothing is left. */
    fun pruneExcept(
        key: String,
        keep: Set<String>,
    ) {
        requireKey(key)
        val dir = File(root, key)
        dir
            .listFiles()
            .orEmpty()
            .filter { it.isFile && it.name.removeSuffix(".html") !in keep }
            .forEach { it.delete() }
        if (dir.isDirectory && dir.listFiles().isNullOrEmpty()) dir.delete()
    }

    companion object {
        private val KEY_RE = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
        private val SHA_RE = Regex("^[0-9a-f]{64}$")

        fun isValidKey(key: String): Boolean = KEY_RE.matches(key)

        fun isValidSha(sha: String): Boolean = SHA_RE.matches(sha)

        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** The storage key of an imported document (16 §6.4). */
        fun importedKey(sha: String): String = "local-$sha"

        private fun requireKey(key: String) = require(isValidKey(key)) { "invalid document key" }
    }
}
