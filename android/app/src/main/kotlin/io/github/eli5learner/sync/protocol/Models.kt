package io.github.eli5learner.sync.protocol

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PolymorphicKind
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.SerialKind
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.net.URI
import java.net.URISyntaxException

/*
 * The sync wire protocol (spec/tech/16-android-companion.md §4.2–§4.4, §5.1, §5.3): the Kotlin twin of
 * src/main/sync/protocol.ts. Both sides read the golden fixtures in test/contracts/sync/fixtures and
 * must accept every `*.valid.*` file and reject every `*.invalid.*` one (16 §12).
 *
 * Like the desktop's zod `.strict()` schemas, decoding is strict: unknown fields, a JSON type that
 * does not match (a quoted number, a numeric string), `null` for a field that is only optional, and
 * every pattern, limit and cross-field rule below are errors. Decode through [SyncProtocol] only; it
 * runs the type check and [Validated.validate] after kotlinx.serialization.
 */

/** A protocol file that failed to parse or validate. The message names the first problem. */
class ProtocolException(
    message: String,
    cause: Throwable? = null,
) : IllegalArgumentException(message, cause)

/**
 * Patterns shared with the desktop, character for character: FixturesTest compares each one with
 * test/contracts/sync/patterns.json, which `npm run gen:sync-schema` writes from protocol.ts.
 */
object Patterns {
    val DEVICE_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    val JOB_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    val DOC_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    val VERSION_ID = Regex("^v-[0-9a-f]{12}$")
    val FOLDER_ID = Regex("^f-[0-9a-f]{8}$")
    val TAB_KEY = Regex("^(indepth|eli5|sx[0-9a-f]{6})$")
    val SECTION_ID = Regex("^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$")
    val SHA256 = Regex("^[0-9a-f]{64}$")
    val ERROR_CODE = Regex("^E_[A-Z][A-Z0-9_]{0,39}$")
    val ATTACHMENT_NAME = Regex("^(?!\\.{1,2}$)[^\\u002f\\\\\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]+$")
    val ANCHOR_ID = Regex("^(?:q-[0-9a-f]{8}|sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8})$")
    val HTTP_URL = Regex("^[hH][tT][tT][pP][sS]?:\\/\\/[\\u0021-\\u007e]+$")
    val ONE_LINE = Regex("^[^\\r\\n\\u2028\\u2029]*$")

    /** What JavaScript's `String.prototype.trim` removes; Kotlin's `isBlank` uses a different set. */
    val BLANK = Regex("^[\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*$")

    /** zod 4 `z.iso.datetime()`: UTC (`Z`) only, seconds required, real calendar dates. */
    val TIMESTAMP =
        Regex(
            "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|" +
                "\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|" +
                "(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
        )

    /** zod 4 `z.regexes.hostname`, which `z.url()` applies to the URL's host. */
    val HOSTNAME =
        Regex(
            "^(?=.{1,253}\\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?" +
                "(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$",
        )
}

/** Limits both sides enforce (16 §4.4, §5.1). String lengths are in Unicode code points, as zod counts them. */
object Limits {
    const val URLS = 20
    const val URL_CHARS = 2048
    const val ATTACHMENT_NAME_CHARS = 200
    const val TEXT_CHARS = 20_000
    const val CLARIFYING_INPUT_CHARS = 500
    const val ATTACHMENTS = 10
    const val ATTACHMENT_BYTES = 20L * 1024 * 1024
    const val JOB_ATTACHMENT_BYTES = 50L * 1024 * 1024
    const val QUESTION_MIN_CHARS = 3
    const val QUESTION_MAX_CHARS = 500
    const val TREE_NODES = 300
    const val MANIFEST_DOCS = 10_000
    const val MANIFEST_FOLDERS = 500
    const val ACKED_JOBS = 10_000
}

/** The image, PDF, Office, HTML and plain-text types the desktop resolvers accept (03 §5.2). */
val ATTACHMENT_MIME_TYPES: Set<String> =
    setOf(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/pdf",
        "text/markdown",
        "text/plain",
        "text/csv",
        "text/html",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/heic",
        "image/tiff",
        "image/bmp",
    )

/** JavaScript's `Number.MAX_SAFE_INTEGER`: zod's `.int()` rejects anything larger. */
const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

const val PROTOCOL_VERSION = 1
const val SYNC_FORMAT_VERSION = 1

