package io.github.eli5learner

import android.app.Application
import io.github.eli5learner.inbox.UploadRunner
import io.github.eli5learner.inbox.UploadRunnerProvider
import io.github.eli5learner.sync.SyncOutcome
import io.github.eli5learner.sync.SyncRunner
import io.github.eli5learner.sync.SyncRunnerProvider

class Eli5App :
    Application(),
    SyncRunnerProvider,
    UploadRunnerProvider {
    val container: AppContainer by lazy { AppContainer(this) }

    /** What [io.github.eli5learner.sync.SyncWorker] runs. */
    override val syncRunner: SyncRunner get() = container.syncRepository

    /** What [io.github.eli5learner.inbox.UploadWorker] runs: the upload, then a pull so statuses arrive soon (16 §4.8). */
    override val uploadRunner: UploadRunner
        get() =
            UploadRunner {
                container.outbox.upload().also { if (it == SyncOutcome.Synced) container.syncScheduler.expedite() }
            }
}
