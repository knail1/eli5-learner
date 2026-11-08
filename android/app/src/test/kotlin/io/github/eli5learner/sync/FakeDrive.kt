package io.github.eli5learner.sync

import io.github.eli5learner.drive.ChangesPage
import io.github.eli5learner.drive.DriveApi
import io.github.eli5learner.drive.DriveChange
import io.github.eli5learner.drive.DriveFile
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import io.github.eli5learner.sync.protocol.Claim
import io.github.eli5learner.sync.protocol.DeviceRecord
import io.github.eli5learner.sync.protocol.DeviceRole
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.sync.protocol.LibraryManifest
import io.github.eli5learner.sync.protocol.ManifestDoc
import io.github.eli5learner.sync.protocol.ManifestFolder
import io.github.eli5learner.sync.protocol.Placement
import io.github.eli5learner.sync.protocol.Platform
import io.github.eli5learner.sync.protocol.RemoteVersionNode
import io.github.eli5learner.sync.protocol.SyncProtocol
import io.github.eli5learner.sync.protocol.VersionChangeKind
import io.github.eli5learner.sync.protocol.VersionTree
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.zip.GZIPOutputStream

/**
 * An in-memory app-data folder for sync tests: files with appProperties, a change log whose index is
 * the page token, expiring tokens (410), files that exist but are not listed yet (eventual
 * consistency), and a call log. Not thread-safe; tests drive it from one coroutine.
 */
class FakeDrive : DriveApi {
    class F(
        var meta: DriveFile,
        var body: ByteArray,
    )

    val files = LinkedHashMap<String, F>()
    private val log = mutableListOf<String>()

    /** Ids that exist but are not visible in listings or the change feed yet. */
    val hidden = mutableSetOf<String>()

    /** Tokens below this are expired (410). */
    var expiredBelow = 0

    /** Every call by name, for asserting what was (not) requested. */
    val calls = mutableListOf<String>()

    /** Thrown by the next call, once. */
    var failNext: SyncException? = null

    private var ids = 0
    private var tick = 0L

    fun newId(): String = "f${++ids}"

    private fun stamp(): String = Instant.ofEpochSecond(1_800_000_000 + tick++).toString()

    fun put(
        name: String,
        props: Map<String, String>,
        body: ByteArray,
        id: String = newId(),
        hide: Boolean = false,
    ): String {
        files[id] = F(DriveFile(id, name, props, sha256(body), body.size.toString(), stamp()), body)
        if (hide) hidden += id
        log += id
        return id
    }

    fun rewrite(
        id: String,
        body: ByteArray,
        props: Map<String, String> = emptyMap(),
    ) {
        val f = files.getValue(id)
        f.body = body
        f.meta = f.meta.copy(appProperties = f.meta.appProperties.orEmpty() + props, size = body.size.toString(), modifiedTime = stamp())
        log += id
    }

    fun remove(id: String) {
        files.remove(id)
        log += id
    }

    fun reveal(id: String) {
        hidden -= id
        log += id
    }

    fun byKind(kind: String): List<F> = files.values.filter { it.meta.appProperties?.get("k") == kind }

    private fun call(name: String) {
        calls += name
        failNext?.let {
            failNext = null
            throw it
        }
    }

    override suspend fun list(props: Map<String, String>): List<DriveFile> {
        call("list")
        return files.values.filter { it.meta.id !in hidden }.map { it.meta }.filter { f -> props.all { (k, v) -> f.appProperties?.get(k) == v } }
    }

    override suspend fun startPageToken(): String {
        call("startPageToken")
        return log.size.toString()
    }

    override suspend fun changes(token: String): ChangesPage {
        call("changes")
        val t = token.toInt()
        if (t < expiredBelow) throw SyncException(SyncErrorCode.E_SYNC_TOKEN, status = 410)
        val changes =
            log
                .drop(t)
                .distinct()
                .filter { it !in hidden }
                .map { id -> files[id]?.let { DriveChange(id, false, it.meta) } ?: DriveChange(id, true, null) }
        return ChangesPage(changes, log.size.toString())
    }

    override suspend fun download(fileId: String): ByteArray {
        call("download")
        return files[fileId]?.body ?: throw SyncException(SyncErrorCode.E_SYNC_NOT_FOUND, status = 404)
    }

    override suspend fun generateIds(count: Int): List<String> {
        call("generateIds")
        return List(count) { newId() }
    }

    override suspend fun create(
        id: String,
        name: String,
        appProperties: Map<String, String>,
        mime: String,
        body: ByteArray,
    ): DriveFile {
        call("create")
        files[id]?.let { return it.meta }
        put(name, appProperties, body, id)
        return files.getValue(id).meta
    }

    override suspend fun updateContent(
        fileId: String,
        body: ByteArray,
        mime: String,
    ): DriveFile {
        call("updateContent")
        if (fileId !in files) throw SyncException(SyncErrorCode.E_SYNC_NOT_FOUND, status = 404)
        rewrite(fileId, body)
        return files.getValue(fileId).meta
    }

    override suspend fun patchProperties(
        fileId: String,
        appProperties: Map<String, String>,
    ) {
        call("patchProperties")
        if (fileId !in files) throw SyncException(SyncErrorCode.E_SYNC_NOT_FOUND, status = 404)
        rewrite(fileId, files.getValue(fileId).body, appProperties)
    }

    companion object {
        fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

        fun gzip(b: ByteArray): ByteArray {
            val out = ByteArrayOutputStream()
            GZIPOutputStream(out).use { it.write(b) }
            return out.toByteArray()
        }
    }
}