/** A decoded protocol file that checks its own patterns, limits and cross-field rules. */
interface Validated {
    fun validate(c: Checker)
}

/** Collects the first failed rule as a [ProtocolException]. */
class Checker internal constructor() {
    fun check(
        ok: Boolean,
        path: String,
        message: String,
    ) {
        if (!ok) throw ProtocolException("$path: $message")
    }

    fun pattern(
        value: String,
        regex: Regex,
        path: String,
    ) = check(regex.matches(value), path, "does not match ${regex.pattern}")

    fun length(
        value: String,
        min: Int,
        max: Int,
        path: String,
    ) = check(value.codePointCount(0, value.length) in min..max, path, "length must be $min..$max code points")

    /** A JSON integer that JavaScript reads exactly, as zod's `.int()` requires. */
    fun safeInt(
        value: Long,
        min: Long,
        path: String,
    ) = check(value in min..MAX_SAFE_INTEGER, path, "must be $min..$MAX_SAFE_INTEGER")

    fun timestamp(
        value: String,
        path: String,
    ) = pattern(value, Patterns.TIMESTAMP, path)

    fun size(
        list: List<*>,
        min: Int,
        max: Int,
        path: String,
    ) = check(list.size in min..max, path, "must have $min..$max items")

    fun <T> unique(
        values: List<T>,
        path: String,
    ) {
        val seen = HashSet<T>()
        values.forEachIndexed { i, v -> check(seen.add(v), "$path[$i]", "duplicate") }
    }

    fun version(v: Int) = check(v == PROTOCOL_VERSION, "v", "must be $PROTOCOL_VERSION")
}

// ------------------------------------------------------------------------------------ store files

/** `sync-info.json` (16 §4.2): written once by the first desktop. */
@Serializable
data class SyncInfo(
    val formatVersion: Int,
    val minReaderVersion: Int,
    val minWriterVersion: Int,
    val createdAt: String,
) : Validated {
    override fun validate(c: Checker) {
        c.check(formatVersion >= 1, "formatVersion", "must be >= 1")
        c.check(minReaderVersion >= 1, "minReaderVersion", "must be >= 1")
        c.check(minWriterVersion >= 1, "minWriterVersion", "must be >= 1")
        c.timestamp(createdAt, "createdAt")
    }
}

/** `claim-<ms>-<deviceId>.json` (16 §4.6): immutable; the newest claim names the primary. */
@Serializable
data class Claim(
    val deviceId: String,
    val claimedAt: String,
) : Validated {
    override fun validate(c: Checker) {
        c.pattern(deviceId, Patterns.DEVICE_ID, "deviceId")
        c.timestamp(claimedAt, "claimedAt")
    }
}

@Serializable
enum class Platform {
    @SerialName("macos")
    MACOS,

    @SerialName("android")
    ANDROID,
}

@Serializable
enum class DeviceRole {
    @SerialName("primary")
    PRIMARY,

    @SerialName("mirror")
    MIRROR,

    @SerialName("phone")
    PHONE,
}

@Serializable
enum class JobKind {
    @SerialName("capture")
    CAPTURE,

    @SerialName("checkout")
    CHECKOUT,

    @SerialName("ask")
    ASK,
}

@Serializable
enum class InboxState {
    @SerialName("on")
    ON,

    @SerialName("off")
    OFF,

    @SerialName("paused-read-only")
    PAUSED_READ_ONLY,
}

/** `device-<deviceId>.json` (16 §4.3). The heartbeat (`seen`) lives in appProperties, not here. */
@Serializable
data class DeviceRecord(
    val v: Int,
    val deviceId: String,
    val platform: Platform,
    val name: String,
    val appVersion: String,
    val role: DeviceRole,
    /** Desktop only: the job kinds it runs today. A phone writes an empty list. */
    val accepts: List<JobKind>,
    /** Desktop only. A phone writes `off`. */
    val inbox: InboxState,
) : Validated {
    override fun validate(c: Checker) {
        c.version(v)
        c.pattern(deviceId, Patterns.DEVICE_ID, "deviceId")
        c.length(name, 1, 100, "name")
        c.length(appVersion, 1, 40, "appVersion")
        c.size(accepts, 0, JobKind.entries.size, "accepts")
        c.unique(accepts, "accepts")
        val phone = platform == Platform.ANDROID
        c.check(phone == (role == DeviceRole.PHONE), "role", "role phone goes with platform android only")
        c.check(!phone || (accepts.isEmpty() && inbox == InboxState.OFF), "accepts", "a phone accepts no jobs and has no inbox")
    }
}

