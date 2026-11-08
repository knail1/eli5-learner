package io.github.eli5learner.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
abstract class DocumentDao {
    @Query("SELECT * FROM documents")
    abstract fun observeAll(): Flow<List<DocumentEntity>>

    @Query("SELECT * FROM documents")
    abstract suspend fun all(): List<DocumentEntity>

    @Query("SELECT * FROM documents WHERE `key` = :key")
    abstract suspend fun get(key: String): DocumentEntity?

    @Query("SELECT * FROM documents WHERE `key` = :key")
    abstract fun observe(key: String): Flow<DocumentEntity?>

    @Query("SELECT * FROM documents WHERE docId = :docId")
    abstract suspend fun byDocId(docId: String): List<DocumentEntity>

    @Upsert
    abstract suspend fun upsert(doc: DocumentEntity)

    @Query("DELETE FROM documents WHERE `key` = :key")
    protected abstract suspend fun deleteRow(key: String)

    @Insert
    protected abstract suspend fun insertFts(row: DocumentFts)

    @Query("DELETE FROM document_fts WHERE `key` = :key")
    protected abstract suspend fun deleteFts(key: String)

    @Query("DELETE FROM document_fts")
    protected abstract suspend fun clearFts()

    @Query("DELETE FROM documents")
    protected abstract suspend fun clearRows()

    /** Keys whose indexed text matches an FTS4 expression (see [FtsQuery]). */
    @Query("SELECT `key` FROM document_fts WHERE document_fts MATCH :match")
    abstract suspend fun search(match: String): List<String>

    /** The indexed plain text of [key]'s cached file, kept when only the manifest metadata changes. */
    @Query("SELECT body FROM document_fts WHERE `key` = :key LIMIT 1")
    abstract suspend fun ftsBody(key: String): String?

    /** Writes [doc] and replaces its search row; [body] is the plain text of the cached file ("" when not cached). */
    @Transaction
    open suspend fun save(
        doc: DocumentEntity,
        body: String?,
    ) {
        upsert(doc)
        deleteFts(doc.key)
        insertFts(
            DocumentFts(
                key = doc.key,
                title = doc.title,
                summary = doc.summary,
                headings = doc.headings,
                body = body.orEmpty(),
            ),
        )
    }

    @Transaction
    open suspend fun delete(key: String) {
        deleteRow(key)
        deleteFts(key)
    }

    @Transaction
    open suspend fun clear() {
        clearRows()
        clearFts()
    }
}

@Dao
abstract class FolderDao {
    @Query("SELECT * FROM folders ORDER BY position")
    abstract fun observe(): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders ORDER BY position")
    abstract suspend fun all(): List<FolderEntity>

    @Insert
    protected abstract suspend fun insert(rows: List<FolderEntity>)

    @Query("DELETE FROM folders")
    abstract suspend fun clear()

    @Transaction
    open suspend fun replace(rows: List<FolderEntity>) {
        clear()
        insert(rows)
    }
}

@Dao
abstract class VersionDao {
    @Query("SELECT * FROM versions WHERE docId = :docId ORDER BY position")
    abstract suspend fun forDoc(docId: String): List<VersionEntity>

    @Insert
    protected abstract suspend fun insert(rows: List<VersionEntity>)

    @Query("DELETE FROM versions WHERE docId = :docId")
    abstract suspend fun deleteDoc(docId: String)

    @Query("DELETE FROM versions")
    abstract suspend fun clear()

    @Transaction
    open suspend fun replace(
        docId: String,
        rows: List<VersionEntity>,
    ) {
        deleteDoc(docId)
        insert(rows)
    }
}

@Dao
abstract class DeviceDao {
    @Query("SELECT * FROM devices")
    abstract fun observe(): Flow<List<DeviceEntity>>

    @Query("SELECT * FROM devices")
    abstract suspend fun all(): List<DeviceEntity>

    @Insert
    protected abstract suspend fun insert(rows: List<DeviceEntity>)