/** One document as a test Mac publishes it. */
data class MacDoc(
    val docId: String,
    val title: String,
    val html: ByteArray,
    val updatedAt: String = "2026-11-01T10:00:00Z",
    val placement: Placement = Placement.Unfiled,
    val replaces: String? = null,
    val versionId: String = "v-000000000001",
) {
    val sha: String get() = FakeDrive.sha256(html)
}

/**
 * A stand-in for the primary desktop: writes `sync-info.json`, its claim and device file, then
 * blobs, trees and the manifest in that order (16 §4.5), through [drive] as the desktop engine would.
 */
class TestMac(
    private val drive: FakeDrive,
    val deviceId: String = MAC_ID,
    private val claimMs: Long = 1_000,
) {
    private var libId: String? = null
    private val treeIds = HashMap<String, String>()
    var deviceFileId: String? = null

    fun bootstrap(
        withInfo: Boolean = true,
        inbox: InboxState = InboxState.ON,
        seen: Long = 1_800_000_000,
    ): TestMac {
        if (withInfo && drive.byKind("info").isEmpty()) {
            drive.put("sync-info.json", mapOf("k" to "info", "dev" to deviceId), INFO.toByteArray())
        }
        drive.put(
            "claim-$claimMs-$deviceId.json",
            mapOf("k" to "claim", "dev" to deviceId, "n" to claimMs.toString()),
            SyncProtocol.encode(Claim.serializer(), Claim(deviceId, Instant.ofEpochMilli(claimMs).toString())).toByteArray(),
        )
        val record = DeviceRecord(1, deviceId, Platform.MACOS, "Studio", "1.0.0", DeviceRole.PRIMARY, listOf(JobKind.CAPTURE), inbox)
        deviceFileId =
            drive.put(
                "device-$deviceId.json",
                mapOf("k" to "device", "dev" to deviceId, "seen" to seen.toString()),
                SyncProtocol.encode(DeviceRecord.serializer(), record).toByteArray(),
            )
        return this
    }

    /** Uploads missing blobs, then trees, then the manifest at [seq]. Returns the blob file ids by docId. */
    fun publish(
        seq: Long,
        docs: List<MacDoc>,
        folders: List<ManifestFolder> = emptyList(),
        hideBlobs: Set<String> = emptySet(),
        skipBlobs: Set<String> = emptySet(),
    ): Map<String, String> {
        val blobs = HashMap<String, String>()
        for (d in docs) {
            if (d.docId in skipBlobs) continue
            val existing = drive.files.values.firstOrNull { it.meta.appProperties?.get("k") == "blob" && it.meta.appProperties?.get("d") == d.docId && it.meta.appProperties?.get("s") == d.sha }
            blobs[d.docId] = existing?.meta?.id
                ?: drive.put(
                    "blob-${d.sha}.html.gz",
                    mapOf("k" to "blob", "dev" to deviceId, "d" to d.docId, "s" to d.sha),
                    FakeDrive.gzip(d.html),
                    hide = d.docId in hideBlobs,
                )
        }
        for (d in docs) {
            val tree =
                VersionTree(
                    1,
                    d.docId,
                    seq,
                    d.versionId,
                    listOf(RemoteVersionNode(d.versionId, null, VersionChangeKind.INITIAL, "First version", d.updatedAt, d.sha, true)),
                )
            val body = SyncProtocol.encode(VersionTree.serializer(), tree).toByteArray()
            val props = mapOf("k" to "tree", "dev" to deviceId, "d" to d.docId, "n" to seq.toString())
            val id = treeIds[d.docId]
            if (id == null) treeIds[d.docId] = drive.put("tree-${d.docId}.json", props, body) else drive.rewrite(id, body, props)
        }
        writeLib(seq, manifest(seq, docs, folders))
        return blobs
    }

    fun manifest(
        seq: Long,
        docs: List<MacDoc>,
        folders: List<ManifestFolder> = emptyList(),
    ) = LibraryManifest(
        v = 1,
        seq = seq,
        generatedAt = "2026-11-01T10:00:00Z",
        folders = folders,
        docs =
            docs.map { d ->
                ManifestDoc(
                    docId = d.docId,
                    title = d.title,
                    summary = "About ${d.title}",
                    headings = listOf("Heading of ${d.title}"),
                    tabs = listOf("indepth", "eli5"),
                    createdAt = "2026-10-01T10:00:00Z",
                    updatedAt = d.updatedAt,
                    placement = d.placement,
                    currentVersionId = d.versionId,
                    currentSha = d.sha,
                    sizeBytes = d.html.size.toLong(),
                    busy = false,
                    replaces = d.replaces,
                )
            },
    )

    /** Writes the manifest file; [nProp] overrides the `n` property (a lying or missing `n`). */
    fun writeLib(
        seq: Long,
        m: LibraryManifest,
        nProp: Long? = seq,
    ) {
        val body = SyncProtocol.encode(LibraryManifest.serializer(), m).toByteArray()
        val props = mapOf("k" to "lib", "dev" to deviceId) + (nProp?.let { mapOf("n" to it.toString()) } ?: emptyMap())
        val id = libId
        if (id == null) libId = drive.put("lib-$deviceId.json", props, body) else drive.rewrite(id, body, props)
    }

    companion object {
        const val MAC_ID = "11111111-1111-4111-8111-111111111111"
        const val INFO = """{"formatVersion":1,"minReaderVersion":1,"minWriterVersion":1,"createdAt":"2026-11-01T10:00:00Z"}"""
    }
}
