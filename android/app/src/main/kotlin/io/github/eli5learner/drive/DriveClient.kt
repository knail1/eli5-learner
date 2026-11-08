package io.github.eli5learner.drive

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Where the phone gets bearer tokens (16 §3.3). [io.github.eli5learner.auth.GoogleAuthorizer]
 * implements it; tests use a fake.
 */
interface AccessTokenSource {
    /** A current access token. Throws [SyncException] `E_SYNC_AUTH` when there is no grant. */
    suspend fun accessToken(): String

    /** Drive refused [token] (HTTP 401): clear it so the next [accessToken] fetches a fresh one. */
    suspend fun invalidate(token: String)

    /** A freshly fetched token was refused too: the grant is gone (`NeedsReconnect`). */
    suspend fun authFailed()
}

/** A resumable session remembered across process restarts (16 §4.5 step 4). */
data class ResumableSession(
    val uri: String,
    val startedAt: Long,
    val size: Long,
    val sha256: String,
)

interface ResumableSessionStore {
    suspend fun get(key: String): ResumableSession?

    suspend fun set(
        key: String,
        session: ResumableSession,
    )

    suspend fun delete(key: String)
}

/** The REST roots; tests point them at a MockWebServer. */
data class DriveEndpoints(
    val api: String = "https://www.googleapis.com/drive/v3",
    val upload: String = "https://www.googleapis.com/upload/drive/v3",
    val userInfo: String = "https://openidconnect.googleapis.com/v1/userinfo",
)

/**
 * Google Drive REST v3 client for the hidden app-data folder, the Kotlin twin of the desktop's
 * `src/main/sync/google/drive.ts` (16 §4.5, §4.8). OkHttp + kotlinx.serialization, no Google client
 * library. Bearer tokens come from [AccessTokenSource]; one refresh on 401 (clearToken, then authorize
 * again), then `E_SYNC_AUTH`. Transient failures back off with [Backoff]. Bodies up to
 * [multipartMaxBytes] go in one multipart request, larger ones in a resumable session in
 * [chunkBytes] chunks (a multiple of 256 KiB). Nothing here logs names, bodies or tokens (16 §9).
 */