/** Where a document sits in the desktop library (09 §4.2). */
@Serializable
sealed interface Placement {
    @Serializable
    @SerialName("folder")
    data class Folder(
        val folderId: String,
    ) : Placement

    @Serializable
    @SerialName("unfiled")
    data object Unfiled : Placement

    @Serializable
    @SerialName("archive")
    data object Archive : Placement

    @Serializable
    @SerialName("trash")
    data object Trash : Placement
}

@Serializable
data class ManifestFolder(
    val id: String,
    val name: String,
)

@Serializable
data class ManifestDoc(
    val docId: String,
    val title: String,
    val summary: String,
    val headings: List<String>,
    val tabs: List<String>,
    val createdAt: String,
    val updatedAt: String,
    val placement: Placement,
    val currentVersionId: String,
    val currentSha: String,
    val sizeBytes: Long,
    val busy: Boolean,
    /** The old docId when an id was re-minted (09 §7 step 4, Put Back). */
    val replaces: String? = null,
)

/** `lib-<deviceId>.json` (16 §4.4): the sanitized library manifest, written by the primary only. */
@Serializable
data class LibraryManifest(
    val v: Int,
    val seq: Long,
    val generatedAt: String,
    val folders: List<ManifestFolder>,
    val docs: List<ManifestDoc>,
) : Validated {
    override fun validate(c: Checker) {
        c.version(v)
        c.safeInt(seq, 1, "seq")
        c.timestamp(generatedAt, "generatedAt")
        c.size(folders, 0, Limits.MANIFEST_FOLDERS, "folders")
        c.size(docs, 0, Limits.MANIFEST_DOCS, "docs")
        folders.forEachIndexed { i, f ->
            c.pattern(f.id, Patterns.FOLDER_ID, "folders[$i].id")
            c.length(f.name, 1, 60, "folders[$i].name")
        }
        c.unique(folders.map { it.id }, "folders")
        c.unique(docs.map { it.docId }, "docs")
        val folderIds = folders.mapTo(HashSet()) { it.id }
        docs.forEachIndexed { i, d ->
            val p = "docs[$i]"
            c.pattern(d.docId, Patterns.DOC_ID, "$p.docId")
            c.length(d.title, 1, 200, "$p.title")
            c.length(d.summary, 0, 300, "$p.summary")
            c.size(d.headings, 0, 200, "$p.headings")
            d.headings.forEachIndexed { j, h -> c.length(h, 0, 200, "$p.headings[$j]") }
            c.size(d.tabs, 1, 20, "$p.tabs")
            d.tabs.forEachIndexed { j, t -> c.pattern(t, Patterns.TAB_KEY, "$p.tabs[$j]") }
            c.timestamp(d.createdAt, "$p.createdAt")
            c.timestamp(d.updatedAt, "$p.updatedAt")
            val placement = d.placement
            if (placement is Placement.Folder) {
                c.pattern(placement.folderId, Patterns.FOLDER_ID, "$p.placement.folderId")
                c.check(placement.folderId in folderIds, "$p.placement.folderId", "unknown folder")
            }
            c.pattern(d.currentVersionId, Patterns.VERSION_ID, "$p.currentVersionId")
            c.pattern(d.currentSha, Patterns.SHA256, "$p.currentSha")
            c.safeInt(d.sizeBytes, 0, "$p.sizeBytes")
            d.replaces?.let {
                c.pattern(it, Patterns.DOC_ID, "$p.replaces")
                c.check(it != d.docId, "$p.replaces", "a document cannot replace itself")
            }
        }
    }
}

/** 09 §4.1 version change kinds (`VersionChangeKind` on the desktop). */
@Serializable
enum class VersionChangeKind {
    @SerialName("expand")
    EXPAND,

    @SerialName("reexplain")
    REEXPLAIN,

    @SerialName("analogy")
    ANALOGY,

    @SerialName("deeper")
    DEEPER,

    @SerialName("revise")
    REVISE,

    @SerialName("eli5-tab")
    ELI5_TAB,

    @SerialName("eli5-selection")
    ELI5_SELECTION,

    @SerialName("ask")
    ASK,

    @SerialName("close-tab")
    CLOSE_TAB,

    @SerialName("merge")
    MERGE,

