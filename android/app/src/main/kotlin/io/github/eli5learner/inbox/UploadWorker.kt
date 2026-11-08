package io.github.eli5learner.inbox

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.eli5learner.sync.SyncOutcome
import io.github.eli5learner.sync.SyncWorker
import java.util.concurrent.TimeUnit

/** One outbox upload, then whatever should follow it (a pull, so statuses arrive soon). */
fun interface UploadRunner {
    suspend fun runUpload(): SyncOutcome
}

/** Implemented by the Application so the worker finds the app's [UploadRunner] without a custom factory. */
interface UploadRunnerProvider {
    val uploadRunner: UploadRunner
}

/**
 * Uploads the outbox (16 §5.2 step 2): expedited, on any connected network, unique and appended
 * after a running upload, so a capture queued while another uploads is never skipped. Results map
 * like the sync worker's: a lost grant stops, network trouble retries with backoff.
 */
class UploadWorker(
    context: Context,
    params: WorkerParameters,
    private val runner: UploadRunner?,
) : CoroutineWorker(context, params) {
    /** The constructor WorkManager's default factory calls. */
    constructor(context: Context, params: WorkerParameters) : this(context, params, null)

    override suspend fun doWork(): Result {
        val r = runner ?: (applicationContext as? UploadRunnerProvider)?.uploadRunner ?: return Result.failure()
        return SyncWorker.resultOf(r.runUpload(), runAttemptCount)
    }

    companion object {
        const val UNIQUE = "eli5-outbox-upload"

        fun request(): OneTimeWorkRequest =
            OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

        /** Queues an upload after any running one. A no-op where WorkManager is not available. */
        fun enqueue(workManager: WorkManager?) {
            workManager?.enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.APPEND_OR_REPLACE, request())
        }
    }
}
