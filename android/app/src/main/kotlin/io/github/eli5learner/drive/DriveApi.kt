package io.github.eli5learner.drive

/**
 * The Drive calls library sync makes (16 §4.8, §4.3): the phone's side of the `SyncStore` port.
 * [DriveClient] implements it; sync tests use an in-memory fake.
 */
interface DriveApi {
    /** Every file in the app-data folder (filtered by `appProperties` when [props] is not empty). */
    suspend fun list(props: Map<String, String> = emptyMap()): List<DriveFile>

    suspend fun startPageToken(): String

    /** Throws `E_SYNC_TOKEN` when [token] expired or is invalid. */
    suspend fun changes(token: String): ChangesPage

    suspend fun download(fileId: String): ByteArray

    /**
     * Downloads at most [maxBytes]; null when the file is larger, without reading the rest. Sync uses
     * this for everything another device wrote, since a listing's `size` can be missing.
     */
    suspend fun downloadAtMost(
        fileId: String,
        maxBytes: Long,
    ): ByteArray? = download(fileId).takeIf { it.size <= maxBytes }

    suspend fun generateIds(count: Int): List<String>

    suspend fun create(
        id: String,
        name: String,
        appProperties: Map<String, String>,
        mime: String,
        body: ByteArray,
    ): DriveFile

    suspend fun updateContent(
        fileId: String,
        body: ByteArray,
        mime: String,
    ): DriveFile

    /** Metadata only: no new revision (the heartbeat). */
    suspend fun patchProperties(
        fileId: String,
        appProperties: Map<String, String>,
    )
}
