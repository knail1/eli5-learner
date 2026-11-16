package io.github.eli5learner.share

import android.content.ActivityNotFoundException
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import io.github.eli5learner.R
import kotlinx.coroutines.launch

/**
 * Returns a callback that prepares a copy off the main thread, then opens the system share sheet
 * (16 §6.5). Failures show a snackbar; nothing throws to the UI. A second request while one is
 * being prepared is ignored.
 */
@Composable
fun rememberShareDocument(
    sharer: DocSharer,
    snackbar: SnackbarHostState,
): (ShareRequest) -> Unit {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val busy = remember { BooleanArray(1) }
    return remember(sharer, snackbar, context, resources, scope) {
        { req ->
            if (!busy[0]) {
                busy[0] = true
                scope.launch {
                    val message =
                        try {
                            when (val p = sharer.prepare(req)) {
                                is SharePrepared.Ready ->
                                    try {
                                        val uri = ShareIntents.uriFor(context, p.file)
                                        val send = ShareIntents.send(uri, p.title, resources.getString(R.string.share_message))
                                        context.startActivity(
                                            ShareIntents.chooser(
                                                send,
                                                resources.getString(R.string.share_chooser_title, p.title),
                                                ShareIntents.ownTargets(context),
                                            ),
                                        )
                                        null
                                    } catch (_: IllegalArgumentException) {
                                        R.string.share_failed
                                    } catch (_: ActivityNotFoundException) {
                                        R.string.share_failed
                                    }
                                SharePrepared.Missing -> R.string.share_missing
                                SharePrepared.Failed -> R.string.share_failed
                            }
                        } finally {
                            busy[0] = false
                        }
                    if (message != null) scope.launch { snackbar.showSnackbar(resources.getString(message)) }
                }
            }
        }
    }
}
