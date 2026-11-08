package io.github.eli5learner.drive

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Drive REST v3 shapes the phone reads (16 §4.8), with the same narrow field mask as the desktop
 * (`src/main/sync/google/drive.ts`). Only the fields in [FILE_FIELDS] are ever requested.
 */
@Serializable
data class DriveFile(
    val id: String,
    val name: String? = null,
    val appProperties: Map<String, String>? = null,
    val sha256Checksum: String? = null,
    /** Drive reports sizes as decimal strings. */
    val size: String? = null,
    val modifiedTime: String? = null,
)

@Serializable
data class DriveChange(
    val fileId: String,
    val removed: Boolean = false,
    val file: DriveFile? = null,
)

/** The result of following `changes.list` to its end. */
data class ChangesPage(
    val changes: List<DriveChange>,
    val newStartPageToken: String,
)

@Serializable
internal data class FileListResponse(
    val files: List<DriveFile> = emptyList(),
    val nextPageToken: String? = null,
)

@Serializable
internal data class ChangeListResponse(
    val changes: List<DriveChange> = emptyList(),
    val nextPageToken: String? = null,
    val newStartPageToken: String? = null,
)

@Serializable
internal data class StartPageTokenResponse(
    val startPageToken: String? = null,
)

@Serializable
internal data class GeneratedIdsResponse(
    val ids: List<String> = emptyList(),
)

@Serializable
internal data class UserInfoResponse(
    val email: String? = null,
)

/** Metadata sent with a create (multipart or resumable). Always in the hidden app-data folder. */
@Serializable
internal data class CreateMetadata(
    val id: String,
    val name: String,
    val mimeType: String,
    val appProperties: Map<String, String>,
    val parents: List<String> = listOf(APP_DATA_FOLDER),
)

@Serializable
internal data class PropertiesPatch(
    val appProperties: Map<String, String>,
)

/** The fields every file response carries (16 §4.8). */
const val FILE_FIELDS = "id,name,appProperties,sha256Checksum,size,modifiedTime"
const val APP_DATA_FOLDER = "appDataFolder"

/** Drive answers with fields the app does not model; they are ignored, never an error. */
internal val DriveJson =
    Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

/**
 * Sync error codes (16 §10), the same names as the desktop's `SyncError`. Messages never carry file
 * names, bodies or tokens (16 §9).
 */
enum class SyncErrorCode {
    /** Grant lost; "Sign in again to keep syncing". */
    E_SYNC_AUTH,

    /** Change token expired or invalid; full rescan, no user text. */
    E_SYNC_TOKEN,

    /** Drive storage full; "Your Google Drive is full". */
    E_SYNC_QUOTA,

    /** The remote format is newer than this app; read-only, "Update ELI5 Learner to keep syncing". */
    E_SYNC_FORMAT,

    /** HTTP 404. */
    E_SYNC_NOT_FOUND,

    /** Any other failure after retries. */
    E_SYNC_HTTP,
}

class SyncException(
    val code: SyncErrorCode,
    message: String = code.name,
    /** The HTTP status that caused it, when there was one. */
    val status: Int? = null,
) : Exception(message)
