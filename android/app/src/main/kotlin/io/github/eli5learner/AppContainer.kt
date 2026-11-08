package io.github.eli5learner

import android.content.Context
import io.github.eli5learner.auth.GoogleAuthorizer
import io.github.eli5learner.auth.PlayServicesAuthorization
import io.github.eli5learner.data.AppPreferences
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LocalIndex
import io.github.eli5learner.drive.DriveClient
import io.github.eli5learner.drive.DriveProbe
import io.github.eli5learner.importer.HtmlImporter
import okhttp3.OkHttpClient
import java.io.File

/**
 * Manual dependency injection (16 §6.1). One instance per process, owned by [Eli5App]. Documents
 * under `filesDir/docs` with a JSON index beside them, the importer, preferences, and the Google
 * authorization and Drive client. Nothing here makes a request: Drive calls happen only after the
 * user connects (16 §7).
 */
class AppContainer(
    context: Context,
) {
    private val filesDir: File = context.filesDir

    val docStore = DocStore(File(filesDir, "docs"))
    val localIndex = LocalIndex(File(filesDir, "library-index.json"), docStore)
    val importer = HtmlImporter(docStore, localIndex)
    val preferences = AppPreferences.create(File(filesDir, "datastore/settings.preferences_pb"))

    private val http: OkHttpClient by lazy { OkHttpClient() }

    val authorizer: GoogleAuthorizer by lazy {
        GoogleAuthorizer(
            gateway = PlayServicesAuthorization(context.applicationContext),
            store = preferences,
            emailLookup = { _ -> drive.userEmail() },
        )
    }

    val drive: DriveClient by lazy { DriveClient(http, authorizer) }

    /** The G1 probe (16 §13); only Settings > Diagnostics in debug builds uses it. */
    val driveProbe: DriveProbe by lazy { DriveProbe(drive) }

    companion object {
        fun from(context: Context): AppContainer = (context.applicationContext as Eli5App).container
    }
}
