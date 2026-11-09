package io.github.eli5learner.drive

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** DriveClient against MockWebServer (16 §12): paging, 410, multipart shape, resumable chunks, backoff, 401. */
class DriveClientTest {
    private lateinit var server: MockWebServer
    private val auth = FakeAuth()
    private val sleeps = mutableListOf<Long>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun client(
        maxAttempts: Int = Backoff.MAX_ATTEMPTS,
        multipartMaxBytes: Int = DriveClient.MULTIPART_MAX_BYTES,
        chunkBytes: Int = DriveClient.RESUMABLE_QUANTUM,
        sessions: ResumableSessionStore? = null,
    ) = DriveClient(
        http = OkHttpClient(),
        auth = auth,
        endpoints = endpoints(),
        backoff = Backoff(maxAttempts = maxAttempts, random = { 0.5 }, sleep = { sleeps += it }),
        sessions = sessions,
        multipartMaxBytes = multipartMaxBytes,
        chunkBytes = chunkBytes,
    )

    private fun endpoints() =
        DriveEndpoints(
            api = server.url("/drive/v3").toString(),
            upload = server.url("/upload/drive/v3").toString(),
            userInfo = server.url("/v1/userinfo").toString(),
        )

    private fun json(
        body: String,
        code: Int = 200,
    ) = MockResponse
        .Builder()
        .code(code)
        .setHeader("Content-Type", "application/json")
        .body(body)
        .build()

    private fun error(
        code: Int,
        reason: String? = null,
    ) = json(if (reason == null) """{"error":{"code":$code}}""" else """{"error":{"code":$code,"errors":[{"reason":"$reason"}]}}""", code)

    private fun take(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS) ?: error("no request")

    private fun fileJson(id: String) = """{"id":"$id","name":"x.json","appProperties":{"k":"device"},"size":"3"}"""

    private suspend fun expect(
        code: SyncErrorCode,
        block: suspend () -> Unit,
    ): SyncException {
        try {
            block()
        } catch (e: SyncException) {
            assertEquals(code, e.code)
            return e
        }
        fail("expected $code")
        throw IllegalStateException()
    }

    // ------------------------------------------------------------------------------- reading

    @Test
    fun listFollowsEveryPageInTheAppDataFolder() =
        runBlocking {
            server.enqueue(json("""{"files":[{"id":"a"},{"id":"b"}],"nextPageToken":"p2"}"""))
            server.enqueue(json("""{"files":[{"id":"c","unknownField":1}]}"""))
            val files = client().list(mapOf("k" to "doc", "d" to "it's"))
            assertEquals(listOf("a", "b", "c"), files.map { it.id })

            val first = take()
            assertEquals("GET", first.method)
            assertEquals("/drive/v3/files", first.url.encodedPath)
            assertEquals("appDataFolder", first.url.queryParameter("spaces"))
            assertEquals("1000", first.url.queryParameter("pageSize"))
            assertEquals(
                "trashed = false and appProperties has { key='d' and value='it\\'s' } and appProperties has { key='k' and value='doc' }",
                first.url.queryParameter("q"),
            )
            assertEquals("nextPageToken,files($FILE_FIELDS)", first.url.queryParameter("fields"))
            assertNull(first.url.queryParameter("pageToken"))
            assertEquals("Bearer t1", first.headers["Authorization"])
            assertEquals("p2", take().url.queryParameter("pageToken"))
        }

    @Test
    fun changesFollowsPagesToTheNewStartToken() =
        runBlocking {
            server.enqueue(json("""{"changes":[{"fileId":"a","removed":true}],"nextPageToken":"p2"}"""))
            server.enqueue(json("""{"changes":[{"fileId":"b","file":${fileJson("b")}}],"newStartPageToken":"s9"}"""))
            val page = client().changes("s1")
            assertEquals("s9", page.newStartPageToken)
            assertEquals(listOf("a", "b"), page.changes.map { it.fileId })
            assertTrue(page.changes[0].removed)
            assertEquals("device", page.changes[1].file?.appProperties?.get("k"))

            val first = take()
            assertEquals("/drive/v3/changes", first.url.encodedPath)
            assertEquals("s1", first.url.queryParameter("pageToken"))
            assertEquals("true", first.url.queryParameter("includeRemoved"))
            assertEquals("appDataFolder", first.url.queryParameter("spaces"))
            assertEquals(
                "nextPageToken,newStartPageToken,changes(fileId,removed,file($FILE_FIELDS))",
                first.url.queryParameter("fields"),
            )
            assertEquals("p2", take().url.queryParameter("pageToken"))
        }

