package io.github.eli5learner.capture

import android.net.Uri
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.AppPreferences
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.data.db.JobEntity
import io.github.eli5learner.inMemoryDb
import io.github.eli5learner.inbox.OutboxRepository
import io.github.eli5learner.sync.FakeDrive
import io.github.eli5learner.sync.MacInfo
import io.github.eli5learner.sync.SyncStatus
import io.github.eli5learner.sync.protocol.FocusChip
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.sync.protocol.JobRequest
import io.github.eli5learner.sync.protocol.Limits
import io.github.eli5learner.sync.protocol.SyncProtocol
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The capture sheet's model (16 §5.2 step 1): staging, caps, sniffing, and queueing on Send. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CaptureViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var outbox: OutboxRepository
    private lateinit var root: File
    private val files = HashMap<Uri, SharedFile>()

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        db = inMemoryDb()
        root = tmp.newFolder("outbox")
        val prefs = AppPreferences.create(File(tmp.root, "p.preferences_pb"))
        outbox = OutboxRepository(db, root, FakeDrive(), prefs, { AuthState.Disconnected })
    }

    @After fun tearDown() {
        db.close()
        Dispatchers.resetMain()
    }

    private fun share(
        n: Int,
        name: String?,
        bytes: ByteArray,
        type: String? = null,
    ): Uri {
        val u = Uri.parse("content://com.example/f/$n")
        files[u] = SharedFile(name, type, bytes)
        return u
    }

    private fun vm(
        input: ShareInput,
        sync: SyncStatus = SyncStatus(),
        auth: AuthState = AuthState.Connected("reader@example.com"),
    ) = CaptureViewModel(input, outbox, { files[it] }, flowOf(auth), flowOf(sync))

    /** Real time: staging runs on Dispatchers.IO, which the test scheduler's virtual clock does not wait for. */
    private suspend fun CaptureViewModel.loaded(): CaptureUiState = withContext(Dispatchers.Default) { withTimeout(10_000) { state.first { !it.loading } } }

    @Test fun `files are copied at once, too large, wrong type and duplicates are refused`() =
        runTest {
            val png = PNG
            val pdfAsImage = "%PDF-1.7 real pdf".toByteArray()
            val exe = byteArrayOf(0x4D, 0x5A, 0, 0)
            val big = ByteArray((Limits.ATTACHMENT_BYTES + 1).toInt())
            val input =
                ShareInput(
                    streams =
                        listOf(
                            share(1, "a.png", png, "image/png"),
                            share(2, "b.png", pdfAsImage, "image/png"),
                            share(3, "c.pdf", exe, "application/pdf"),
                            share(4, "d.png", big, "image/png"),
                            share(5, "dup.png", png, "image/png"),
                        ),
                )
            val m = vm(input)
            val s = m.loaded()
            assertEquals(listOf("a.png", "b.png.pdf"), s.files.map { it.name })
            assertEquals(listOf(MimeSniffer.PNG, MimeSniffer.PDF), s.files.map { it.mime })
            assertEquals(listOf(Refusal("c.pdf", RefusalReason.TYPE), Refusal("d.png", RefusalReason.TOO_LARGE)), s.refusals)
            // The bytes are in the outbox before anything is sent.
            assertTrue(s.files.all { File(root, "${m.jobId}/${it.sha}").isFile })
            assertTrue(s.canSend)
        }

    @Test fun `the content reader refuses file URIs and URIs this app serves`() {
        val resolver = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        val own = Uri.parse("content://io.github.eli5learner.internal/secret")
        val reader = CaptureViewModel.contentReader(resolver) { it.authority == own.authority }
        assertEquals(null, reader.read(own))
        assertEquals(null, reader.read(Uri.parse("file:///data/data/io.github.eli5learner/files/x")))
    }

    @Test fun `more than ten files or fifty megabytes are refused beyond the cap`() =
        runTest {
            val streams = (1..12).map { share(it, "p$it.png", PNG + byteArrayOf(it.toByte())) }
            val s = vm(ShareInput(streams = streams)).loaded()
            assertEquals(Limits.ATTACHMENTS, s.files.size)
            assertEquals(2, s.refusals.count { it.reason == RefusalReason.TOO_MANY })

            val nineteen = 19 * 1024 * 1024
            val big = (1..3).map { i -> share(100 + i, "big$i.pdf", "%PDF-".toByteArray() + ByteArray(nineteen) { i.toByte() }) }
            val t = vm(ShareInput(streams = big)).loaded()
            assertEquals(2, t.files.size)
            assertEquals(listOf(Refusal("big3.pdf", RefusalReason.JOB_TOO_LARGE)), t.refusals)
        }

    @Test fun `Send queues the capture with the question and focus, without the network`() =
        runTest {
            val m =
                vm(
                    ShareInput(text = "Worth a look https://example.com/a", subject = "Example", streams = listOf(share(1, "x.png", PNG))),
                    auth = AuthState.Disconnected,
                )
            val s = m.loaded()
            assertFalse(s.connected)
            m.setClarifyingInput("Why does it matter?" + "!".repeat(600))
            m.toggleFocus(FocusChip.NUMBERS)
            m.toggleFocus(FocusChip.BIG_PICTURE)
            m.toggleFocus(FocusChip.NUMBERS)
            m.send()
            val e = withContext(Dispatchers.Default) { withTimeout(10_000) { m.messages.first() } }
            assertEquals(CaptureEvent.Sent(askNotifications = false), e)

            val row = db.jobs().get(m.jobId)!!
            assertEquals(JobEntity.LOCAL, row.local)
            assertEquals("Example", row.title)
            val req = SyncProtocol.decodeJob(File(root, "${m.jobId}/request.json").readText()) as JobRequest.Capture
            assertEquals(listOf("https://example.com/a"), req.urls)
            assertEquals(Limits.CLARIFYING_INPUT_CHARS, req.clarifyingInput.length)
            assertEquals(listOf(FocusChip.BIG_PICTURE), req.focus)
            assertEquals(1, req.attachments.size)
        }

    @Test fun `a paused Mac is noted, nothing to send disables Send`() =
        runTest {
            val mac = MacInfo("Studio", 1L, InboxState.OFF, listOf(JobKind.CAPTURE))
            val s = vm(ShareInput(text = "   "), sync = SyncStatus(mac = mac)).loaded()
            assertTrue(s.macPaused)
            assertFalse(s.canSend)
        }
}

private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00)
