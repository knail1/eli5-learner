package io.github.eli5learner

import android.app.Application
import io.github.eli5learner.sync.SyncRunner
import io.github.eli5learner.sync.SyncRunnerProvider

class Eli5App :
    Application(),
    SyncRunnerProvider {
    val container: AppContainer by lazy { AppContainer(this) }

    /** What [io.github.eli5learner.sync.SyncWorker] runs. */
    override val syncRunner: SyncRunner get() = container.syncRepository
}
