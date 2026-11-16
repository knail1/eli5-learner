package io.github.eli5learner.share

import android.content.Context
import android.net.Uri

/**
 * Refuses this app's own `content:` URIs on the way in (16 §6.5). The share FileProvider serves
 * copies to other apps; an import or capture of one of them would act with this app's own
 * permissions (a confused deputy) and loop a document back into the library.
 */
object OwnUris {
    /** A `content:` URI whose provider belongs to this app (any of its providers, exported or not), or one with no authority. */
    fun isOwn(
        context: Context,
        uri: Uri,
    ): Boolean {
        val authority = uri.authority?.takeIf { it.isNotEmpty() } ?: return true
        // The int-flags overload works on every API level (the ComponentInfoFlags one is API 33+).
        @Suppress("DEPRECATION")
        val provider = context.packageManager.resolveContentProvider(authority, 0)
        return provider?.packageName == context.packageName
    }
}
