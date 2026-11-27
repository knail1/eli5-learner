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
import kotlinx.coroutines.flow.MutableStateFlow
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

    /** The Inbox's "Send a link": nothing shared, the link is typed. */
    private fun linkVm(
        sync: SyncStatus = SyncStatus(mac = mac("0.6.0")),
        auth: AuthState = AuthState.Connected("reader@example.com"),
    ) = CaptureViewModel(ShareInput(), outbox, { files[it] }, flowOf(auth), flowOf(sync), manual = true)

    private fun mac(version: String?) = MacInfo("Studio", 1L, InboxState.ON, listOf(JobKind.CAPTURE), appVersion = version)

    private suspend fun CaptureViewModel.sendAndWait(): CaptureEvent {
        send()
        return withContext(Dispatchers.Default) { withTimeout(10_000) { messages.first() } }
    }

    private fun request(m: CaptureViewModel): JobRequest.Capture = SyncProtocol.decodeJob(File(root, "${m.jobId}/request.json").readText()) as JobRequest.Capture

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

    @Test fun `Send a link starts empty and ready, the typed link is normalised and enables Send`() =
        runTest {
            val m = linkVm()
            val s0 = m.state.value
            assertFalse("nothing to copy, so no spinner", s0.loading)
            assertTrue(s0.manual)
            assertFalse(s0.canSend)
            assertFalse("an empty field is not an error", s0.linkInvalid)

            m.setLinkInput("  HTTPS://Example.COM/a?q=ü  ")
            val s = m.state.value
            assertEquals(listOf("https://example.com/a?q=%C3%BC"), s.urls)
            assertTrue(s.canSend)
            assertFalse(s.linkInvalid)

            // A bare host gets https://.
            m.setLinkInput("example.org/page")
            assertEquals(listOf("https://example.org/page"), m.state.value.urls)
        }

    @Test fun `a bad, file or user-name link is refused and Send stays off`() =
        runTest {
            val m = linkVm()
            val bad =
                listOf(
                    "not a link",
                    "file:///sdcard/secret.txt",
                    "content://io.github.eli5learner.internal/x",
                    "javascript:alert(1)",
                    "https://" + listOf("user", "pw").joinToString(":") + "@example.com/",
                    "https://user@example.com/",
                    "ftp://example.com/x",
                    "https://bad_host!.example/",
                )
            for (b in bad) {
                val fresh = linkVm()
                fresh.setLinkInput(b)
                assertFalse("not an error while typing: $b", fresh.state.value.linkInvalid)
                m.setLinkInput(b)
                m.finishLinkInput()
                val s = m.state.value
                assertEquals(b, emptyList<String>(), s.urls)
                assertTrue(b, s.linkInvalid)
                assertFalse(b, s.canSend)
            }
            m.setLinkInput("https://user@example.com/")
            assertEquals("a user name is counted as a refused link", 1, m.state.value.refusedUrls)
            // Fixing the link clears the error.
            m.setLinkInput("https://example.com/")
            assertFalse(m.state.value.linkInvalid)
            assertEquals(0, m.state.value.refusedUrls)
        }

    @Test fun `a half-typed link is not an error until the field is done`() =
        runTest {
            val m = linkVm()
            for (partial in listOf("h", "ht", "https:/", "https://", "example")) {
                m.setLinkInput(partial)
                assertFalse(partial, m.state.value.linkInvalid)
                assertFalse(partial, m.state.value.canSend)
            }
            m.finishLinkInput()
            assertTrue("done with a link that cannot be sent", m.state.value.linkInvalid)
            m.setLinkInput("example.com")
            assertFalse(m.state.value.linkInvalid)
            // A shared capture has no link field.
            val shared = vm(ShareInput(text = "https://example.com/shared"))
            shared.finishLinkInput()
            assertFalse(shared.state.value.linkTouched)
        }

    @Test fun `a cold start uses the remembered Mac version, then the pass's`() =
        runTest {
            val status = MutableStateFlow(SyncStatus())
            fun coldVm(remembered: String?) =
                CaptureViewModel(
                    ShareInput(text = "https://example.com/a"),
                    outbox,
                    { files[it] },
                    flowOf(AuthState.Connected("reader@example.com")),
                    status,
                    lastMacVersion = { remembered },
                )

            // Nothing read and nothing remembered: unknown, not "too old".
            val unknown = coldVm(null)
            unknown.loaded()
            assertFalse(unknown.state.value.deadpanAvailable)
            assertTrue(unknown.state.value.macVersionUnknown)
            // The pass reads a 0.6.0 Mac: Deadpan turns on.
            status.value = SyncStatus(mac = mac("0.6.0"))
            assertTrue(unknown.state.value.deadpanAvailable)
            assertFalse(unknown.state.value.macVersionUnknown)

            // A 0.6.0 Mac remembered from an earlier pass: available before this process's first pass.
            status.value = SyncStatus()
            val remembered = coldVm("0.6.0")
            remembered.loaded()
            assertTrue(remembered.state.value.deadpanAvailable)
            assertFalse(remembered.state.value.macVersionUnknown)
            remembered.toggleDeadpan()
            remembered.sendAndWait()
            assertTrue(request(remembered).deadpan)

            // The pass wins over what was remembered: the Mac went back to 0.5.0.
            val stale = coldVm("0.6.0")
            status.value = SyncStatus(mac = mac("0.5.0"))
            assertFalse(stale.state.value.deadpanAvailable)
            assertFalse(stale.state.value.macVersionUnknown)
        }

    @Test fun `a typed link with instructions is queued as a capture, labelled by its host`() =
        runTest {
            val m = linkVm()
            m.setLinkInput("https://news.example/story")
            m.setClarifyingInput("  Explain this for a beginner, focus on costs  ")
            m.toggleFocus(FocusChip.BEGINNER)
            assertEquals(CaptureEvent.Sent(askNotifications = false), m.sendAndWait())
            val req = request(m)
            assertEquals(listOf("https://news.example/story"), req.urls)
            assertEquals("", req.text)
            assertEquals("Explain this for a beginner, focus on costs", req.clarifyingInput)
            assertEquals(listOf(FocusChip.BEGINNER), req.focus)
            assertTrue(req.attachments.isEmpty())
            assertFalse("off unless asked", req.deadpan)
            assertEquals("news.example", db.jobs().get(m.jobId)!!.title)
        }

    @Test fun `deadpan is sent only when the Mac is 0_6_0 or later`() =
        runTest {
            val cases =
                listOf(
                    SyncStatus(mac = mac("0.6.0")) to true,
                    SyncStatus(mac = mac("0.10.1")) to true,
                    SyncStatus(mac = mac("0.6.0-beta.1")) to true,
                    SyncStatus(mac = mac("0.5.0")) to false,
                    SyncStatus(mac = mac(null)) to false,
                    SyncStatus(mac = mac("0")) to false,
                    SyncStatus() to false,
                )
            for ((sync, expected) in cases) {
                val m = linkVm(sync = sync)
                assertEquals("${sync.mac?.appVersion}", expected, m.state.value.deadpanAvailable)
                m.setLinkInput("https://example.com/a")
                m.toggleDeadpan()
                assertTrue(m.state.value.deadpan)
                assertEquals(expected, m.state.value.sendsDeadpan)
                m.sendAndWait()
                assertEquals("${sync.mac?.appVersion}", expected, request(m).deadpan)
                val raw = File(root, "${m.jobId}/request.json").readText()
                assertEquals(expected, "\"deadpan\"" in raw)
            }
            // Toggled back off: not sent.
            val off = linkVm()
            off.setLinkInput("https://example.com/b")
            off.toggleDeadpan()
            off.toggleDeadpan()
            off.sendAndWait()
            assertFalse(request(off).deadpan)
        }

    @Test fun `a shared capture can ask for Deadpan too`() =
        runTest {
            val m = vm(ShareInput(text = "https://example.com/shared"), sync = SyncStatus(mac = mac("0.6.0")))
            m.loaded()
            m.toggleDeadpan()
            m.sendAndWait()
            assertTrue(request(m).deadpan)
        }

    @Test fun `the link field only works in Send a link mode`() =
        runTest {
            val m = vm(ShareInput(text = "https://example.com/shared"))
            m.loaded()
            m.setLinkInput("https://elsewhere.example/")
            assertEquals(listOf("https://example.com/shared"), m.state.value.urls)
        }

    @Test fun `dismissing discards the job, so nothing is queued`() =
        runTest {
            val m = linkVm()
            m.setLinkInput("https://example.com/a")
            m.dismiss()
            assertEquals(null, db.jobs().get(m.jobId))
            assertFalse(File(root, m.jobId).exists())
            assertTrue(db.jobs().observeVisible().first().isEmpty())

            // A shared file staged and then dismissed goes too.
            val shared = vm(ShareInput(streams = listOf(share(1, "x.png", PNG))))
            shared.loaded()
            assertTrue(File(root, shared.jobId).isDirectory)
            shared.dismiss()
            assertFalse(File(root, shared.jobId).exists())
            assertEquals(null, db.jobs().get(shared.jobId))
        }
}

private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00)
