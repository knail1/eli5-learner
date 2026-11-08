package io.github.eli5learner.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/** Implemented by the Application so the worker finds the app's [SyncRunner] without a custom factory. */
interface SyncRunnerProvider {
    val syncRunner: SyncRunner
}

/**
 * One background pull (16 §4.8): the periodic request and the expedited one-time requests run this.
 * A lost grant ends the work without retries, since only the user can fix it ("Sign in again"); a
 * transient failure retries with WorkManager's backoff, a few times at most.
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters,
    private val runner: SyncRunner?,
) : CoroutineWorker(context, params) {
    /** The constructor WorkManager's default factory calls. */
    constructor(context: Context, params: WorkerParameters) : this(context, params, null)

    override suspend fun doWork(): Result {
        val r = runner ?: (applicationContext as? SyncRunnerProvider)?.syncRunner ?: return Result.failure()
        return resultOf(r.runSync(), runAttemptCount)
    }

    companion object {
        const val MAX_RETRIES = 5

        fun resultOf(
            outcome: SyncOutcome,
            attempt: Int,
        ): Result =
            when (outcome) {
                SyncOutcome.Synced, SyncOutcome.NotConnected, SyncOutcome.FormatTooNew -> Result.success()
                SyncOutcome.NeedsReconnect, is SyncOutcome.Failed -> Result.failure()
                is SyncOutcome.Transient -> if (attempt < MAX_RETRIES) Result.retry() else Result.failure()
            }
    }
}
