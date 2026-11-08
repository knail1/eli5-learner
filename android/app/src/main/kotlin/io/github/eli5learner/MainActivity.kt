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
import io.github.eli5learner.ui.nav.AppNav
import io.github.eli5learner.ui.theme.Eli5Theme

/** The single activity (16 §6.1). Also receives "Open with" (VIEW) and share-sheet (SEND) imports. */
class MainActivity : ComponentActivity() {
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
        if (savedInstanceState == null) handleImportIntent(intent)
        val container = AppContainer.from(this)
        container.syncScheduler.start(container.authorizer.state)
        setContent {
            Eli5Theme {
                AppNav(container = AppContainer.from(this), library = library, account = account)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Foreground pull (16 §4.8), at most every 30 s; a no-op in local mode.
        AppContainer.from(this).syncScheduler.onForeground()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleImportIntent(intent)
    }

    private fun handleImportIntent(intent: Intent?) {
        val uris = importUris(intent) ?: return
        library.import(uris)
    }

    companion object {
        /**
         * URIs to import from a VIEW or SEND intent, or null when the intent is not an import. An
         * intent relaunched from Recents was already handled when it first arrived.
         */
        fun importUris(intent: Intent?): List<Uri>? =
            if (intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
                null
            } else {
                importUrisOf(intent)
            }

        private fun importUrisOf(intent: Intent?): List<Uri>? =
            when (intent?.action) {
                Intent.ACTION_VIEW -> listOfNotNull(intent.data)
                Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
                else -> null
            }
    }
}