    @Query("DELETE FROM devices")
    abstract suspend fun clear()

    @Transaction
    open suspend fun replace(rows: List<DeviceEntity>) {
        clear()
        insert(rows)
    }
}

@Dao
abstract class RemoteFileDao {
    @Query("SELECT * FROM remote_files")
    abstract suspend fun all(): List<RemoteFileEntity>

    @Query("SELECT COUNT(*) FROM remote_files")
    abstract suspend fun count(): Int

    @Upsert
    abstract suspend fun upsert(rows: List<RemoteFileEntity>)

    @Query("DELETE FROM remote_files WHERE fileId IN (:ids)")
    abstract suspend fun delete(ids: List<String>)

    @Query("DELETE FROM remote_files")
    abstract suspend fun clear()

    @Transaction
    open suspend fun replace(rows: List<RemoteFileEntity>) {
        clear()
        upsert(rows)
    }

    /** Applies one page of changes in one transaction. */
    @Transaction
    open suspend fun apply(
        upserts: List<RemoteFileEntity>,
        removed: List<String>,
    ) {
        if (removed.isNotEmpty()) removed.chunked(500).forEach { delete(it) }
        if (upserts.isNotEmpty()) upsert(upserts)
    }
}

@Dao
abstract class JobDao {
    /** Jobs the Inbox lists, newest first. */
    @Query("SELECT * FROM jobs WHERE hidden = 0 ORDER BY createdAt DESC")
    abstract fun observeVisible(): Flow<List<JobEntity>>

    @Query("SELECT * FROM jobs ORDER BY createdAt")
    abstract suspend fun all(): List<JobEntity>

    @Query("SELECT jobId FROM jobs")
    abstract suspend fun ids(): List<String>

    @Query("SELECT COUNT(*) FROM jobs")
    abstract suspend fun count(): Int

    @Query("SELECT * FROM jobs WHERE jobId = :jobId")
    abstract suspend fun get(jobId: String): JobEntity?

    /** Jobs waiting to upload, oldest first (16 §5.2 step 2). */
    @Query("SELECT * FROM jobs WHERE local = 'local' ORDER BY createdAt")
    abstract suspend fun waiting(): List<JobEntity>

    @Query("SELECT * FROM jobs WHERE local = 'uploaded' ORDER BY createdAt")
    abstract suspend fun uploaded(): List<JobEntity>

    /** True while a sent job has no terminal status yet: the foreground poll runs (16 §4.8). */
    @Query(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE hidden = 0 AND (local = 'local' OR " +
            "(local = 'uploaded' AND (remoteState IS NULL OR remoteState NOT IN ('done','failed','rejected','cancelled')))))",
    )
    abstract fun observeActive(): Flow<Boolean>

    @Upsert
    abstract suspend fun upsert(job: JobEntity)

    @Query("UPDATE jobs SET cancelRequested = 1 WHERE jobId = :jobId")
    abstract suspend fun requestCancel(jobId: String)

    @Query("SELECT * FROM job_attachments WHERE jobId = :jobId ORDER BY position")
    abstract suspend fun attachments(jobId: String): List<JobAttachmentEntity>

    @Upsert
    abstract suspend fun upsertAttachment(att: JobAttachmentEntity)

    @Insert
    protected abstract suspend fun insertAttachments(rows: List<JobAttachmentEntity>)

    @Query("DELETE FROM jobs WHERE jobId = :jobId")
    protected abstract suspend fun deleteRow(jobId: String)

    @Query("DELETE FROM job_attachments WHERE jobId = :jobId")
    protected abstract suspend fun deleteAttachments(jobId: String)

    @Transaction
    open suspend fun insert(
        job: JobEntity,
        attachments: List<JobAttachmentEntity>,
    ) {
        upsert(job)
        deleteAttachments(job.jobId)
        if (attachments.isNotEmpty()) insertAttachments(attachments)
    }

    @Transaction
    open suspend fun delete(jobId: String) {
        deleteRow(jobId)
        deleteAttachments(jobId)
    }
}