    @Test
    fun anExpiredChangeTokenIsE_SYNC_TOKEN() =
        runBlocking {
            server.enqueue(error(410))
            val e = expect(SyncErrorCode.E_SYNC_TOKEN) { client().changes("old") }
            assertEquals(410, e.status)
            assertTrue("410 is not retried", sleeps.isEmpty())
        }

    @Test
    fun anInvalidChangeTokenIsE_SYNC_TOKEN() =
        runBlocking {
            server.enqueue(error(400, "invalid"))
            expect(SyncErrorCode.E_SYNC_TOKEN) { client().changes("garbage") }
            Unit
        }

    @Test
    fun startTokenGenerateIdsAndDownload() =
        runBlocking {
            server.enqueue(json("""{"startPageToken":"42"}"""))
            server.enqueue(json("""{"ids":["i1","i2"],"space":"appDataFolder"}"""))
            server.enqueue(MockResponse.Builder().body("hello").build())
            val c = client()
            assertEquals("42", c.startPageToken())
            assertEquals(listOf("i1", "i2"), c.generateIds(2))
            assertArrayEquals("hello".encodeToByteArray(), c.download("f 1"))

            assertEquals("/drive/v3/changes/startPageToken", take().url.encodedPath)
            val ids = take()
            assertEquals("/drive/v3/files/generateIds", ids.url.encodedPath)
            assertEquals("2", ids.url.queryParameter("count"))
            assertEquals("appDataFolder", ids.url.queryParameter("space"))
            val dl = take()
            assertEquals("/drive/v3/files/f%201", dl.url.encodedPath)
            assertEquals("media", dl.url.queryParameter("alt"))
        }

    @Test
    fun generateIdsRejectsAWrongCount() =
        runBlocking {
            server.enqueue(json("""{"ids":["only-one"]}"""))
            expect(SyncErrorCode.E_SYNC_HTTP) { client().generateIds(2) }
            Unit
        }

    // ------------------------------------------------------------------------------- writing

    @Test
    fun smallCreateIsOneMultipartRequestInTheAppDataFolder() =
        runBlocking {
            server.enqueue(json(fileJson("id1")))
            val body = """{"x":"--not-a-boundary"}""".encodeToByteArray()
            val f = client().create("id1", "job-1.json", mapOf("k" to "job", "dev" to "d1"), "application/json", body)
            assertEquals("id1", f.id)

            val r = take()
            assertEquals("POST", r.method)
            assertEquals("/upload/drive/v3/files", r.url.encodedPath)
            assertEquals("multipart", r.url.queryParameter("uploadType"))
            assertEquals(FILE_FIELDS, r.url.queryParameter("fields"))
            val contentType = r.headers["Content-Type"]!!
            assertTrue(contentType, contentType.startsWith("multipart/related; boundary=eli5-"))
            val boundary = contentType.substringAfter("boundary=")
            val text = r.body!!.utf8()
            val parts = text.split("--$boundary")
            // "", metadata part, media part, "--" (closing delimiter)
            assertEquals(4, parts.size)
            assertEquals("--", parts[3])
            val (metaHead, metaJson) = parts[1].split("\r\n\r\n", limit = 2)
            assertEquals("\r\nContent-Type: application/json; charset=UTF-8", metaHead)
            val meta = Json.parseToJsonElement(metaJson.trimEnd()).jsonObject
            assertEquals("id1", meta["id"]!!.jsonPrimitive.content)
            assertEquals("job-1.json", meta["name"]!!.jsonPrimitive.content)
            assertEquals("application/json", meta["mimeType"]!!.jsonPrimitive.content)
            assertEquals("appDataFolder", meta["parents"]!!.jsonArray.single().jsonPrimitive.content)
            assertEquals("job", meta["appProperties"]!!.jsonObject["k"]!!.jsonPrimitive.content)
            val (mediaHead, media) = parts[2].split("\r\n\r\n", limit = 2)
            assertEquals("\r\nContent-Type: application/json", mediaHead)
            assertEquals(body.decodeToString() + "\r\n", media)
        }

    @Test
    fun aRetriedCreateThatFindsItsIdTakenReturnsTheExistingFile() =
        runBlocking {
            server.enqueue(error(409))
            server.enqueue(json(fileJson("id1")))
            val f = client().create("id1", "a.json", mapOf("k" to "info"), "application/json", byteArrayOf(1))
            assertEquals("id1", f.id)
            take()
            val meta = take()
            assertEquals("GET", meta.method)
            assertEquals("/drive/v3/files/id1", meta.url.encodedPath)
        }

