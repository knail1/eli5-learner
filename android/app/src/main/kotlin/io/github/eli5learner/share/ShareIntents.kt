package io.github.eli5learner.share

import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import io.github.eli5learner.MainActivity
import io.github.eli5learner.capture.CaptureActivity
import java.io.File

/** The share sheet intents for a staged copy (16 §6.5). */
object ShareIntents {
    const val MIME = "text/html"

    /** The FileProvider authority: `${applicationId}.share` in the manifest. */
    fun authority(context: Context): String = "${context.packageName}.share"

    /** A content URI for a staged copy; throws IllegalArgumentException for any file outside `cacheDir/share`. */
    fun uriFor(
        context: Context,
        file: File,
    ): Uri = FileProvider.getUriForFile(context, authority(context), file)

    /** ACTION_SEND with a read-only grant for [uri] (no write grant). */
    fun send(
        uri: Uri,
        subject: String,
        text: String,
    ): Intent =
        Intent(Intent.ACTION_SEND)
            .setType(MIME)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_SUBJECT, subject)
            .putExtra(Intent.EXTRA_TEXT, text)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .apply { clipData = ClipData(subject, arrayOf(MIME), ClipData.Item(uri)) }

    /** This app's own components that would accept the share (import, capture): left out of the chooser. */
    fun ownTargets(context: Context): Array<ComponentName> =
        arrayOf(
            ComponentName(context, MainActivity::class.java),
            ComponentName(context, CaptureActivity::class.java),
        )

    fun chooser(
        send: Intent,
        title: CharSequence,
        exclude: Array<ComponentName>,
    ): Intent = Intent.createChooser(send, title).putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, exclude)
}
