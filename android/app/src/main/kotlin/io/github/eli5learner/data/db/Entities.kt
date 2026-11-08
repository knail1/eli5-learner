package io.github.eli5learner.data.db

import androidx.room.Entity
import androidx.room.Index

/*
 * Room tables (16 §6.4). Everything here is a cache: documents are rebuilt from the files under
 * `filesDir/docs` and from the next pull, so the schema can be dropped and recreated at any time.
 * Jobs and attachments arrive with the capture slice.
 */

/**
 * One document in the library: an imported file (`source = imported`, key `local-<sha>`) or a
 * document from the Mac's manifest (`source = synced`, key = its `docId`).
 */
@Entity(tableName = "documents", indices = [Index("docId")])
data class DocumentEntity(
    /** Storage key: the folder under `filesDir/docs`. */
    @androidx.room.PrimaryKey val key: String,
    /** The ELI5 model's (or the manifest's) `docId`; null for a foreign file. */
    val docId: String?,
    /** [SOURCE_IMPORTED] or [SOURCE_SYNCED]. */
    val source: String,
    val title: String,
    val summary: String = "",
    /** Tab labels, newline-separated. */
    val tabs: String = "",
    /** Section headings, newline-separated. */
    val headings: String = "",
    val foreign: Boolean = false,
    /** Epoch ms: import time, or the manifest's `updatedAt`. */
    val updatedAt: Long,
    val createdAt: Long = updatedAt,
    /** `folder`, `unfiled`, `archive` or `trash` (synced only). */
    val placement: String = PLACEMENT_UNFILED,
    val folderId: String? = null,
    /** The manifest's current version and its sha (synced only). */
    val currentVersionId: String? = null,
    val remoteSha: String? = null,
    val sizeBytes: Long = 0,
    /** Your Mac is updating this document (16 §4.4 `busy`). */
    val busy: Boolean = false,
    /** The sha of the copy on this phone, or null when it is not downloaded yet. */
    val localSha: String? = null,
    /** Kept offline under the "Pinned" policy (16 §6.4). */
    val pinned: Boolean = false,
    /** A new current version arrived and has not been opened yet. */
    val unread: Boolean = false,
    /** Reading position: the sha it belongs to and the scroll fraction (0..1). */
    val readingSha: String? = null,
    val readingPosition: Float = 0f,
    /** The tree `seq` last applied (synced only). */
    val treeSeq: Long = 0,
) {
    companion object {
        const val SOURCE_IMPORTED = "imported"
        const val SOURCE_SYNCED = "synced"
        const val PLACEMENT_FOLDER = "folder"
        const val PLACEMENT_UNFILED = "unfiled"
        const val PLACEMENT_ARCHIVE = "archive"
        const val PLACEMENT_TRASH = "trash"
    }
}

/** A folder from the manifest, in the Mac's order. */
@Entity(tableName = "folders")
data class FolderEntity(
    @androidx.room.PrimaryKey val id: String,
    val name: String,
    val position: Int,
)

/** One node of a document's version tree (16 §4.4), read-only on the phone. */
@Entity(tableName = "versions", primaryKeys = ["docId", "id"])
data class VersionEntity(
    val docId: String,
    val id: String,
    val parentId: String?,
    val kind: String,
    val label: String,
    val createdAt: String,
    val sha: String?,
    val uploaded: Boolean,
    val position: Int,
)

/** A device file (16 §4.3) as last read, with its heartbeat. */
@Entity(tableName = "devices")
data class DeviceEntity(
    @androidx.room.PrimaryKey val deviceId: String,
    val platform: String,
    val name: String,
    val role: String,
    /** Job kinds, comma-separated. */
    val accepts: String,
    val inbox: String,
    /** The `seen` heartbeat in epoch seconds, if any. */
    val seen: Long?,
)

/**
 * The phone's mirror of the remote store's listing (16 §4.8): one row per file, from `files.list`
 * at bootstrap and `changes.list` afterwards. Identity comes from `appProperties` (16 §4.2).
 */
@Entity(tableName = "remote_files", indices = [Index("kind")])
data class RemoteFileEntity(
    @androidx.room.PrimaryKey val fileId: String,
    val kind: String,
    val dev: String?,
    val docId: String?,
    val s: String?,
    val n: Long?,
    val seen: Long?,
    val size: Long?,
    val modifiedTime: String?,
)
