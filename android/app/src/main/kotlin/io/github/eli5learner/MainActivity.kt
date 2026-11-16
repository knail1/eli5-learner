package io.github.eli5learner

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.IntentCompat
import io.github.eli5learner.auth.AccountViewModel
import io.github.eli5learner.library.LibraryViewModel
import io.github.eli5learner.share.OwnUris
import io.github.eli5learner.ui.nav.AppNav
import io.github.eli5learner.ui.theme.Eli5Theme
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The main activity (16 §6.1). Also receives "Open with" (VIEW) and share-sheet (SEND) imports of
 * HTML, and "Learnings ready" taps ([ACTION_OPEN_INBOX]). Captures arrive at
 * [io.github.eli5learner.capture.CaptureActivity].
 */
class MainActivity : ComponentActivity() {
    /** Bumped when a notification asks for the Inbox; [AppNav] follows it. */
    private val openInbox = MutableStateFlow(0)

    private val library: LibraryViewModel by viewModels {
        LibraryViewModel.factory(AppContainer.from(this), contentResolver)
    }

    private val account: AccountViewModel by viewModels {
        AccountViewModel.factory(AppContainer.from(this).authorizer)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Only a fresh launch carries a new intent; after a configuration change it was handled.
        if (savedInstanceState == null) handleIntent(intent)
        val container = AppContainer.from(this)
        container.syncScheduler.start(container.authorizer.state)
        container.syncScheduler.watchJobs(container.outbox.active)
        // Share copies older than a day (16 §6.5), off the main thread.
        if (savedInstanceState == null) container.docSharer.cleanupIn(container.appScope)
        setContent {
            Eli5Theme {
                AppNav(container = AppContainer.from(this), library = library, account = account, openInbox = openInbox)
            }
        }
    }

    override fun onStop() {
        super.onStop()
        AppContainer.from(this).syncScheduler.onBackground()
    }

    override fun onStart() {
        super.onStart()
        // Foreground pull (16 §4.8), at most every 30 s; a no-op in local mode.
        AppContainer.from(this).syncScheduler.onForeground()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == ACTION_OPEN_INBOX) {
            openInbox.value += 1
            return
        }
        // This app's own share copies are refused (16 §6.5): MainActivity is exported.
        val uris = importUris(intent) { OwnUris.isOwn(this, it) } ?: return
        library.import(uris)
    }

    companion object {
        /**
         * A "Learnings ready" notification was tapped. MainActivity is exported, so any app can send
         * this; it only shows the Inbox and carries no data.
         */
        const val ACTION_OPEN_INBOX = "io.github.eli5learner.action.OPEN_INBOX"

        /**
         * URIs to import from a VIEW or SEND intent, or null when the intent is not an import. An
         * intent relaunched from Recents was already handled when it first arrived. URIs for which
         * [isOwn] is true (this app's own providers, such as the share FileProvider) are dropped.
         */
        fun importUris(
            intent: Intent?,
            isOwn: (Uri) -> Boolean = { false },
        ): List<Uri>? =
            if (intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
                null
            } else {
                importUrisOf(intent)?.filterNot(isOwn)
            }

        private fun importUrisOf(intent: Intent?): List<Uri>? =
            when (intent?.action) {
                Intent.ACTION_VIEW -> listOfNotNull(intent.data)
                Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
                else -> null
            }
    }
}
