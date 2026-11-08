package io.github.eli5learner.inbox

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.sync.SyncOutcome
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The outbox upload worker (16 §5.2 step 2) under the WorkManager test driver. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class UploadWorkerTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private var outcome: SyncOutcome = SyncOutcome.Synced
    private var runs = 0
    private val runner =
        UploadRunner {
            runs++
            outcome
        }

    private val factory =
        object : WorkerFactory() {
            override fun createWorker(
                appContext: Context,
                workerClassName: String,
                workerParameters: WorkerParameters,
            ): ListenableWorker = UploadWorker(appContext, workerParameters, runner)
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

    private fun worker(attempt: Int = 0) =
        TestListenableWorkerBuilder<UploadWorker>(context).setWorkerFactory(factory).setRunAttemptCount(attempt).build()

    @Test fun `a lost grant stops, network trouble retries a few times`() =
        runTest {
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            outcome = SyncOutcome.NotConnected
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            outcome = SyncOutcome.NeedsReconnect
            assertEquals(ListenableWorker.Result.failure(), worker().doWork())
            outcome = SyncOutcome.Transient(SyncErrorCode.E_SYNC_HTTP)
            assertEquals(ListenableWorker.Result.retry(), worker().doWork())
            assertEquals(ListenableWorker.Result.failure(), worker(attempt = 5).doWork())
            assertEquals(5, runs)
        }

    @Test fun `the request is expedited on a connected network, and a second upload is appended`() {
        val r = UploadWorker.request()
        assertTrue(r.workSpec.expedited)
        assertEquals(NetworkType.CONNECTED, r.workSpec.constraints.requiredNetworkType)

        val wm = WorkManager.getInstance(context)
        UploadWorker.enqueue(wm)
        UploadWorker.enqueue(wm)
        val infos = wm.getWorkInfosForUniqueWork(UploadWorker.UNIQUE).get()
        assertTrue(infos.isNotEmpty())
        UploadWorker.enqueue(null)
    }
}
