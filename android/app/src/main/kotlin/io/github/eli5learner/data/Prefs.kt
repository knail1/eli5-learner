package io.github.eli5learner.data

import kotlinx.coroutines.flow.Flow

/** Which current versions download eagerly (16 §6.2, §6.4). Older versions download on demand. */
enum class OfflinePolicy(
    val id: String,
) {
    /** Every document in the library (default). */
    ALL("all"),

    /** The 20 most recently updated documents. */
    RECENT("recent"),

    /** Only documents pinned with "Keep offline". */
    PINNED("pinned"),
    ;

    companion object {
        const val RECENT_COUNT = 20

        fun of(id: String?): OfflinePolicy = entries.firstOrNull { it.id == id } ?: ALL
    }
}

/** The user's sync options, shown in Settings. */
data class SyncOptions(
    val offlinePolicy: OfflinePolicy = OfflinePolicy.ALL,
    /** Blobs over 5 MiB download on an unmetered network only (16 §6.4). */
    val largeOnWifiOnly: Boolean = true,
)

/**
 * Sync cursors and options in DataStore (16 §4.8, §6.4): the change token, the manifest `seq` this
 * phone holds, this phone's device file id, the last successful sync, and the user's options.
 * Implemented by [AppPreferences]; nothing here is a credential.
 */
interface SyncPrefs {
    val options: Flow<SyncOptions>

    /** Epoch ms of the last successful pull, or null. */
    val lastSyncAt: Flow<Long?>

    suspend fun deviceId(): String

    suspend fun cursor(): SyncCursor

    suspend fun updateCursor(change: (SyncCursor) -> SyncCursor)

    suspend fun setOptions(options: SyncOptions)

    suspend fun setLastSyncAt(ms: Long)

    /** Forgets every cursor (Disconnect, or a cache rebuilt from scratch); options and the device id stay. */
    suspend fun resetCursor()
}

/** Where this phone stands with the remote store. */
data class SyncCursor(
    /** `changes.getStartPageToken` / `newStartPageToken`; null means a full listing next time. */
    val startToken: String? = null,
    /** The `seq` of the manifest last applied (16 §4.4: a reader ignores one that is not greater). */
    val manifestSeq: Long = 0,
    /** This phone's `device-<id>.json` file id once created. */
    val deviceFileId: String? = null,
    /** A preallocated id for the device file, persisted before the create (16 §4.5 step 4). */
    val pendingDeviceFileId: String? = null,
    /** Hash of the device record last written, so an unchanged record is only touched. */
    val deviceRecordHash: String? = null,
    /** This phone's `acks-<id>.json` file id once created (16 §4.7). */
    val acksFileId: String? = null,
    /** A preallocated id for the acks file, persisted before the create. */
    val pendingAcksFileId: String? = null,
    /** Hash of the acks body last written, so an unchanged list is not rewritten. */
    val acksHash: String? = null,
)
