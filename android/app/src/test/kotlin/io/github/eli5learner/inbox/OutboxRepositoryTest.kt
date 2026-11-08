package io.github.eli5learner.inbox

import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.AppPreferences
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.data.db.JobEntity
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import io.github.eli5learner.inMemoryDb
import io.github.eli5learner.sync.DeviceWriter
import io.github.eli5learner.sync.FakeDrive
import io.github.eli5learner.sync.SyncOutcome
import io.github.eli5learner.sync.SyncRepository
import io.github.eli5learner.sync.TestMac
import io.github.eli5learner.sync.protocol.Attachment
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.sync.protocol.JobRequest
import io.github.eli5learner.sync.protocol.JobState
import io.github.eli5learner.sync.protocol.JobStatus
import io.github.eli5learner.sync.protocol.Patterns
import io.github.eli5learner.sync.protocol.SyncProtocol
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The outbox (16 §5.2) and job statuses (16 §5.3, §4.7) against the in-memory Drive and Room:
 * upload order, idempotent retries, cancel, statuses, notifications, acks, collection and rebuild.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OutboxRepositoryTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var prefs: AppPreferences
    private lateinit var root: File
    private val drive = FakeDrive()
    private var auth: AuthState = AuthState.Connected("reader@example.com")
    private var now = NOW
    private var kicks = 0
    private val notified = mutableListOf<String>()

    @Before fun setUp() {
        db = inMemoryDb()
        prefs = AppPreferences.create(File(tmp.root, "settings.preferences_pb"))
        root = tmp.newFolder("outbox")
    }

    @After fun tearDown() = db.close()

    private fun outbox(database: Eli5Db = db) =
        OutboxRepository(
            db = database,
            root = root,
            drive = drive,
            prefs = prefs,
            authState = { auth },
            kickUpload = { kicks++ },
            notifyReady = { job ->
                notified += job.jobId
                true
            },
            now = { now },
        )

    private suspend fun queue(
        o: OutboxRepository,
        files: List<ByteArray> = listOf(PNG, PDF),
        urls: List<String> = listOf("https://example.com/article"),
        jobId: String = JobIds.new(now),
    ): String {
        val atts =
            files.mapIndexed { i, b ->
                val sha = o.stage(jobId, b)
                Attachment(sha, "file-$i", if (b === PDF) "application/pdf" else "image/png", b.size.toLong())
            }
        o.queueCapture(CaptureDraft(jobId, urls, "", "Why now?", listOf(FocusChip.BIG_PICTURE), atts, "example.com"))
        return jobId
    }

    private fun kindsInOrder(): List<String> = drive.files.values.mapNotNull { it.meta.appProperties?.get("k") }

    private fun index() = drive.files.values.mapNotNull { SyncRepository.rowOf(it.meta) }

    private fun putStatus(
        jobId: String,
        state: JobState,
        dev: String = TestMac.MAC_ID,
        docId: String? = null,
        skipped: Long? = null,
        code: String? = null,
        reason: String? = null,
        stage: String? = null,
        id: String? = null,
    ): String {
        val s = JobStatus(1, jobId, "2026-11-08T10:00:00Z", state, stage = stage, docId = docId, skippedSources = skipped, code = code, reason = reason)
        val body = SyncProtocol.encode(JobStatus.serializer(), s).toByteArray()
        if (id != null) {
            drive.rewrite(id, body)
            return id
        }
        return drive.put("jobstatus-$jobId.json", mapOf("k" to "status", "dev" to dev, "s" to jobId), body)
    }

    @Test fun `queueing writes request json and a waiting row, asks for an upload, and makes no request`() =
        runTest {
            val o = outbox()
            val id = queue(o)
            val dir = File(root, id)
            val req = SyncProtocol.decodeJob(File(dir, OutboxRepository.REQUEST).readText()) as JobRequest.Capture
            assertEquals(id, req.jobId)
            assertEquals(prefs.deviceId(), req.deviceId)
            assertEquals(listOf("https://example.com/article"), req.urls)
            assertEquals(listOf(FocusChip.BIG_PICTURE), req.focus)
            assertEquals(2, req.attachments.size)
            assertTrue(Patterns.JOB_ID.matches(id))
            val row = db.jobs().get(id)!!
            assertEquals(JobEntity.LOCAL, row.local)
            assertEquals("example.com", row.title)
            assertEquals(1, kicks)
            assertTrue(drive.calls.isEmpty())
            assertTrue(o.active.first())
        }

    @Test fun `upload sends every attachment before the job file, then marks the job uploaded`() =
        runTest {
            val o = outbox()
            val id = queue(o)
            assertEquals(SyncOutcome.Synced, o.upload())

            assertEquals(listOf("att", "att", "job"), kindsInOrder())
            val me = prefs.deviceId()
            val att = drive.byKind("att")
            assertEquals(setOf(FakeDrive.sha256(PNG), FakeDrive.sha256(PDF)), att.map { it.meta.appProperties?.get("s") }.toSet())
            assertTrue(att.all { it.meta.appProperties?.get("dev") == me })
            assertTrue(att.any { it.meta.name == "att-${FakeDrive.sha256(PDF)}.pdf" })
            val job = drive.byKind("job").single()
            assertEquals(mapOf("k" to "job", "dev" to me, "s" to id), job.meta.appProperties)
            assertEquals("job-$id.json", job.meta.name)
            // The uploaded body is exactly request.json, and the desktop's schema accepts it.
            assertEquals(File(root, "$id/request.json").readText(), job.body.decodeToString())
            SyncProtocol.decodeJob(job.body.decodeToString())

            val row = db.jobs().get(id)!!
            assertEquals(JobEntity.UPLOADED, row.local)
            assertEquals(job.meta.id, row.jobFileId)
            assertTrue(File(root, "$id/${OutboxRepository.UPLOADED_MARKER}").exists())

            // A second pass has nothing to send.
            drive.calls.clear()
            o.upload()
            assertTrue(drive.calls.none { it == "create" })
        }

    @Test fun `an attachment already in the store is not uploaded again`() =
        runTest {
            val o = outbox()
            drive.put("att-x.png", mapOf("k" to "att", "dev" to "someone", "s" to FakeDrive.sha256(PNG)), PNG)
            queue(o)
            o.upload()
            assertEquals(1, drive.byKind("att").count { it.meta.appProperties?.get("s") == FakeDrive.sha256(PNG) })
            assertEquals(2, drive.byKind("att").size)
            assertEquals(1, drive.byKind("job").size)
        }

    @Test fun `a failure after the attachments resumes without duplicates`() =
        runTest {
            val o = outbox()
            val id = queue(o, files = listOf(PNG))
            // The job file's create fails once (a lost connection); the attachment went up.
            var creates = 0
            val failing =
                object : io.github.eli5learner.drive.DriveApi by drive {
                    override suspend fun create(
                        id: String,
                        name: String,
                        appProperties: Map<String, String>,
                        mime: String,
                        body: ByteArray,
                    ) = if (appProperties["k"] == "job" && creates++ == 0) {
                        throw SyncException(SyncErrorCode.E_SYNC_HTTP, status = 503)
                    } else {
                        drive.create(id, name, appProperties, mime, body)
                    }
                }
            val o2 = OutboxRepository(db, root, failing, prefs, { auth }, now = { now })
            assertTrue(o2.upload() is SyncOutcome.Transient)
            assertEquals(JobEntity.LOCAL, db.jobs().get(id)!!.local)
            assertNotNull(db.jobs().get(id)!!.pendingJobFileId)
            assertEquals(SyncOutcome.Synced, o2.upload())
            assertEquals(1, drive.byKind("att").size)
            assertEquals(1, drive.byKind("job").size)
            assertEquals(db.jobs().get(id)!!.pendingJobFileId, drive.byKind("job").single().meta.id)
            assertEquals(JobEntity.UPLOADED, db.jobs().get(id)!!.local)
            o.upload()
            assertEquals(1, drive.byKind("job").size)
        }

    @Test fun `local mode and a lost grant make no request`() =
        runTest {
            val o = outbox()
            queue(o)
            auth = AuthState.Disconnected
            assertEquals(SyncOutcome.NotConnected, o.upload())
            auth = AuthState.NeedsReconnect("reader@example.com")
            assertEquals(SyncOutcome.NeedsReconnect, o.upload())
            assertTrue(drive.calls.isEmpty())
        }

    @Test fun `cancel before upload removes the job, cancel after upload writes a cancel file`() =
        runTest {
            val o = outbox()
            val early = queue(o)
            o.cancel(early)
            assertNull(db.jobs().get(early))
            assertFalse(File(root, early).exists())

            val sent = queue(o)
            o.upload()
            o.cancel(sent)
            assertTrue(db.jobs().get(sent)!!.cancelRequested)
            val item = InboxViewModel.itemOf(db.jobs().get(sent)!!, connected = true)
            assertEquals(InboxChip.CANCELLING, item.chip)
            assertFalse(item.canCancel)

            o.upload()
            val cancel = drive.byKind("cancel").single()
            assertEquals(sent, cancel.meta.appProperties?.get("s"))
            assertEquals("jobcancel-$sent.json", cancel.meta.name)
            assertEquals(sent, SyncProtocol.decodeJobCancel(cancel.body.decodeToString()).jobId)
            o.upload()
            assertEquals(1, drive.byKind("cancel").size)

            // The desktop honours it.
            putStatus(sent, JobState.CANCELLED)
            o.afterPull(index(), TestMac.MAC_ID)
            assertEquals(InboxChip.CANCELLED, InboxViewModel.itemOf(db.jobs().get(sent)!!, true).chip)
        }

    @Test fun `a Cancel that lands while the job file id is being allocated sends nothing`() =
        runTest {
            lateinit var o: OutboxRepository
            lateinit var id: String
            val racing =
                object : io.github.eli5learner.drive.DriveApi by drive {
                    override suspend fun generateIds(count: Int): List<String> {
                        // The user taps Cancel between the "not cancelled" check and the persisted id.
                        o.cancel(id)
                        return drive.generateIds(count)
                    }
                }
            o = OutboxRepository(db, root, racing, prefs, { auth }, now = { now })
            id = queue(o, files = emptyList())
            assertEquals(SyncOutcome.Synced, o.upload())
            assertTrue(drive.byKind("job").isEmpty())
            assertNull(db.jobs().get(id))
            assertFalse(File(root, id).exists())
        }

    @Test fun `Cancel after a lost job file response still finds the file and writes a cancel file`() =
        runTest {
            val o = outbox()
            val id = queue(o, files = emptyList())
            // The job file's create reaches Drive, but the response is lost and listings lag behind.
            val lossy =
                object : io.github.eli5learner.drive.DriveApi by drive {
                    override suspend fun create(
                        id: String,
                        name: String,
                        appProperties: Map<String, String>,
                        mime: String,
                        body: ByteArray,
                    ): io.github.eli5learner.drive.DriveFile {
                        drive.create(id, name, appProperties, mime, body)
                        drive.hidden += id
                        throw SyncException(SyncErrorCode.E_SYNC_HTTP, status = 503)
                    }
                }
            val o2 = OutboxRepository(db, root, lossy, prefs, { auth }, now = { now })
            assertTrue(o2.upload() is SyncOutcome.Transient)
            val pending = db.jobs().get(id)!!.pendingJobFileId
            assertNotNull(pending)
            o.cancel(id)
            assertEquals(InboxChip.CANCELLING, InboxViewModel.itemOf(db.jobs().get(id)!!, true).chip)
            assertEquals(SyncOutcome.Synced, o.upload())
            val row = db.jobs().get(id)!!
            assertEquals(JobEntity.UPLOADED, row.local)
            assertEquals(pending, row.jobFileId)
            assertEquals(1, drive.byKind("job").size)
            assertEquals(id, drive.byKind("cancel").single().meta.appProperties?.get("s"))
        }

    @Test fun `statuses from the desktop move the job along, and done notifies once`() =
        runTest {
            val o = outbox()
            val id = queue(o)
            o.upload()
            assertEquals(InboxChip.WAITING_FOR_MAC, InboxViewModel.itemOf(db.jobs().get(id)!!, true).chip)

            val sid = putStatus(id, JobState.RUNNING, stage = "Reading sources")
            o.afterPull(index(), TestMac.MAC_ID)
            val running = InboxViewModel.itemOf(db.jobs().get(id)!!, true)
            assertEquals(InboxChip.GENERATING, running.chip)
            assertEquals("Reading sources", running.stage)

            // An unchanged status file is not downloaded again.
            drive.calls.clear()
            o.afterPull(index(), TestMac.MAC_ID)
            assertTrue("download" !in drive.calls)

            val docId = "bbbbbbbb-0000-4000-8000-000000000001"
            putStatus(id, JobState.DONE, docId = docId, skipped = 2, id = sid)
            o.afterPull(index(), TestMac.MAC_ID)
            val done = db.jobs().get(id)!!
            assertEquals("done", done.remoteState)
            assertEquals(docId, done.docId)
            assertEquals(listOf(id), notified)
            assertTrue(done.notified && done.shown)
            assertEquals(InboxChip.BUILT_SKIPPED, InboxViewModel.itemOf(done, true, setOf(docId)).chip)
            assertEquals(docId, InboxViewModel.itemOf(done, true, setOf(docId)).openKey)
            // The shared files are no longer kept once the Mac has the document.
            assertTrue(File(root, id).listFiles()!!.map { it.name }.toSet() == setOf("request.json", "uploaded"))
            o.afterPull(index(), TestMac.MAC_ID)
            assertEquals(1, notified.size)
            assertFalse(o.active.first())
        }

    @Test fun `a status written by this phone or with a mismatched id is ignored`() =
        runTest {
            val o = outbox()
            val id = queue(o)
            o.upload()
            putStatus(id, JobState.DONE, dev = prefs.deviceId(), docId = "bbbbbbbb-0000-4000-8000-000000000001")
            o.afterPull(index(), TestMac.MAC_ID)
            assertNull(db.jobs().get(id)!!.remoteState)
            // A status file whose body names another job.
            val other = JobIds.new(now + 1)
            val body = SyncProtocol.encode(JobStatus.serializer(), JobStatus(1, other, "2026-11-08T10:00:00Z", JobState.QUEUED)).toByteArray()
            drive.put("jobstatus-$id.json", mapOf("k" to "status", "dev" to TestMac.MAC_ID, "s" to id), body)
            o.afterPull(index(), TestMac.MAC_ID)
            assertNull(db.jobs().get(id)!!.remoteState)
        }

    @Test fun `terminal jobs shown in the Inbox go into the acks file, and collected ones are forgotten`() =
        runTest {
            val o = outbox()
            val failed = queue(o)
            o.upload()
            putStatus(failed, JobState.REJECTED, code = "E_RATE", reason = "Too many jobs from your phone today")
            o.afterPull(index(), TestMac.MAC_ID)
            assertTrue(drive.byKind("acks").isEmpty())
            val item = InboxViewModel.itemOf(db.jobs().get(failed)!!, true)
            assertEquals(InboxChip.FAILED, item.chip)
            assertEquals("Too many jobs from your phone today", item.reason)
            assertTrue(item.canRetry && item.canDelete)

            o.markShown(listOf(failed))
            o.upload()
            val me = prefs.deviceId()
            val acks = drive.byKind("acks").single()
            assertEquals(mapOf("k" to "acks", "dev" to me), acks.meta.appProperties)
            assertEquals("acks-$me.json", acks.meta.name)
            assertEquals(listOf(failed), SyncProtocol.decodeAcks(acks.body.decodeToString()).terminalJobIds)
            // Unchanged: not rewritten.
            drive.calls.clear()
            o.upload()
            assertTrue("updateContent" !in drive.calls && "create" !in drive.calls)

            // Delete keeps a tombstone until the desktop collects the job files.
            o.delete(failed)
            assertTrue(db.jobs().get(failed)!!.hidden)
            assertTrue(db.jobs().observeVisible().first().isEmpty())
            o.afterPull(index(), TestMac.MAC_ID)
            assertNotNull(db.jobs().get(failed))
            drive.files.values.filter { it.meta.appProperties?.get("s") == failed }.map { it.meta.id }.forEach { drive.remove(it) }
            o.afterPull(index(), TestMac.MAC_ID)
            assertNull(db.jobs().get(failed))
            assertFalse(File(root, failed).exists())
            // The acks file drops it.
            assertEquals(emptyList<String>(), SyncProtocol.decodeAcks(drive.byKind("acks").single().body.decodeToString()).terminalJobIds)
        }

    @Test fun `retry sends the same capture under a new job id`() =
        runTest {
            val o = outbox()
            val id = queue(o)
            o.upload()
            putStatus(id, JobState.FAILED, code = "E_ATTACHMENT", reason = "An attachment didn’t arrive")
            o.afterPull(index(), TestMac.MAC_ID)
            now += 1000
            assertTrue(o.retry(id))
            val visible = db.jobs().observeVisible().first()
            assertEquals(1, visible.size)
            val again = visible.single()
            assertTrue(again.jobId != id)
            assertEquals(JobEntity.LOCAL, again.local)
            assertEquals(2, again.attachmentCount)
            assertTrue(db.jobs().get(id)!!.hidden)
            // A second tap does not send it twice.
            assertFalse(o.retry(id))
            assertEquals(1, db.jobs().observeVisible().first().size)
            o.upload()
            assertEquals(2, drive.byKind("job").size)
            // The attachments were already in the store.
            assertEquals(2, drive.byKind("att").size)
        }

    @Test fun `a deleted job stays hidden and acknowledged after a rebuild`() =
        runTest {
            val o = outbox()
            val id = queue(o)
            o.upload()
            putStatus(id, JobState.FAILED, code = "E_ATTACHMENT", reason = "An attachment didn’t arrive")
            o.afterPull(index(), TestMac.MAC_ID)
            o.delete(id)

            val fresh = inMemoryDb()
            try {
                val rebuilt = outbox(fresh)
                rebuilt.ensureRebuilt()
                val row = fresh.jobs().get(id)!!
                assertTrue(row.hidden && row.shown)
                assertTrue(fresh.jobs().observeVisible().first().isEmpty())
            } finally {
                fresh.close()
            }
        }

    @Test fun `the outbox rebuilds Room rows from its folders`() =
        runTest {
            val o = outbox()
            val waiting = queue(o)
            now += 1000
            val sent = queue(o)
            // Sent: mark only the second one as uploaded on disk.
            File(root, "$sent/${OutboxRepository.UPLOADED_MARKER}").createNewFile()
            // An abandoned staging folder (no request) older than a day is cleared; a fresh one is kept.
            val stale = File(root, JobIds.new(now - 10_000)).apply { mkdirs() }
            File(stale, "abc").writeText("x")
            stale.setLastModified(now - OutboxRepository.STAGING_TTL_MS - 1)
            val fresh = File(root, JobIds.new(now)).apply { mkdirs() }
            fresh.setLastModified(now)

            val fresh2 = inMemoryDb()
            try {
                val rebuilt = outbox(fresh2)
                rebuilt.ensureRebuilt()
                assertEquals(JobEntity.LOCAL, fresh2.jobs().get(waiting)!!.local)
                assertEquals(JobEntity.UPLOADED, fresh2.jobs().get(sent)!!.local)
                assertEquals(2, fresh2.jobs().attachments(waiting).size)
                assertFalse(stale.exists())
                assertTrue(fresh.exists())
            } finally {
                fresh2.close()
            }
        }

    @Test fun `a pull hands its index to the outbox`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val o = outbox()
            val repo =
                SyncRepository(
                    db = db,
                    index = LibraryIndex(db, store),
                    store = store,
                    drive = drive,
                    prefs = prefs,
                    deviceWriter = DeviceWriter(drive, prefs, "Pixel 9", "0.1.0", now = { now }),
                    authState = { auth },
                    now = { now },
                    jobs = o,
                )
            TestMac(drive).bootstrap()
            val id = queue(o)
            o.upload()
            putStatus(id, JobState.QUEUED)
            assertEquals(SyncOutcome.Synced, repo.sync())
            assertEquals("queued", db.jobs().get(id)!!.remoteState)
            assertEquals(InboxChip.QUEUED, InboxViewModel.itemOf(db.jobs().get(id)!!, true).chip)
        }

    @Test fun `make current queues a checkout job that uploads as a job file`() =
        runTest {
            val o = outbox()
            val doc = "3f2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b"
            val row = o.queueCheckout(doc, "v-000000000002", "Budgets · Original")
            assertEquals("checkout", row.kind)
            assertEquals("Budgets · Original", row.title)
            assertEquals(0, row.attachmentCount)
            val req = SyncProtocol.decodeJob(File(File(root, row.jobId), OutboxRepository.REQUEST).readText()) as JobRequest.Checkout
            assertEquals(doc, req.docId)
            assertEquals("v-000000000002", req.versionId)
            assertEquals(prefs.deviceId(), req.deviceId)
            assertTrue(drive.calls.isEmpty())

            assertEquals(SyncOutcome.Synced, o.upload())
            assertEquals(listOf("job"), kindsInOrder())
            val job = drive.byKind("job").single()
            assertEquals(row.jobId, job.meta.appProperties?.get("s"))
            assertTrue(SyncProtocol.decodeJob(job.body.decodeToString()) is JobRequest.Checkout)
            assertEquals(JobEntity.UPLOADED, db.jobs().get(row.jobId)!!.local)
        }

    @Test fun `an ask carries the section and its hash, and invalid ones are refused before queueing`() =
        runTest {
            val o = outbox()
            val doc = "3f2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b"
            val row = o.queueAsk(doc, "sec-indepth-001ce0e7", "a".repeat(64), "Why does ROAS matter?", "Why does ROAS matter?")
            val req = SyncProtocol.decodeJob(File(File(root, row.jobId), OutboxRepository.REQUEST).readText()) as JobRequest.Ask
            assertEquals("sec-indepth-001ce0e7", req.sectionId)
            assertEquals("a".repeat(64), req.sectionHash)
            assertEquals("ask", row.kind)

            val before = db.jobs().count()
            assertThrowsSuspend { o.queueAsk(doc, "sec-indepth-001ce0e7", "a".repeat(64), "two\nlines", "x") }
            assertThrowsSuspend { o.queueCheckout(doc, "not-a-version", "x") }
            assertEquals(before, db.jobs().count())
        }

    private suspend fun assertThrowsSuspend(block: suspend () -> Unit) {
        val thrown =
            try {
                block()
                false
            } catch (_: io.github.eli5learner.sync.protocol.ProtocolException) {
                true
            }
        assertTrue("expected a ProtocolException", thrown)
    }

    private companion object {
        const val NOW = 1_800_000_100_000L
        val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)
        val PDF = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".toByteArray()
    }
}