    @SerialName("outside")
    OUTSIDE,

    @SerialName("initial")
    INITIAL,

    /** Reserved for a later desktop pull (16 §8); never written in this version. */
    @SerialName("sync")
    SYNC,
}

@Serializable
data class RemoteVersionNode(
    val id: String,
    val parentId: String?,
    val kind: VersionChangeKind,
    val label: String,
    val createdAt: String,
    /** Null when the snapshot was pruned on the desktop. */
    val sha: String?,
    /** True when `blob-<sha>.html.gz` is in the store. */
    val uploaded: Boolean,
)

/** `tree-<docId>.json` (16 §4.4): one document's sanitized version tree, written by the primary only. */
@Serializable
data class VersionTree(
    val v: Int,
    val docId: String,
    val seq: Long,
    val currentId: String,
    val nodes: List<RemoteVersionNode>,
) : Validated {
    override fun validate(c: Checker) {
        c.version(v)
        c.pattern(docId, Patterns.DOC_ID, "docId")
        c.safeInt(seq, 1, "seq")
        c.pattern(currentId, Patterns.VERSION_ID, "currentId")
        c.size(nodes, 1, Limits.TREE_NODES, "nodes")
        nodes.forEachIndexed { i, n ->
            val p = "nodes[$i]"
            c.pattern(n.id, Patterns.VERSION_ID, "$p.id")
            n.parentId?.let { c.pattern(it, Patterns.VERSION_ID, "$p.parentId") }
            c.length(n.label, 1, 200, "$p.label")
            c.timestamp(n.createdAt, "$p.createdAt")
            n.sha?.let { c.pattern(it, Patterns.SHA256, "$p.sha") }
            c.check(!n.uploaded || n.sha != null, "$p.uploaded", "an uploaded node needs a sha")
        }
        c.unique(nodes.map { it.id }, "nodes")
        c.check(nodes.any { it.id == currentId }, "currentId", "is not a node")
    }
}

// ------------------------------------------------------------------------------------------- jobs

@Serializable
enum class FocusChip {
    @SerialName("big-picture")
    BIG_PICTURE,

    @SerialName("how-it-works")
    HOW_IT_WORKS,

    @SerialName("numbers")
    NUMBERS,

    @SerialName("beginner")
    BEGINNER,
}

@Serializable
data class Attachment(
    val sha: String,
    val name: String,
    val mime: String,
    val size: Long,
)

/** `job-<jobId>.json` (16 §5.1): immutable, written by the phone. */
@Serializable
sealed interface JobRequest : Validated {
    val v: Int
    val jobId: String
    val deviceId: String
    val createdAt: String

    @Serializable
    @SerialName("capture")
    data class Capture(
        override val v: Int,
        override val jobId: String,
        override val deviceId: String,
        override val createdAt: String,
        val urls: List<String>,
        val text: String,
        val clarifyingInput: String,
        val focus: List<FocusChip>,
        val attachments: List<Attachment>,
    ) : JobRequest {
        override fun validate(c: Checker) {
            validateBase(c)
            c.size(urls, 0, Limits.URLS, "urls")
            urls.forEachIndexed { i, u -> c.check(isHttpUrl(u), "urls[$i]", "must be an http(s) URL") }
            c.length(text, 0, Limits.TEXT_CHARS, "text")
            c.length(clarifyingInput, 0, Limits.CLARIFYING_INPUT_CHARS, "clarifyingInput")
            c.size(focus, 0, FocusChip.entries.size, "focus")
            c.unique(focus, "focus")
            c.size(attachments, 0, Limits.ATTACHMENTS, "attachments")
            attachments.forEachIndexed { i, a ->
                val p = "attachments[$i]"
                c.pattern(a.sha, Patterns.SHA256, "$p.sha")
                c.length(a.name, 1, Limits.ATTACHMENT_NAME_CHARS, "$p.name")
                c.pattern(a.name, Patterns.ATTACHMENT_NAME, "$p.name")
                c.check(a.mime in ATTACHMENT_MIME_TYPES, "$p.mime", "type not accepted")
                c.check(a.size in 1..Limits.ATTACHMENT_BYTES, "$p.size", "must be 1..${Limits.ATTACHMENT_BYTES}")
            }
            c.unique(attachments.map { it.sha }, "attachments")
            c.check(attachments.sumOf { it.size } <= Limits.JOB_ATTACHMENT_BYTES, "attachments", "exceed 50 MiB per job")
            c.check(
                urls.isNotEmpty() || !Patterns.BLANK.matches(text) || attachments.isNotEmpty(),
                "urls",
                "a capture needs a URL, text or an attachment",
            )
        }
    }

