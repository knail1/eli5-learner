package io.github.eli5learner.inbox

import io.github.eli5learner.data.db.JobEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** How each job state reads in the Inbox (16 §6.2). */
class InboxViewModelTest {
    private val base = JobEntity(jobId = "j", kind = "capture", createdAt = 1, title = "t")

    @Test fun `chips follow the local and remote state`() {
        assertEquals(InboxChip.CONNECT_TO_SEND, InboxViewModel.itemOf(base, connected = false).chip)
        assertEquals(InboxChip.WAITING_TO_UPLOAD, InboxViewModel.itemOf(base, connected = true).chip)
        val up = base.copy(local = JobEntity.UPLOADED)
        assertEquals(InboxChip.WAITING_FOR_MAC, InboxViewModel.itemOf(up, true).chip)
        assertEquals(InboxChip.WAITING_FOR_MAC, InboxViewModel.itemOf(up.copy(remoteState = "received"), true).chip)
        assertEquals(InboxChip.QUEUED, InboxViewModel.itemOf(up.copy(remoteState = "queued"), true).chip)
        val running = InboxViewModel.itemOf(up.copy(remoteState = "running", stage = "Writing"), true)
        assertEquals(InboxChip.GENERATING, running.chip)
        assertEquals("Writing", running.stage)
        assertFalse("a running job cannot be cancelled", running.canCancel)
        assertEquals(InboxChip.READY, InboxViewModel.itemOf(up.copy(remoteState = "done", docId = "d"), true).chip)
        assertNull("not in the library yet", InboxViewModel.itemOf(up.copy(remoteState = "done", docId = "d"), true).openKey)
        val failed = InboxViewModel.itemOf(up.copy(remoteState = "failed", code = "E_X", reason = "No"), true)
        assertEquals(InboxChip.FAILED, failed.chip)
        assertTrue(failed.canRetry && failed.canDelete && failed.terminal)
        assertEquals(InboxChip.FAILED, InboxViewModel.itemOf(base.copy(local = JobEntity.BROKEN), true).chip)
        assertEquals(InboxChip.CANCELLED, InboxViewModel.itemOf(base.copy(local = JobEntity.CANCELLED), true).chip)
        assertTrue(InboxViewModel.itemOf(base, true).canCancel)
        assertTrue(InboxViewModel.itemOf(up.copy(remoteState = "queued"), true).canCancel)
    }
}