class DriveClient(
    http: OkHttpClient,
    private val auth: AccessTokenSource,
    private val endpoints: DriveEndpoints = DriveEndpoints(),
    private val backoff: Backoff = Backoff(),
    private val sessions: ResumableSessionStore? = null,
    private val multipartMaxBytes: Int = MULTIPART_MAX_BYTES,
    private val chunkBytes: Int = RESUMABLE_CHUNK_BYTES,
    private val now: () -> Long = System::currentTimeMillis,
) {
    init {
        require(chunkBytes > 0 && chunkBytes % RESUMABLE_QUANTUM == 0) { "chunkBytes must be a multiple of 256 KiB" }
        require(multipartMaxBytes >= 0) { "multipartMaxBytes must not be negative" }
    }

    // A resumable "308 Resume Incomplete" has no Location and must reach the client as-is; Drive never
    // redirects otherwise. Each call has a deadline so a hung connection cannot stall a sync.
    private val http: OkHttpClient =
        http
            .newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .callTimeout(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()

    private val apiRoot = endpoints.api.toHttpUrl()
    private val uploadRoot = endpoints.upload.toHttpUrl()

    // ------------------------------------------------------------------------------ transport

    private class Spec(
        val method: String,
        val url: HttpUrl,
        val body: RequestBody? = null,
        val headers: Map<String, String> = emptyMap(),
        /** Statuses handed back to the caller instead of being treated as errors. */
        val accept: Set<Int> = emptySet(),
        val timeoutMs: Long? = null,
        /**
         * Whether [send] retries network errors and transient statuses itself. Resumable chunks pass
         * false: after a lost chunk the session must be asked where it stands before resending.
         */
        val retry: Boolean = true,
    )

    /**
     * One authorized request with retries. Returns the response (the caller closes it) for 2xx and
     * [Spec.accept]ed statuses; maps everything else to a [SyncException].
     */
    private suspend fun send(spec: Spec): Response {
        var refreshed = false
        var attempt = 0
        while (true) {
            val token = auth.accessToken()
            val builder = Request.Builder().url(spec.url).header("Authorization", "Bearer $token")
            spec.headers.forEach { (k, v) -> builder.header(k, v) }
            builder.method(spec.method, spec.body ?: if (spec.method in BODY_METHODS) EMPTY_BODY else null)
            val call = http.newCall(builder.build())
            spec.timeoutMs?.let { call.timeout().timeout(it, TimeUnit.MILLISECONDS) }
            val res =
                try {
                    call.await()
                } catch (_: IOException) {
                    if (!spec.retry || !backoff.canRetry(attempt)) throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Network error")
                    backoff.pause(attempt)
                    attempt++
                    continue
                }
            if (res.isSuccessful || res.code in spec.accept) return res

            val status = res.code
            if (status == 401) {
                res.close()
                auth.invalidate(token)
                if (refreshed) {
                    auth.authFailed()
                    throw SyncException(SyncErrorCode.E_SYNC_AUTH, status = 401)
                }
                refreshed = true // a token refresh is not a backoff attempt
                continue
            }
            val reason = errorReason(res)
            if (spec.retry && Backoff.isRetryable(status, reason) && backoff.canRetry(attempt)) {
                backoff.pause(attempt)
                attempt++
                continue
            }
            throw when {
                reason in QUOTA_REASONS -> SyncException(SyncErrorCode.E_SYNC_QUOTA, status = status)
                status == 404 -> SyncException(SyncErrorCode.E_SYNC_NOT_FOUND, "Remote file not found", status)
                status == 410 -> SyncException(SyncErrorCode.E_SYNC_TOKEN, "Change token expired", status)
                else -> SyncException(SyncErrorCode.E_SYNC_HTTP, "Drive request failed ($status)", status)
            }
        }
    }

    private suspend fun bytesOf(res: Response): ByteArray =
        withContext(Dispatchers.IO) {
            try {
                res.use { it.body.bytes() }
            } catch (_: IOException) {
                throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Drive response could not be read")
            }
        }

    private suspend inline fun <reified T> json(spec: Spec): T = decode(bytesOf(send(spec)))

    private inline fun <reified T> decode(bytes: ByteArray): T =
        try {
            DriveJson.decodeFromString<T>(bytes.decodeToString())
        } catch (_: SerializationException) {
            throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Drive response could not be read")
        } catch (_: IllegalArgumentException) {
            throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Drive response could not be read")
        }

    /** The first `error.errors[].reason`, or a string `error` (OAuth style), from an error body. */
    private suspend fun errorReason(res: Response): String? {
        val bytes = runCatching { bytesOf(res) }.getOrNull() ?: return null
        return runCatching {
            val error = DriveJson.parseToJsonElement(bytes.decodeToString()).jsonObject["error"]
            when (error) {
                is JsonPrimitive -> error.content
                is JsonObject ->
                    error["errors"]
                        ?.jsonArray
                        ?.firstOrNull()
                        ?.jsonObject
                        ?.get("reason")
                        ?.jsonPrimitive
                        ?.content
                else -> null
            }
        }.getOrNull()
    }

    private fun api(vararg segments: String): HttpUrl.Builder = apiRoot.newBuilder().apply { segments.forEach { addPathSegment(it) } }

    private fun upload(vararg segments: String): HttpUrl.Builder = uploadRoot.newBuilder().apply { segments.forEach { addPathSegment(it) } }

    // -------------------------------------------------------------------------------- reading

    /** `files.list` in the app-data folder, filtered by `appProperties`, following every page. */
    suspend fun list(props: Map<String, String> = emptyMap()): List<DriveFile> {
        val out = mutableListOf<DriveFile>()
        var pageToken: String? = null
        repeat(MAX_PAGES) {
            val url =
                api("files")
                    .addQueryParameter("spaces", APP_DATA_FOLDER)
                    .addQueryParameter("pageSize", "1000")
                    .addQueryParameter("q", buildListQuery(props))
                    .addQueryParameter("fields", "nextPageToken,files($FILE_FIELDS)")
                    .apply { pageToken?.let { addQueryParameter("pageToken", it) } }
                    .build()
            val r = json<FileListResponse>(Spec("GET", url))
            out += r.files
            pageToken = r.nextPageToken ?: return out
        }
        throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Too many list pages")
    }

    suspend fun startPageToken(): String {
        val r = json<StartPageTokenResponse>(Spec("GET", api("changes", "startPageToken").build()))
        return r.startPageToken ?: throw SyncException(SyncErrorCode.E_SYNC_HTTP, "No start page token")
    }

    /** `changes.list` to the end (16 §4.8). Throws `E_SYNC_TOKEN` on 410 or an invalid token. */
    suspend fun changes(token: String): ChangesPage {
        val out = mutableListOf<DriveChange>()
        var pageToken = token
        repeat(MAX_PAGES) {
            val url =
                api("changes")
                    .addQueryParameter("pageToken", pageToken)
                    .addQueryParameter("spaces", APP_DATA_FOLDER)
                    .addQueryParameter("includeRemoved", "true")
                    .addQueryParameter("pageSize", "1000")
                    .addQueryParameter("fields", "nextPageToken,newStartPageToken,changes(fileId,removed,file($FILE_FIELDS))")
                    .build()
            val r =
                try {
                    json<ChangeListResponse>(Spec("GET", url))
                } catch (e: SyncException) {
                    // Drive answers an unknown or malformed page token with 400 "invalid".
                    if (e.status == 400) throw SyncException(SyncErrorCode.E_SYNC_TOKEN, "Invalid change token", 400)
                    throw e
                }
            out += r.changes
            r.newStartPageToken?.let { return ChangesPage(out, it) }
            pageToken = r.nextPageToken ?: throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Change list ended without a token")
        }
        throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Too many change pages")
    }

    suspend fun metadata(fileId: String): DriveFile = json(Spec("GET", api("files", fileId).addQueryParameter("fields", FILE_FIELDS).build()))

    suspend fun download(fileId: String): ByteArray = bytesOf(send(Spec("GET", api("files", fileId).addQueryParameter("alt", "media").build())))

    /** Preallocated ids in the app-data space (16 §4.5): a retried create can never duplicate a file. */
    suspend fun generateIds(count: Int): List<String> {
        require(count in 1..1000) { "generateIds: 1..1000" }
        val url =
            api("files", "generateIds")
                .addQueryParameter("count", count.toString())
                .addQueryParameter("space", APP_DATA_FOLDER)
                .addQueryParameter("type", "files")
                .build()
        val ids = json<GeneratedIdsResponse>(Spec("GET", url)).ids
        if (ids.size != count) throw SyncException(SyncErrorCode.E_SYNC_HTTP, "generateIds returned the wrong count")
        return ids
    }

    /** The account's email from OpenID userinfo: a display hint only (16 §3.2), null when unavailable. */
    suspend fun userEmail(): String? =
        try {
            json<UserInfoResponse>(Spec("GET", endpoints.userInfo.toHttpUrl())).email
        } catch (e: SyncException) {
            if (e.code == SyncErrorCode.E_SYNC_AUTH) throw e
            null
        }

    // -------------------------------------------------------------------------------- writing

    /**
     * Creates a file in the app-data folder under a preallocated [id]. A retry after a lost response
     * finds the id taken (409) and returns the existing file instead of duplicating it.
     */
    suspend fun create(
        id: String,
        name: String,
        appProperties: Map<String, String>,
        mime: String,
        body: ByteArray,
    ): DriveFile {
        val metadata = CreateMetadata(id = id, name = name, mimeType = mime, appProperties = appProperties)
        val metadataJson = DriveJson.encodeToString(CreateMetadata.serializer(), metadata)
        return try {
            if (body.size <= multipartMaxBytes) {
                val mp = multipartBody(metadataJson, body, mime)
                json(
                    Spec(
                        "POST",
                        upload("files").addQueryParameter("uploadType", "multipart").addQueryParameter("fields", FILE_FIELDS).build(),
                        mp.second.toRequestBody(mp.first.toMediaType()),
                    ),
                )
            } else {
                resumable("POST", upload("files"), id, metadataJson, body, mime)
            }
        } catch (e: SyncException) {
            if (e.status == 409) metadata(id) else throw e
        }
    }

    /** Replaces a file's content (a new revision). Own files only (16 §4.2). */
    suspend fun updateContent(
        fileId: String,
        body: ByteArray,
        mime: String,
    ): DriveFile =
        if (body.size <= multipartMaxBytes) {
            json(
                Spec(
                    "PATCH",
                    upload("files", fileId).addQueryParameter("uploadType", "media").addQueryParameter("fields", FILE_FIELDS).build(),
                    body.toRequestBody(mime.toMediaType()),
                ),
            )
        } else {
            resumable("PATCH", upload("files", fileId), fileId, "{}", body, mime)
        }

    /** Metadata-only update of `appProperties`: no new revision (the heartbeat, 16 §4.3). */
    suspend fun patchProperties(
        fileId: String,
        appProperties: Map<String, String>,
    ) {
        val bodyJson = DriveJson.encodeToString(PropertiesPatch.serializer(), PropertiesPatch(appProperties))
        send(Spec("PATCH", api("files", fileId).addQueryParameter("fields", "id").build(), bodyJson.toRequestBody(JSON))).close()
    }

    /** Permanent delete; a file already gone counts as deleted. */
    suspend fun delete(fileId: String) {
        try {
            send(Spec("DELETE", api("files", fileId).build())).close()
        } catch (e: SyncException) {
            if (e.code != SyncErrorCode.E_SYNC_NOT_FOUND) throw e
        }
    }

    // ------------------------------------------------------------------------------ resumable

    /**
     * Resumable upload: chunks of [chunkBytes] (a multiple of 256 KiB), the session URI remembered
     * under [key] so a restart resumes instead of starting over. A session older than a week, for other
     * bytes, or one Drive no longer knows starts again.
     */
    private suspend fun resumable(
        method: String,
        base: HttpUrl.Builder,
        key: String,
        metadataJson: String,
        body: ByteArray,
        mime: String,
    ): DriveFile {
        val total = body.size.toLong()
        val sha256 = sha256Hex(body)
        var session = sessions?.get(key)
        if (session != null &&
            (
                now() - session.startedAt > RESUMABLE_SESSION_MS ||
                    session.size != total ||
                    session.sha256 != sha256 ||
                    !session.uri.startsWith("${endpoints.upload}/")
            )
        ) {
            sessions?.delete(key)
            session = null
        }
        var offset = 0L
        if (session != null) {
            val probe = probeSession(session.uri, total)
            when {
                probe.done != null -> {
                    sessions?.delete(key)
                    return probe.done
                }
                probe.offset == null -> {
                    sessions?.delete(key)
                    session = null
                }
                else -> offset = checkedOffset(probe.offset, 0L, total)
            }
        }
        if (session == null) {
            val res =
                send(
                    Spec(
                        method,
                        base.addQueryParameter("uploadType", "resumable").addQueryParameter("fields", FILE_FIELDS).build(),
                        metadataJson.toRequestBody(JSON),
                        headers = mapOf("X-Upload-Content-Type" to mime, "X-Upload-Content-Length" to total.toString()),
                    ),
                )
            val uri = res.use { it.header("Location") }
            if (uri == null || !uri.startsWith("${endpoints.upload}/")) {
                throw SyncException(SyncErrorCode.E_SYNC_HTTP, "No resumable session")
            }
            session = ResumableSession(uri, now(), total, sha256)
            sessions?.set(key, session)
        }

        val sessionUrl = session.uri.toHttpUrl()
        var failures = 0
        while (offset < total) {
            val end = minOf(offset + chunkBytes, total)
            val res =
                try {
                    send(
                        Spec(
                            "PUT",
                            sessionUrl,
                            body.toRequestBody(null, offset.toInt(), (end - offset).toInt()),
                            headers = mapOf("Content-Range" to "bytes $offset-${end - 1}/$total"),
                            accept = setOf(308),
                            timeoutMs = CHUNK_TIMEOUT_MS,
                            retry = false,
                        ),
                    )
                } catch (e: SyncException) {
                    // A lost or refused chunk: back off, ask the session how much it kept, go on from there.
                    if (!isTransient(e) || !backoff.canRetry(failures)) throw e
                    backoff.pause(failures)
                    failures++
                    val probe = probeSession(session.uri, total)
                    probe.done?.let {
                        sessions?.delete(key)
                        return it
                    }
                    val at = probe.offset
                    if (at == null) {
                        sessions?.delete(key)
                        throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Resumable session expired")
                    }
                    offset = checkedOffset(at, 0L, total)
                    continue
                }
            if (res.code == 308) {
                offset = checkedOffset(res.use { nextOffsetFromRange(it.header("Range")) }, offset, total)
                continue
            }
            sessions?.delete(key)
            return decode(bytesOf(res))
        }
        // Every byte was acknowledged but no final response arrived: ask the session for the file.
        val probe = probeSession(session.uri, total)
        sessions?.delete(key)
        return probe.done ?: throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Resumable upload did not complete")
    }

    /** Drive must accept whole 256 KiB quanta and never go backwards; anything else is a broken session. */
    private fun checkedOffset(
        next: Long,
        floor: Long,
        total: Long,
    ): Long {
        if (next < floor || next > total || (next < total && next % RESUMABLE_QUANTUM != 0L)) {
            throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Resumable upload lost its place")
        }
        return next
    }

    /** A network error or a retryable status (16 §4.5). */
    private fun isTransient(e: SyncException): Boolean {
        if (e.code != SyncErrorCode.E_SYNC_HTTP) return false
        val s = e.status ?: return true
        return Backoff.isRetryable(s, null)
    }

    private class Probe(
        val done: DriveFile? = null,
        val offset: Long? = null,
    )

    /** `PUT bytes * /total` status check: done, resume at an offset, or unknown (start over). */
    private suspend fun probeSession(
        uri: String,
        total: Long,
    ): Probe =
        try {
            val res = send(Spec("PUT", uri.toHttpUrl(), EMPTY_BODY, headers = mapOf("Content-Range" to "bytes */$total"), accept = setOf(308)))
            if (res.code == 308) {
                Probe(offset = res.use { nextOffsetFromRange(it.header("Range")) })
            } else {
                Probe(done = decode(bytesOf(res)))
            }
        } catch (e: SyncException) {
            val s = e.status
            if (e.code != SyncErrorCode.E_SYNC_AUTH && s != null && s in 400..499) Probe() else throw e
        }

    companion object {
        /** Bodies up to this size use one multipart request; larger ones a resumable session. */
        const val MULTIPART_MAX_BYTES = 5 * 1024 * 1024

        /** Resumable chunk size: 8 MiB, a multiple of the required 256 KiB. */
        const val RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024
        const val RESUMABLE_QUANTUM = 256 * 1024

        /** Resumable session URIs are valid for one week. */
        const val RESUMABLE_SESSION_MS = 7L * 24 * 60 * 60 * 1000

        /** Per-attempt limit for a request and its body; a timeout counts as a network error. */
        const val REQUEST_TIMEOUT_MS = 60_000L

        /** Per-attempt limit for one resumable chunk on a slow uplink. */
        const val CHUNK_TIMEOUT_MS = 5 * 60_000L
        private const val MAX_PAGES = 10_000

        private val QUOTA_REASONS = setOf("storageQuotaExceeded", "quotaExceeded")
        private val BODY_METHODS = setOf("POST", "PUT", "PATCH")
        private val EMPTY_BODY = ByteArray(0).toRequestBody(null)
        private val JSON = "application/json; charset=UTF-8".toMediaType()
        private val random = SecureRandom()

        /** Escapes a value for a Drive query string literal. */
        fun quoteQueryValue(v: String): String = "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"

        /** The `files.list` query: not trashed, plus `appProperties has` filters (sorted for stable URLs). */
        fun buildListQuery(props: Map<String, String>): String =
            (
                listOf("trashed = false") +
                    props.entries.sortedBy { it.key }.map { (k, v) ->
                        "appProperties has { key=${quoteQueryValue(k)} and value=${quoteQueryValue(v)} }"
                    }
            ).joinToString(" and ")

        /** Parses a resumable `Range: bytes=0-N` header into the next offset (N + 1), or 0 when absent. */
        fun nextOffsetFromRange(range: String?): Long {
            val m = range?.let { Regex("^bytes=0-(\\d+)$").find(it.trim()) } ?: return 0
            return m.groupValues[1].toLongOrNull()?.plus(1) ?: 0
        }

        /**
         * A `multipart/related` body (Drive "multipart upload"): JSON metadata, then the media. The
         * boundary is random and never occurs in the body. Returns (content type, bytes).
         */
        fun multipartBody(
            metadataJson: String,
            body: ByteArray,
            mime: String,
        ): Pair<String, ByteArray> {
            var boundary: String
            do {
                val b = ByteArray(16).also(random::nextBytes)
                boundary = "eli5-" + b.joinToString("") { "%02x".format(it) }
            } while (indexOf(body, boundary.encodeToByteArray()) >= 0)
            val out = ByteArrayOutputStream(body.size + 512)
            out.write(
                (
                    "--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n$metadataJson\r\n" +
                        "--$boundary\r\nContent-Type: $mime\r\n\r\n"
                ).encodeToByteArray(),
            )
            out.write(body)
            out.write("\r\n--$boundary--".encodeToByteArray())
            return "multipart/related; boundary=$boundary" to out.toByteArray()
        }

        private fun indexOf(
            hay: ByteArray,
            needle: ByteArray,
        ): Int {
            if (needle.isEmpty() || needle.size > hay.size) return -1
            outer@ for (i in 0..hay.size - needle.size) {
                for (j in needle.indices) if (hay[i + j] != needle[j]) continue@outer
                return i
            }
            return -1
        }

        fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

/** Runs the call on OkHttp's dispatcher; cancelling the coroutine cancels the call. */
private suspend fun Call.await(): Response =
    suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onResponse(
                    call: Call,
                    response: Response,
                ) {
                    cont.resume(response) { _, value, _ -> value.close() }
                }

                override fun onFailure(
                    call: Call,
                    e: IOException,
                ) {
                    cont.resumeWithException(e)
                }
            },
        )
    }
