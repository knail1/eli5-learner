package io.github.eli5learner

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import androidx.work.WorkManager
import io.github.eli5learner.auth.GoogleAuthorizer
import io.github.eli5learner.auth.PlayServicesAuthorization
import io.github.eli5learner.data.AppPreferences
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.drive.DriveClient
import io.github.eli5learner.drive.DriveProbe
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.inbox.OutboxRepository
import io.github.eli5learner.inbox.ReadyNotifier
import io.github.eli5learner.inbox.UploadWorker
import io.github.eli5learner.share.DocSharer
import io.github.eli5learner.share.ShareCache
import io.github.eli5learner.sync.DeviceWriter
import io.github.eli5learner.sync.SyncRepository
import io.github.eli5learner.sync.SyncScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.io.File

/**
 * Manual dependency injection (16 §6.1). One instance per process, owned by [Eli5App]. Documents
 * under `filesDir/docs` with the Room library index over them, the importer, preferences, the Google
 * authorization and Drive client, library sync, the capture outbox, and share copies. Nothing here makes a request: Drive calls happen
 * only after the user connects (16 §7).
 */
class AppContainer(
    context: Context,
) {
    private val app: Context = context.applicationContext
    private val filesDir: File = context.filesDir

    /** Work that outlives a screen (foreground pulls). */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val docStore = DocStore(File(filesDir, "docs"))
    val db: Eli5Db by lazy { Eli5Db.open(app) }

    /** The S2 JSON index is migrated into Room on first load and deleted (16 §6.4). */
    val libraryIndex: LibraryIndex by lazy { LibraryIndex(db, docStore, legacyFile = File(filesDir, "library-index.json")) }
    val importer: HtmlImporter by lazy { HtmlImporter(docStore, libraryIndex) }
    val preferences = AppPreferences.create(File(filesDir, "datastore/settings.preferences_pb"))

    /** Copies handed to other apps through the share sheet (16 §6.5). */
    val shareCache = ShareCache(File(context.cacheDir, "share"))
    val docSharer: DocSharer by lazy { DocSharer(docStore, libraryIndex, shareCache) }

    private val http: OkHttpClient by lazy { OkHttpClient() }

    val authorizer: GoogleAuthorizer by lazy {
        GoogleAuthorizer(
            gateway = PlayServicesAuthorization(app),
            store = preferences,
            emailLookup = { _ -> drive.userEmail() },
        )
    }

    val drive: DriveClient by lazy { DriveClient(http, authorizer) }

    /** The G1 probe (16 §13); only Settings > Diagnostics in debug builds uses it. */
    val driveProbe: DriveProbe by lazy { DriveProbe(drive) }

    val syncRepository: SyncRepository by lazy {
        SyncRepository(
            db = db,
            index = libraryIndex,
            store = docStore,
            drive = drive,
            prefs = preferences,
            deviceWriter = DeviceWriter(drive, preferences, deviceName(), BuildConfig.VERSION_NAME),
            authState = authorizer::load,
            prepareAuth = { authorizer.prepare() },
            isUnmetered = ::isUnmetered,
            jobs = outbox,
        )
    }

    private fun workManager(): WorkManager? = runCatching { WorkManager.getInstance(app) }.getOrNull()

    val readyNotifier: ReadyNotifier by lazy { ReadyNotifier(app) { preferences.readyNotificationsAnswer() } }

    /** Captures waiting in `filesDir/outbox` and the statuses of jobs sent from here (16 §5.2). */
    val outbox: OutboxRepository by lazy {
        OutboxRepository(
            db = db,
            root = File(filesDir, "outbox"),
            drive = drive,
            prefs = preferences,
            authState = authorizer::load,
            prepareAuth = { authorizer.prepare() },
            kickUpload = { UploadWorker.enqueue(workManager()) },
            notifyReady = readyNotifier::notifyReady,
        )
    }

    val syncScheduler: SyncScheduler by lazy {
        SyncScheduler(
            repository = syncRepository,
            workManager = ::workManager,
            scope = appScope,
        )
    }

    private fun isUnmetered(): Boolean {
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    /** The phone's model as the Mac shows it in Settings > Sync (16 §4.3), e.g. "Pixel 9". */
    private fun deviceName(): String = Build.MODEL?.trim().orEmpty().ifEmpty { DeviceWriter.DEFAULT_NAME }

    companion object {
        fun from(context: Context): AppContainer = (context.applicationContext as Eli5App).container
    }
}