    @Serializable
    @SerialName("checkout")
    data class Checkout(
        override val v: Int,
        override val jobId: String,
        override val deviceId: String,
        override val createdAt: String,
        val docId: String,
        val versionId: String,
    ) : JobRequest {
        override fun validate(c: Checker) {
            validateBase(c)
            c.pattern(docId, Patterns.DOC_ID, "docId")
            c.pattern(versionId, Patterns.VERSION_ID, "versionId")
        }
    }

    @Serializable
    @SerialName("ask")
    data class Ask(
        override val v: Int,
        override val jobId: String,
        override val deviceId: String,
        override val createdAt: String,
        val docId: String,
        val sectionId: String,
        val sectionHash: String,
        val question: String,
    ) : JobRequest {
        override fun validate(c: Checker) {
            validateBase(c)
            c.pattern(docId, Patterns.DOC_ID, "docId")
            c.pattern(sectionId, Patterns.SECTION_ID, "sectionId")
            c.pattern(sectionHash, Patterns.SHA256, "sectionHash")
            c.length(question, Limits.QUESTION_MIN_CHARS, Limits.QUESTION_MAX_CHARS, "question")
            c.pattern(question, Patterns.ONE_LINE, "question")
        }
    }
}

private fun JobRequest.validateBase(c: Checker) {
    c.version(v)
    c.pattern(jobId, Patterns.JOB_ID, "jobId")
    c.pattern(deviceId, Patterns.DEVICE_ID, "deviceId")
    c.timestamp(createdAt, "createdAt")
}

/**
 * A job URL as the desktop's `isJobUrl` checks it: the raw text already in the ASCII shape of
 * [Patterns.HTTP_URL], an absolute http(s) URL with a DNS-style host, a valid port and no user
 * name or password. `java.net.URI` is stricter than the WHATWG parser on the desktop (it refuses
 * `|`, `{` and the like), so the phone percent-encodes and IDNA-encodes shared URLs before
 * writing a job; whatever passes here also passes on the desktop.
 */
fun isHttpUrl(s: String): Boolean {
    if (s.codePointCount(0, s.length) > Limits.URL_CHARS || !Patterns.HTTP_URL.matches(s)) return false
    val uri =
        try {
            URI(s)
        } catch (_: URISyntaxException) {
            return false
        }
    val scheme = uri.scheme?.lowercase() ?: return false
    if (scheme != "http" && scheme != "https") return false
    if (uri.rawUserInfo != null) return false
    if (uri.port > 65_535) return false
    val host = uri.host ?: return false
    return Patterns.HOSTNAME.matches(host)
}

/** `jobcancel-<jobId>.json` (16 §4.2, §5.2): immutable, written by the phone. */
@Serializable
data class JobCancel(
    val jobId: String,
    val at: String,
) : Validated {
    override fun validate(c: Checker) {
        c.pattern(jobId, Patterns.JOB_ID, "jobId")
        c.timestamp(at, "at")
    }
}

@Serializable
enum class JobState {
    @SerialName("received")
    RECEIVED,

    @SerialName("queued")
    QUEUED,

    @SerialName("running")
    RUNNING,

    @SerialName("done")
    DONE,

    @SerialName("failed")
    FAILED,

    @SerialName("rejected")
    REJECTED,

    @SerialName("cancelled")
    CANCELLED,
    ;

    val terminal: Boolean get() = this == DONE || this == FAILED || this == REJECTED || this == CANCELLED
}