    @Test
    fun largeCreateUploadsResumableChunksInMultiplesOf256KiB() =
        runBlocking {
            val q = DriveClient.RESUMABLE_QUANTUM
            val total = 2 * q + 1000
            val body = ByteArray(total) { (it % 251).toByte() }
            val session = server.url("/upload/drive/v3/files?uploadType=resumable&upload_id=s1").toString()
            server.enqueue(MockResponse.Builder().code(200).setHeader("Location", session).build())
            server.enqueue(MockResponse.Builder().code(308).setHeader("Range", "bytes=0-${q - 1}").build())
            server.enqueue(MockResponse.Builder().code(308).setHeader("Range", "bytes=0-${2 * q - 1}").build())
            server.enqueue(json(fileJson("big")))

            val f = client(multipartMaxBytes = 1024).create("big", "att.bin", mapOf("k" to "att"), "application/octet-stream", body)
            assertEquals("big", f.id)

            val start = take()
            assertEquals("POST", start.method)
            assertEquals("resumable", start.url.queryParameter("uploadType"))
            assertEquals("application/octet-stream", start.headers["X-Upload-Content-Type"])
            assertEquals(total.toString(), start.headers["X-Upload-Content-Length"])
            val meta = Json.parseToJsonElement(start.body!!.utf8()).jsonObject
            assertEquals("appDataFolder", meta["parents"]!!.jsonArray.single().jsonPrimitive.content)

            val chunks = (1..3).map { take() }
            assertEquals(listOf("PUT", "PUT", "PUT"), chunks.map { it.method })
            assertEquals(
                listOf("bytes 0-${q - 1}/$total", "bytes $q-${2 * q - 1}/$total", "bytes ${2 * q}-${total - 1}/$total"),
                chunks.map { it.headers["Content-Range"] },
            )
            assertEquals(listOf(q.toLong(), q.toLong(), 1000L), chunks.map { it.bodySize })
            chunks.dropLast(1).forEach { assertEquals(0L, it.bodySize % q) }
            assertArrayEquals(body, chunks.flatMap { it.body!!.toByteArray().toList() }.toByteArray())
            assertEquals("s1", chunks[0].url.queryParameter("upload_id"))
        }

    @Test
    fun aResumableRangeOffTheQuantumIsABrokenSession() =
        runBlocking {
            val q = DriveClient.RESUMABLE_QUANTUM
            val session = server.url("/upload/drive/v3/files?upload_id=s2").toString()
            server.enqueue(MockResponse.Builder().code(200).setHeader("Location", session).build())
            server.enqueue(MockResponse.Builder().code(308).setHeader("Range", "bytes=0-99").build())
            expect(SyncErrorCode.E_SYNC_HTTP) {
                client(multipartMaxBytes = 0).create("x", "x", emptyMap(), "application/octet-stream", ByteArray(q + 1))
            }
            Unit
        }

    @Test
    fun aResumableSessionOutsideTheUploadRootIsRefused() =
        runBlocking {
            server.enqueue(MockResponse.Builder().code(200).setHeader("Location", "https://example.invalid/upload").build())
            expect(SyncErrorCode.E_SYNC_HTTP) {
                client(multipartMaxBytes = 0).create("x", "x", emptyMap(), "application/octet-stream", ByteArray(10))
            }
            assertEquals(1, server.requestCount)
        }

    @Test
    fun aRememberedSessionResumesAtTheReportedOffset() =
        runBlocking {
            val q = DriveClient.RESUMABLE_QUANTUM
            val body = ByteArray(2 * q) { 7 }
            val uri = server.url("/upload/drive/v3/files?upload_id=old").toString()
            val store = MemorySessions()
            store.set("f1", ResumableSession(uri, System.currentTimeMillis(), body.size.toLong(), DriveClient.sha256Hex(body)))
            server.enqueue(MockResponse.Builder().code(308).setHeader("Range", "bytes=0-${q - 1}").build())
            server.enqueue(json(fileJson("f1")))

            client(multipartMaxBytes = 0, sessions = store).updateContent("f1", body, "text/html")

            val probe = take()
            assertEquals("bytes */${2 * q}", probe.headers["Content-Range"])
            val rest = take()
            assertEquals("bytes $q-${2 * q - 1}/${2 * q}", rest.headers["Content-Range"])
            assertNull(store.get("f1"))
        }

