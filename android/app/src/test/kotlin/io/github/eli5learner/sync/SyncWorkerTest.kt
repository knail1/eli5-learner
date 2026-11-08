package io.github.eli5learner.sync

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.eli5learner.drive.SyncErrorCode
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

/** The sync worker and its schedule (16 §4.8) under the WorkManager test driver. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SyncWorkerTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private var outcome: SyncOutcome = SyncOutcome.Synced
    private var runs = 0

    private val runner =
        SyncRunner {
            runs++
            outcome
        }

    private val factory =
        object : WorkerFactory() {
            override fun createWorker(
                appContext: Context,
                workerClassName: String,
                workerParameters: WorkerParameters,
            ): ListenableWorker = SyncWorker(appContext, workerParameters, runner)
        }

    @Before fun setUp() {
        val config =
            Configuration
                .Builder()
                .setMinimumLoggingLevel(Log.DEBUG)
                .setExecutor(SynchronousExecutor())
                .setWorkerFactory(factory)
                .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
    }

    private fun worker(attempt: Int = 0): SyncWorker =
        TestListenableWorkerBuilder<SyncWorker>(context)
            .setWorkerFactory(factory)
            .setRunAttemptCount(attempt)
            .build()

    @Test fun `outcomes map to success, retry or failure`() =
        runTest {
            outcome = SyncOutcome.Synced
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            outcome = SyncOutcome.NotConnected
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            outcome = SyncOutcome.FormatTooNew
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            outcome = SyncOutcome.Transient(SyncErrorCode.E_SYNC_HTTP)
            assertEquals(ListenableWorker.Result.retry(), worker().doWork())
            assertEquals(ListenableWorker.Result.failure(), worker(attempt = SyncWorker.MAX_RETRIES).doWork())
            outcome = SyncOutcome.NeedsReconnect
            assertEquals(ListenableWorker.Result.failure(), worker().doWork())
            outcome = SyncOutcome.Failed(SyncErrorCode.E_SYNC_QUOTA)
            assertEquals(ListenableWorker.Result.failure(), worker().doWork())
        }

    @Test fun `NeedsReconnect stops the one-time work without retries`() {
        outcome = SyncOutcome.NeedsReconnect
        val wm = WorkManager.getInstance(context)
        val request = SyncScheduler.oneTimeRequest()
        wm.enqueue(request).result.get()
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(request.id)
        val info = wm.getWorkInfoById(request.id).get()!!
        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals(1, runs)
    }

    @Test fun `a transient failure is retried`() {
        outcome = SyncOutcome.Transient(SyncErrorCode.E_SYNC_HTTP)
        val wm = WorkManager.getInstance(context)
        val request = SyncScheduler.oneTimeRequest()
        wm.enqueue(request).result.get()
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(request.id)
        val info = wm.getWorkInfoById(request.id).get()!!
        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(1, info.runAttemptCount)
    }

    @Test fun `the periodic request runs every 15 minutes on a connected network and is unique`() {
        val req = SyncScheduler.periodicRequest()
        assertEquals(TimeUnit.MINUTES.toMillis(15), req.workSpec.intervalDuration)
        assertEquals(NetworkType.CONNECTED, req.workSpec.constraints.requiredNetworkType)
        assertTrue(SyncScheduler.oneTimeRequest().workSpec.expedited)

        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(SyncScheduler.PERIODIC, androidx.work.ExistingPeriodicWorkPolicy.KEEP, req).result.get()
        wm.enqueueUniquePeriodicWork(SyncScheduler.PERIODIC, androidx.work.ExistingPeriodicWorkPolicy.KEEP, SyncScheduler.periodicRequest()).result.get()
        val infos = wm.getWorkInfosForUniqueWork(SyncScheduler.PERIODIC).get()
        assertEquals(1, infos.size)
        assertEquals(req.id, infos.single().id)
    }
}