/** `jobstatus-<jobId>.json` (16 §5.3): rewritten by the primary. */
@Serializable
data class JobStatus(
    val v: Int,
    val jobId: String,
    val updatedAt: String,
    val state: JobState,
    /** The 06 §6 one-line status. */
    val stage: String? = null,
    val docId: String? = null,
    val versionId: String? = null,
    val skippedSources: Long? = null,
    val anchorId: String? = null,
    val code: String? = null,
    /** The user-facing one-liner. */
    val reason: String? = null,
) : Validated {
    override fun validate(c: Checker) {
        c.version(v)
        c.pattern(jobId, Patterns.JOB_ID, "jobId")
        c.timestamp(updatedAt, "updatedAt")
        stage?.let {
            c.length(it, 0, 200, "stage")
            c.pattern(it, Patterns.ONE_LINE, "stage")
        }
        docId?.let { c.pattern(it, Patterns.DOC_ID, "docId") }
        versionId?.let { c.pattern(it, Patterns.VERSION_ID, "versionId") }
        skippedSources?.let { c.safeInt(it, 0, "skippedSources") }
        anchorId?.let { c.pattern(it, Patterns.ANCHOR_ID, "anchorId") }
        code?.let { c.pattern(it, Patterns.ERROR_CODE, "code") }
        reason?.let {
            c.length(it, 0, 300, "reason")
            c.pattern(it, Patterns.ONE_LINE, "reason")
        }
        val failed = state == JobState.FAILED || state == JobState.REJECTED
        c.check(!failed || (code != null && reason != null), "code", "failed and rejected need a code and a reason")
        c.check(failed || code == null, "code", "only failed and rejected carry a code")
        c.check(state != JobState.DONE || docId != null, "docId", "done needs a docId")
    }
}

/** `acks-<deviceId>.json` (16 §4.7): terminal job ids this phone has shown. */
@Serializable
data class Acks(
    val terminalJobIds: List<String>,
) : Validated {
    override fun validate(c: Checker) {
        c.size(terminalJobIds, 0, Limits.ACKED_JOBS, "terminalJobIds")
        terminalJobIds.forEachIndexed { i, id -> c.pattern(id, Patterns.JOB_ID, "terminalJobIds[$i]") }
        c.unique(terminalJobIds, "terminalJobIds")
    }
}

// -------------------------------------------------------------------------------------- decoding

/** Every protocol file type by its fixture prefix (`<type>.valid.<name>.json`). */
enum class SyncFileType(
    val id: String,
    val serializer: KSerializer<out Validated>,
) {
    SYNC_INFO("sync-info", SyncInfo.serializer()),
    CLAIM("claim", Claim.serializer()),
    DEVICE("device", DeviceRecord.serializer()),
    MANIFEST("manifest", LibraryManifest.serializer()),
    TREE("tree", VersionTree.serializer()),
    JOB("job", JobRequest.serializer()),
    JOB_CANCEL("jobcancel", JobCancel.serializer()),
    JOB_STATUS("jobstatus", JobStatus.serializer()),
    ACKS("acks", Acks.serializer()),
    ;

    companion object {
        fun of(id: String): SyncFileType = entries.firstOrNull { it.id == id } ?: throw IllegalArgumentException("unknown type $id")
    }
}

/** Strict decoding and encoding of protocol files. */
object SyncProtocol {
    private const val DISCRIMINATOR = "kind"

    /** Both sealed hierarchies ([Placement], [JobRequest]) use `kind`, as on the desktop. */
    val json: Json =
        Json {
            classDiscriminator = DISCRIMINATOR
            ignoreUnknownKeys = false
            isLenient = false
            coerceInputValues = false
            // A missing nullable field without a default stays an error (`parentId`), and an optional
            // field left at its null default is omitted on encode rather than written as `null`.
            explicitNulls = true
            encodeDefaults = false
        }

    fun <T : Validated> decode(
        deserializer: DeserializationStrategy<T>,
        text: String,
    ): T {
        val element =
            try {
                json.parseToJsonElement(text)
            } catch (e: SerializationException) {
                throw ProtocolException("not JSON: ${e.message}", e)
            }
        checkTypes(element, deserializer.descriptor, "$")
        val value =
            try {
                json.decodeFromJsonElement(deserializer, element)
            } catch (e: SerializationException) {
                throw ProtocolException(e.message ?: "invalid", e)
            } catch (e: IllegalArgumentException) {
                throw ProtocolException(e.message ?: "invalid", e)
            }
        value.validate(Checker())
        return value
    }

    fun decode(
        type: SyncFileType,
        text: String,
    ): Validated = decode(type.serializer, text)

    fun decodeSyncInfo(text: String): SyncInfo = decode(SyncInfo.serializer(), text)

    fun decodeClaim(text: String): Claim = decode(Claim.serializer(), text)

    fun decodeDevice(text: String): DeviceRecord = decode(DeviceRecord.serializer(), text)

    fun decodeManifest(text: String): LibraryManifest = decode(LibraryManifest.serializer(), text)