    @Test
    fun aLostChunkAsksTheSessionWhereItStandsBeforeResending() =
        runBlocking {
            val q = DriveClient.RESUMABLE_QUANTUM
            val total = 3 * q
            val body = ByteArray(total) { (it % 13).toByte() }
            val session = server.url("/upload/drive/v3/files?upload_id=s3").toString()
            server.enqueue(MockResponse.Builder().code(200).setHeader("Location", session).build())
            server.enqueue(MockResponse.Builder().code(308).setHeader("Range", "bytes=0-${q - 1}").build())
            server.enqueue(error(503)) // the second chunk is lost
            server.enqueue(MockResponse.Builder().code(308).setHeader("Range", "bytes=0-${2 * q - 1}").build()) // the server kept it
            server.enqueue(json(fileJson("big")))

            val f = client(multipartMaxBytes = 0).create("big", "att.bin", emptyMap(), "application/octet-stream", body)
            assertEquals("big", f.id)
            take()
            assertEquals("bytes 0-${q - 1}/$total", take().headers["Content-Range"])
            assertEquals("bytes $q-${2 * q - 1}/$total", take().headers["Content-Range"])
            val probe = take()
            assertEquals("bytes */$total", probe.headers["Content-Range"])
            assertEquals(0L, probe.bodySize)
            // Resumes after what the session reported, not by blindly resending the lost chunk.
            assertEquals("bytes ${2 * q}-${total - 1}/$total", take().headers["Content-Range"])
            assertEquals(listOf(500L), sleeps)
        }

    @Test
    fun aLostLastChunkThatTheSessionFinishedReturnsTheFile() =
        runBlocking {
            val q = DriveClient.RESUMABLE_QUANTUM
            val session = server.url("/upload/drive/v3/files?upload_id=s4").toString()
            server.enqueue(MockResponse.Builder().code(200).setHeader("Location", session).build())
            server.enqueue(error(502))
            server.enqueue(json(fileJson("done")))
            val f = client(multipartMaxBytes = 0).create("done", "a.bin", emptyMap(), "application/octet-stream", ByteArray(q))
            assertEquals("done", f.id)
            assertEquals(3, server.requestCount)
        }

    @Test
    fun updatePatchAndDelete() =
        runBlocking {
            server.enqueue(json(fileJson("f1")))
            server.enqueue(json("""{"id":"f1"}"""))
            server.enqueue(MockResponse.Builder().code(204).build())
            server.enqueue(error(404))
            val c = client()
            c.updateContent("f1", "abc".encodeToByteArray(), "application/json")
            c.patchProperties("f1", mapOf("hb" to "123"))
            c.delete("f1")
            c.delete("gone") // already gone counts as deleted

            val up = take()
            assertEquals("PATCH", up.method)
            assertEquals("/upload/drive/v3/files/f1", up.url.encodedPath)
            assertEquals("media", up.url.queryParameter("uploadType"))
            assertEquals("abc", up.body!!.utf8())
            val patch = take()
            assertEquals("PATCH", patch.method)
            assertEquals("/drive/v3/files/f1", patch.url.encodedPath)
            assertEquals("""{"appProperties":{"hb":"123"}}""", patch.body!!.utf8())
            assertEquals("DELETE", take().method)
        }

    // ---------------------------------------------------------------------- backoff and auth

    @Test
    fun transientFailuresBackOffWithFullJitter() =
        runBlocking {
            server.enqueue(error(503))
            server.enqueue(error(429))
            server.enqueue(error(403, "userRateLimitExceeded"))
            server.enqueue(json("""{"startPageToken":"1"}"""))
            assertEquals("1", client().startPageToken())
            // random() = 0.5: half of 1 s, 2 s, 4 s.
            assertEquals(listOf(500L, 1000L, 2000L), sleeps)
            assertEquals(4, server.requestCount)
        }

    @Test
    fun backoffIsCappedAt64Seconds() {
        val b = Backoff(random = { 0.999999 })
        assertEquals(999L, b.delayMs(0))
        assertTrue(b.delayMs(6) < 64_000L)
        assertEquals(63_999L, b.delayMs(10))
        assertEquals(63_999L, b.delayMs(100))
        assertTrue(Backoff().canRetry(5))
        assertTrue(!Backoff().canRetry(6))
    }

    @Test
    fun givesUpAfterMaxAttempts() =
        runBlocking {
            repeat(3) { server.enqueue(error(500)) }
            val e = expect(SyncErrorCode.E_SYNC_HTTP) { client(maxAttempts = 3).startPageToken() }
            assertEquals(500, e.status)
            assertEquals(2, sleeps.size)
            assertEquals(3, server.requestCount)
        }

