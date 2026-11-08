package io.github.eli5learner.sync

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import io.github.eli5learner.auth.AuthState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * When the phone pulls (16 §4.8): on app foreground (at most every 30 s), on pull-to-refresh and Sync
 * now, and from WorkManager every 15 minutes on a connected network (unique, `KEEP`). Connecting
 * schedules the periodic work and pulls at once; disconnecting cancels it and forgets the remote
 * index ([SyncRepository.forget]). Foreground pulls run in the app scope, so leaving a screen does
 * not cancel them. Nothing is scheduled in local mode.
 */
class SyncScheduler(
    private val repository: SyncRepository,
    /** Null when WorkManager is not available (some test environments). */
    private val workManager: () -> WorkManager?,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Volatile private var lastForeground = Long.MIN_VALUE / 2
    private var watching: Job? = null

    /** Follows the grant: schedule on connect, cancel and forget on disconnect. Idempotent. */
    @Synchronized
    fun start(auth: Flow<AuthState>) {
        if (watching != null) return
        watching =
            scope.launch {
                var previous: AuthState = AuthState.Unknown
                auth.collect { s ->
                    when (s) {
                        is AuthState.Connected ->
                            if (previous !is AuthState.Connected) {
                                // A fresh Connect, or a reconnect to another account: the cursors,
                                // remote index and device list belong to the old grant (16 §3.3).
                                if (previous == AuthState.Disconnected || isOtherAccount(previous, s)) repository.forget()
                                schedulePeriodic()
                                onForeground()
                            }
                        AuthState.Disconnected ->
                            if (previous is AuthState.Connected || previous is AuthState.NeedsReconnect) {
                                cancel()
                                repository.forget()
                            }
                        else -> Unit
                    }
                    if (s != AuthState.Connecting && s != AuthState.Unknown) previous = s
                }
            }
    }

    private fun isOtherAccount(
        previous: AuthState,
        now: AuthState.Connected,
    ): Boolean {
        val before = (previous as? AuthState.NeedsReconnect)?.email ?: return false
        val after = now.email ?: return false
        return !before.equals(after, ignoreCase = true)
    }

    /** The app came to the foreground: pull, at most once per [FOREGROUND_MIN_MS]. */
    fun onForeground() {
        val t = now()
        if (t - lastForeground < FOREGROUND_MIN_MS) return
        lastForeground = t
        syncNow()
    }

    /** Pull-to-refresh and Sync now: pull at once. */
    fun syncNow(): Job =
        scope.launch {
            lastForeground = now()
            repository.sync()
        }

    /** Expedited one-time work, for when the app may go to the background right away (after queueing a job). */
    fun expedite() {
        workManager()?.enqueueUniqueWork(ONE_TIME, ExistingWorkPolicy.KEEP, oneTimeRequest())
    }

    fun schedulePeriodic() {
        workManager()?.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodicRequest())
    }

    fun cancel() {
        workManager()?.let {
            it.cancelUniqueWork(PERIODIC)
            it.cancelUniqueWork(ONE_TIME)
        }
    }

    companion object {
        const val PERIODIC = "eli5-sync-periodic"
        const val ONE_TIME = "eli5-sync-now"
        const val FOREGROUND_MIN_MS = 30_000L

        private val CONNECTED = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun periodicRequest(): PeriodicWorkRequest =
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(CONNECTED)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

        fun oneTimeRequest(): OneTimeWorkRequest =
            OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(CONNECTED)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
    }
}
