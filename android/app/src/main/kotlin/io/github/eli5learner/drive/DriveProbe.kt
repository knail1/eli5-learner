package io.github.eli5learner.drive

/**
 * The phone half of gate G1 (16 §13), reached only from Settings > Diagnostics in debug builds:
 * write `probe-phone.json` to the app-data folder, list and read the desktop's `probe-desktop.json`,
 * report what `changes.list` saw, and delete the phone's own probe. Probe files carry
 * `appProperties {k: "probe", dev: <deviceId>}` and are never part of the sync layout.
 */
class DriveProbe(
    private val drive: DriveClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Listing(
        val total: Int,
        /** Probe files by name (any device), with their ids. */
        val probes: List<DriveFile>,
    )

    /** Writes `probe-phone.json`; returns its file id. */
    suspend fun write(deviceId: String): String {
        val id = drive.generateIds(1).single()
        val body = """{"probe":"phone","deviceId":"$deviceId","writtenAt":${now()}}""".encodeToByteArray()
        return drive.create(id, PHONE_PROBE, mapOf("k" to KIND, "dev" to deviceId), "application/json", body).id
    }

    /** Lists the whole app-data folder: a count, plus every `probe-*` file. */
    suspend fun list(): Listing {
        val all = drive.list()
        return Listing(all.size, all.filter { it.name?.startsWith("probe-") == true }.sortedBy { it.name })
    }

    /** Reads the desktop's probe; null when it is not there (yet). At most [MAX_PREVIEW] characters. */
    suspend fun readDesktopProbe(): String? {
        val f = drive.list().firstOrNull { it.name == DESKTOP_PROBE } ?: return null
        return drive.download(f.id).decodeToString().take(MAX_PREVIEW)
    }

    suspend fun startToken(): String = drive.startPageToken()

    /** The changes since [token]; names only for probe files, so nothing else is shown. */
    suspend fun changesSince(token: String): Pair<List<String>, String> {
        val page = drive.changes(token)
        val lines =
            page.changes.map { c ->
                val name = c.file?.name?.takeIf { it.startsWith("probe-") } ?: "(other file)"
                if (c.removed) "removed $name" else "changed $name"
            }
        return lines to page.newStartPageToken
    }

    /** Deletes the probes this phone wrote; returns how many. */
    suspend fun deleteOwn(deviceId: String): Int {
        val mine = drive.list(mapOf("k" to KIND, "dev" to deviceId))
        mine.forEach { drive.delete(it.id) }
        return mine.size
    }

    companion object {
        const val KIND = "probe"
        const val PHONE_PROBE = "probe-phone.json"
        const val DESKTOP_PROBE = "probe-desktop.json"
        const val MAX_PREVIEW = 500
    }
}
