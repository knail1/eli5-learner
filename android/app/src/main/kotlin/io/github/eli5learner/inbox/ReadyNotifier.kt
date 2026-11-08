package io.github.eli5learner.inbox

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.eli5learner.MainActivity
import io.github.eli5learner.R
import io.github.eli5learner.data.db.JobEntity

/**
 * The "Learnings ready" notification channel (16 §6.1): opt-in, asked after the first capture. A
 * notification is posted only when the user said yes and the system allows it; tapping it opens the
 * Inbox. The title is the job's local label; nothing else about the job is shown.
 */
class ReadyNotifier(
    private val context: Context,
    /** The user's answer to "Tell you when it's ready?" (null: not asked yet). */
    private val optedIn: suspend () -> Boolean?,
) {
    fun ensureChannel() {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val channel =
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notify_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = context.getString(R.string.notify_channel_body)
            }
        nm.createNotificationChannel(channel)
    }

    /** True when the system lets this app post (the permission on Android 13+, and the user's settings). */
    fun allowed(): Boolean {
        val granted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return granted && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    suspend fun notifyReady(job: JobEntity): Boolean {
        if (optedIn() != true || !allowed()) return false
        ensureChannel()
        val open =
            PendingIntent.getActivity(
                context,
                job.jobId.hashCode(),
                Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_INBOX).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val text =
            if ((job.skippedSources ?: 0) > 0) {
                context.resources.getQuantityString(R.plurals.inbox_built_skipped, job.skippedSources!!.toInt(), job.skippedSources.toInt())
            } else {
                context.getString(R.string.notify_ready_body)
            }
        val n =
            NotificationCompat
                .Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_inbox)
                .setContentTitle(job.title.ifBlank { context.getString(R.string.notify_ready_title) })
                .setContentText(text)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build()
        return try {
            NotificationManagerCompat.from(context).notify(job.jobId, NOTIFICATION_ID, n)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    companion object {
        const val CHANNEL_ID = "learnings-ready"
        const val NOTIFICATION_ID = 1
    }
}
