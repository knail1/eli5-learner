package io.github.eli5learner.versions

import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.VersionEntity
import io.github.eli5learner.sync.MacInfo
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.JobKind
import io.github.eli5learner.sync.protocol.ProtocolException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The Versions sheet's state (16 §6.2): lanes, preview availability and "Make current on your Mac". */
@OptIn(ExperimentalCoroutinesApi::class)
class VersionsViewModelTest {
    private val docId = "3f2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b"
    private val doc =
        DocEntry(
            key = docId,
            sha = "c".repeat(64),
            title = "Budgets",
            docId = docId,
            foreign = false,
            updatedAt = 1,
            source = DocumentEntity.SOURCE_SYNCED,
            remoteSha = "c".repeat(64),
            currentVersionId = "v-000000000003",
        )

    private fun v(
        n: Int,
        parent: Int?,
        uploaded: Boolean,
        sha: String? = n.toString().repeat(64),
    ) = VersionEntity(
        docId = docId,
        id = "v-%012x".format(n),
        parentId = parent?.let { "v-%012x".format(it) },
        kind = if (n == 1) "initial" else "expand",
        label = if (n == 1) "Original" else "Expanded $n",
        createdAt = "2026-10-01T09:0$n:00.000Z",
        sha = sha,
        uploaded = uploaded,
        position = n,
    )

    private val versions =
        listOf(
            v(1, null, uploaded = true),
            v(2, 1, uploaded = false),
            v(3, 2, uploaded = true, sha = "c".repeat(64)),
            v(4, 1, uploaded = false, sha = null),
        )
    private val mac = MacInfo("Studio", 1, InboxState.ON, listOf(JobKind.CAPTURE, JobKind.CHECKOUT))

    private inner class Fake : VersionsDeps {
        override val doc = MutableStateFlow<DocEntry?>(this@VersionsViewModelTest.doc)
        override val versions = MutableStateFlow(this@VersionsViewModelTest.versions)
        override val mac = MutableStateFlow<MacInfo?>(this@VersionsViewModelTest.mac)
        val onPhoneShas = mutableSetOf<String>()
        val checkouts = mutableListOf<Triple<String, String, String>>()
        var fail = false

        override fun onPhone(sha: String) = sha in onPhoneShas

        override suspend fun checkout(
            docId: String,
            versionId: String,
            title: String,
        ) {
            if (fail) throw ProtocolException("bad version id")
            checkouts += Triple(docId, versionId, title)
        }
    }

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `rows follow the shared layout and only uploaded versions can be previewed`() {
        val s = VersionsViewModel.stateOf(doc, versions, mac, emptySet()) { false }
        assertEquals(listOf("v-000000000001", "v-000000000004", "v-000000000002", "v-000000000003"), s.items.map { it.row.id })
        val byId = s.items.associateBy { it.row.id }
        assertTrue(byId.getValue("v-000000000001").available)
        assertFalse("not uploaded: Not available on this phone", byId.getValue("v-000000000002").available)
        assertFalse("no sha at all", byId.getValue("v-000000000004").available)
        assertTrue(byId.getValue("v-000000000003").row.isCurrent)
        assertTrue(s.canCheckout)
        assertFalse(s.macNotTaking)

        // A version the phone already has (the current copy) stays readable even when not uploaded.
        val onPhone = VersionsViewModel.stateOf(doc, versions, mac, emptySet()) { it == "2".repeat(64) }
        assertTrue(onPhone.items.single { it.row.id == "v-000000000002" }.available)
    }

    @Test fun `make current is offered only when the Mac accepts checkouts`() {
        val captureOnly = mac.copy(accepts = listOf(JobKind.CAPTURE))
        assertFalse(VersionsViewModel.stateOf(doc, versions, captureOnly, emptySet()) { false }.canCheckout)
        assertFalse(VersionsViewModel.stateOf(doc, versions, null, emptySet()) { false }.canCheckout)
        val paused = VersionsViewModel.stateOf(doc, versions, mac.copy(inbox = InboxState.OFF), emptySet()) { false }
        assertTrue(paused.canCheckout && paused.macNotTaking)
        // An imported document has no versions from the Mac.
        val imported = VersionsViewModel.stateOf(doc.copy(source = DocumentEntity.SOURCE_IMPORTED), versions, mac, emptySet()) { false }
        assertTrue(imported.items.isEmpty())
        assertFalse(imported.canCheckout)
    }

    @Test fun `checkout queues a job for the chosen version, never for the current one`() =
        runTest {
            val deps = Fake()
            val vm = VersionsViewModel(deps)
            vm.checkout("v-000000000003")
            assertTrue(deps.checkouts.isEmpty())
            vm.checkout("v-000000000001")
            assertEquals(listOf(Triple(docId, "v-000000000001", "Budgets · Original")), deps.checkouts)
            assertEquals(VersionsEvent.CheckoutQueued, withTimeout(1_000) { vm.messages.first() })

            deps.fail = true
            vm.checkout("v-000000000002")
            assertEquals(VersionsEvent.CheckoutFailed, withTimeout(1_000) { vm.messages.first() })

            deps.mac.value = mac.copy(accepts = listOf(JobKind.CAPTURE))
            deps.fail = false
            vm.checkout("v-000000000001")
            assertEquals(1, deps.checkouts.size)
        }

    @Test fun `preview opens uploaded versions and collapse hides branches`() =
        runTest {
            val deps = Fake()
            val vm = VersionsViewModel(deps)
            vm.preview("v-000000000002")
            vm.preview("v-000000000001")
            assertEquals(VersionsEvent.Preview("v-000000000001", "1".repeat(64), "Original"), withTimeout(1_000) { vm.messages.first() })

            assertEquals(4, vm.state.value.items.size)
            vm.toggle("v-000000000001")
            assertEquals(listOf("v-000000000001", "v-000000000002", "v-000000000003"), vm.state.value.items.map { it.row.id })
            vm.toggle("v-000000000001")
            assertEquals(4, vm.state.value.items.size)
        }
}
