package io.github.eli5learner.capture

import android.Manifest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.eli5learner.AppContainer
import io.github.eli5learner.R
import io.github.eli5learner.share.OwnUris
import io.github.eli5learner.ui.theme.Eli5Theme
import kotlinx.coroutines.launch

/**
 * The share target (16 §5.2, §6.2): a translucent activity with the capture sheet. Receives SEND for
 * text, images, PDF and Office files and SEND_MULTIPLE for images; the manifest enforces its intent
 * filters (`intentMatchingFlags="enforceIntentFilter"`). Sending queues the job and closes at once.
 */
class CaptureActivity : ComponentActivity() {
    private val input: ShareInput by lazy { ShareInput.of(intent) ?: ShareInput() }

    private val vm: CaptureViewModel by viewModels {
        CaptureViewModel.factory(AppContainer.from(this), input, contentResolver, ::isOwnUri)
    }

    /** A `content:` URI whose provider belongs to this app (any of its providers, exported or not). */
    private fun isOwnUri(uri: Uri): Boolean = OwnUris.isOwn(this, uri)

    private val askPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            answer(granted)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (input.isEmpty) {
            Toast.makeText(this, R.string.capture_nothing, Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        setContent {
            Eli5Theme {
                val state by vm.state.collectAsStateWithLifecycle()
                var asking by rememberSaveable { mutableStateOf(false) }
                LaunchedEffect(vm) {
                    vm.messages.collect { e ->
                        when (e) {
                            is CaptureEvent.Sent -> {
                                Toast.makeText(this@CaptureActivity, R.string.capture_sent, Toast.LENGTH_SHORT).show()
                                if (e.askNotifications) asking = true else finish()
                            }
                            CaptureEvent.Failed -> Toast.makeText(this@CaptureActivity, R.string.capture_failed, Toast.LENGTH_LONG).show()
                        }
                    }
                }
                if (asking) {
                    NotifyDialog { yes ->
                        asking = false
                        if (yes && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            answer(yes)
                        }
                    }
                } else {
                    CaptureSheet(
                        state = state,
                        actions = CaptureActions(vm::setClarifyingInput, vm::toggleFocus, vm::send),
                        onDismiss = { finish() },
                    )
                }
            }
        }
    }

    /** Stores the answer (the system dialog's result on Android 13+) and closes. */
    private fun answer(yes: Boolean) {
        val container = AppContainer.from(this)
        container.appScope.launch {
            container.preferences.setReadyNotifications(yes)
            if (yes) container.readyNotifier.ensureChannel()
        }
        finish()
    }
}
