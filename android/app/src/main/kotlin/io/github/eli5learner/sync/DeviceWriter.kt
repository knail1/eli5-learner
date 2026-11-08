package io.github.eli5learner.sync

import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.SyncPrefs
import io.github.eli5learner.data.db.RemoteFileEntity
import io.github.eli5learner.drive.DriveApi
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import io.github.eli5learner.sync.protocol.DeviceRecord
import io.github.eli5learner.sync.protocol.DeviceRole
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.PROTOCOL_VERSION
import io.github.eli5learner.sync.protocol.Platform
import io.github.eli5learner.sync.protocol.SyncProtocol

/**
 * This phone's `device-<deviceId>.json` (16 §4.3), the only file library sync writes. Created once
 * under a preallocated id that is persisted before the upload (16 §4.5 step 4), rewritten only when
 * the record changes (an app update), and touched with `seen` (metadata only, no revision) on every
 * sync. A phone never accepts jobs and has no inbox.
 */
class DeviceWriter(
    private val drive: DriveApi,
    private val prefs: SyncPrefs,
    private val name: String,
    private val appVersion: String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun heartbeat(files: List<RemoteFileEntity>) {
        val me = prefs.deviceId()
        val body = SyncProtocol.encode(DeviceRecord.serializer(), record(me)).toByteArray()
        val hash = DocStore.sha256Hex(body)
        val seen = mapOf("seen" to (now() / 1000).toString())

        var cursor = prefs.cursor()
        // A device file this phone wrote earlier but whose id it lost (cleared cursor) is adopted, not duplicated.
        if (cursor.deviceFileId == null) {
            files.firstOrNull { it.kind == SyncRepository.KIND_DEVICE && it.dev == me }?.let { own ->
                prefs.updateCursor { it.copy(deviceFileId = own.fileId, deviceRecordHash = null) }
                cursor = prefs.cursor()
            }
        }
        cursor.deviceFileId?.let { fileId ->
            try {
                if (cursor.deviceRecordHash != hash) {
                    drive.updateContent(fileId, body, JSON_MIME)
                    prefs.updateCursor { it.copy(deviceRecordHash = hash) }
                }
                drive.patchProperties(fileId, seen)
                return
            } catch (e: SyncException) {
                if (e.code != SyncErrorCode.E_SYNC_NOT_FOUND) throw e
                // Gone (for example "Delete cloud copy" on the Mac): create it again below.
                prefs.updateCursor { it.copy(deviceFileId = null, deviceRecordHash = null) }
            }
        }

        val id =
            prefs.cursor().pendingDeviceFileId
                ?: drive.generateIds(1).single().also { id -> prefs.updateCursor { it.copy(pendingDeviceFileId = id) } }
        val props = mapOf("k" to SyncRepository.KIND_DEVICE, "dev" to me) + seen
        val created = drive.create(id, "device-$me.json", props, JSON_MIME, body)
        val p = created.appProperties.orEmpty()
        if (p["k"] != SyncRepository.KIND_DEVICE || p["dev"] != me) {
            // The preallocated id holds someone else's file: leave it alone and start over next time.
            prefs.updateCursor { it.copy(pendingDeviceFileId = null) }
            throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Device file id is taken")
        }
        prefs.updateCursor { it.copy(deviceFileId = created.id, pendingDeviceFileId = null, deviceRecordHash = hash) }
    }

    private fun record(me: String) =
        DeviceRecord(
            v = PROTOCOL_VERSION,
            deviceId = me,
            platform = Platform.ANDROID,
            name = name.trim().take(MAX_NAME).ifEmpty { DEFAULT_NAME },
            appVersion = appVersion.trim().take(MAX_VERSION).ifEmpty { "0" },
            role = DeviceRole.PHONE,
            accepts = emptyList(),
            inbox = InboxState.OFF,
        )

    companion object {
        const val JSON_MIME = "application/json"
        const val DEFAULT_NAME = "Android phone"
        private const val MAX_NAME = 100
        private const val MAX_VERSION = 40
    }
}