    @Test
    fun storageFullIsE_SYNC_QUOTAWithoutRetry() =
        runBlocking {
            server.enqueue(error(403, "storageQuotaExceeded"))
            expect(SyncErrorCode.E_SYNC_QUOTA) { client().create("i", "n", emptyMap(), "application/json", byteArrayOf(1)) }
            assertTrue(sleeps.isEmpty())
        }

    @Test
    fun aDisabledDriveApiIsE_SYNC_API_DISABLEDWithoutRetry() =
        runBlocking {
            server.enqueue(error(403, "accessNotConfigured"))
            expect(SyncErrorCode.E_SYNC_API_DISABLED) { client().create("i", "n", emptyMap(), "application/json", byteArrayOf(1)) }
            // The newer error shape names it only in details[].reason.
            server.enqueue(
                json(
                    """{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SERVICE_DISABLED"}]}}""",
                    403,
                ),
            )
            expect(SyncErrorCode.E_SYNC_API_DISABLED) { client().create("i", "n", emptyMap(), "application/json", byteArrayOf(1)) }
            assertTrue(sleeps.isEmpty())
        }

    @Test
    fun aRefused403IsNotRetried() =
        runBlocking {
            server.enqueue(error(403, "insufficientPermissions"))
            val e = expect(SyncErrorCode.E_SYNC_HTTP) { client().list() }
            assertEquals(403, e.status)
            assertTrue(sleeps.isEmpty())
        }

    @Test
    fun a401ClearsTheTokenAndRetriesOnceWithAFreshOne() =
        runBlocking {
            server.enqueue(error(401))
            server.enqueue(json("""{"files":[]}"""))
            client().list()
            assertEquals(listOf("t1"), auth.invalidated)
            assertEquals(0, auth.failures)
            assertEquals("Bearer t1", take().headers["Authorization"])
            assertEquals("Bearer t2", take().headers["Authorization"])
            assertTrue("a token refresh is not a backoff", sleeps.isEmpty())
        }

    @Test
    fun a401WithTheFreshTokenTooIsE_SYNC_AUTH() =
        runBlocking {
            server.enqueue(error(401))
            server.enqueue(error(401))
            expect(SyncErrorCode.E_SYNC_AUTH) { client().list() }
            assertEquals(listOf("t1", "t2"), auth.invalidated)
            assertEquals(1, auth.failures)
            assertEquals(2, server.requestCount)
        }

    @Test
    fun noGrantMeansNoRequest() =
        runBlocking {
            auth.connected = false
            expect(SyncErrorCode.E_SYNC_AUTH) { client().list() }
            assertEquals(0, server.requestCount)
        }

    @Test
    fun userEmailIsAHintAndNullOnFailure() =
        runBlocking {
            server.enqueue(json("""{"sub":"1","email":"someone@example.com"}"""))
            server.enqueue(error(404))
            val c = client()
            assertEquals("someone@example.com", c.userEmail())
            assertNull(c.userEmail())
            assertEquals("/v1/userinfo", take().url.encodedPath)
        }

    @Test
    fun rangeAndQueryHelpers() {
        assertEquals(0L, DriveClient.nextOffsetFromRange(null))
        assertEquals(262_144L, DriveClient.nextOffsetFromRange("bytes=0-262143"))
        assertEquals(0L, DriveClient.nextOffsetFromRange("bytes=5-9"))
        assertEquals("'a\\'b\\\\c'", DriveClient.quoteQueryValue("a'b\\c"))
        assertEquals("trashed = false", DriveClient.buildListQuery(emptyMap()))
    }

    @Test
    fun theChunkSizeMustBeAMultipleOf256KiB() {
        try {
            DriveClient(OkHttpClient(), auth, endpoints(), chunkBytes = 1000)
            fail("expected a rejection")
        } catch (_: IllegalArgumentException) {
        }
    }

    // ------------------------------------------------------------------------------- fakes

    private class FakeAuth : AccessTokenSource {
        var connected = true
        private var n = 1
        private var current: String? = null
        val invalidated = mutableListOf<String>()
        var failures = 0

        override suspend fun accessToken(): String {
            if (!connected) throw SyncException(SyncErrorCode.E_SYNC_AUTH)
            return current ?: "t${n++}".also { current = it }
        }

        override suspend fun invalidate(token: String) {
            invalidated += token
            if (current == token) current = null
        }

        override suspend fun authFailed() {
            failures++
        }
    }

    private class MemorySessions : ResumableSessionStore {
        private val map = mutableMapOf<String, ResumableSession>()

        override suspend fun get(key: String) = map[key]

        override suspend fun set(
            key: String,
            session: ResumableSession,
        ) {
            map[key] = session
        }

        override suspend fun delete(key: String) {
            map.remove(key)
        }
    }
}