    fun decodeTree(text: String): VersionTree = decode(VersionTree.serializer(), text)

    fun decodeJob(text: String): JobRequest = decode(JobRequest.serializer(), text)

    fun decodeJobCancel(text: String): JobCancel = decode(JobCancel.serializer(), text)

    fun decodeJobStatus(text: String): JobStatus = decode(JobStatus.serializer(), text)

    fun decodeAcks(text: String): Acks = decode(Acks.serializer(), text)

    /**
     * Encodes a file this device writes, after checking it against the same rules a reader applies.
     * A job must go through `JobRequest.serializer()`: a variant's own serializer would leave out
     * the `kind` discriminator, and the desktop would reject the file.
     */
    @OptIn(ExperimentalSerializationApi::class)
    fun <T : Validated> encode(
        serializer: KSerializer<T>,
        value: T,
    ): String {
        if (value is JobRequest && serializer.descriptor.kind != PolymorphicKind.SEALED) {
            throw ProtocolException("encode a job with JobRequest.serializer()")
        }
        value.validate(Checker())
        return json.encodeToString(serializer, value)
    }

    /**
     * The JSON-level half of strictness that kotlinx.serialization leaves out: every value has the
     * JSON type its field declares (no quoted numbers, no numeric strings), `null` only where the
     * field is required and nullable, and no key the class does not declare (including on data objects).
     */
    @OptIn(ExperimentalSerializationApi::class)
    private fun checkTypes(
        e: JsonElement,
        d: SerialDescriptor,
        path: String,
    ) {
        fun fail(message: String): Nothing = throw ProtocolException("$path: $message")
        if (e is JsonNull) {
            if (d.isNullable) return
            fail("must not be null")
        }
        when (val kind: SerialKind = d.kind) {
            PrimitiveKind.STRING, SerialKind.ENUM -> {
                if (e !is JsonPrimitive || !e.isString) fail("must be a string")
            }
            PrimitiveKind.BOOLEAN -> {
                if (e !is JsonPrimitive || e.isString || e.booleanOrNull == null) fail("must be a boolean")
            }
            PrimitiveKind.INT, PrimitiveKind.LONG, PrimitiveKind.SHORT, PrimitiveKind.BYTE -> {
                if (e !is JsonPrimitive || e.isString || !INTEGER.matches(e.content)) fail("must be an integer")
            }
            PrimitiveKind.FLOAT, PrimitiveKind.DOUBLE -> {
                if (e !is JsonPrimitive || e.isString || e.content.toDoubleOrNull() == null) fail("must be a number")
            }
            StructureKind.LIST -> {
                if (e !is JsonArray) fail("must be an array")
                val item = d.getElementDescriptor(0)
                e.forEachIndexed { i, x -> checkTypes(x, item, "$path[$i]") }
            }
            StructureKind.CLASS, StructureKind.OBJECT -> checkObject(e, d, path, discriminator = null)
            PolymorphicKind.SEALED -> {
                if (e !is JsonObject) fail("must be an object")
                val tag = (e[DISCRIMINATOR] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail("missing $DISCRIMINATOR")
                val subclasses = d.getElementDescriptor(1)
                val sub =
                    (0 until subclasses.elementsCount)
                        .firstOrNull { subclasses.getElementName(it) == tag }
                        ?.let { subclasses.getElementDescriptor(it) }
                        ?: fail("unknown $DISCRIMINATOR '$tag'")
                checkObject(e, sub, path, discriminator = DISCRIMINATOR)
            }
            else -> fail("unsupported field kind $kind")
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun checkObject(
        e: JsonElement,
        d: SerialDescriptor,
        path: String,
        discriminator: String?,
    ) {
        if (e !is JsonObject) throw ProtocolException("$path: must be an object")
        for ((key, value) in e) {
            if (key == discriminator) continue
            val i = d.getElementIndex(key)
            if (i < 0) throw ProtocolException("$path.$key: unknown field")
            // An optional field (zod `.optional()`) is omitted, never null; only a required nullable
            // field (zod `.nullable()`, e.g. `parentId`) may hold null.
            if (value is JsonNull && d.isElementOptional(i)) throw ProtocolException("$path.$key: omit it instead of null")
            checkTypes(value, d.getElementDescriptor(i), "$path.$key")
        }
    }

    private val INTEGER = Regex("^-?(0|[1-9]\\d*)$")
}
