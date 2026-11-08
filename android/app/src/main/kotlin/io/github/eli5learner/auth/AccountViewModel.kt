package io.github.eli5learner.auth

import android.app.PendingIntent
import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** One-off results of the account actions, for the activity (launching consent) and snackbars. */
sealed interface AccountEvent {
    /** Launch through `StartIntentSenderForResult`, then call [AccountViewModel.onConsentResult]. */
    data class LaunchConsent(
        val pendingIntent: PendingIntent,
    ) : AccountEvent

    data class Connected(
        val email: String?,
    ) : AccountEvent

    data class Failed(
        val statusCode: Int?,
    ) : AccountEvent

    data object Cancelled : AccountEvent

    data class Disconnected(
        val revoked: Boolean,
    ) : AccountEvent
}

/** Connect and Disconnect for Google Drive (16 §3.3), activity-scoped so the consent result lands here. */
class AccountViewModel(
    private val authorizer: GoogleAuthorizer,
) : ViewModel() {
    val state: StateFlow<AuthState> = authorizer.state

    private val events = Channel<AccountEvent>(Channel.BUFFERED)
    val messages: Flow<AccountEvent> = events.receiveAsFlow()

    init {
        viewModelScope.launch { authorizer.load() }
    }

    fun connect() {
        if (state.value == AuthState.Connecting) return
        viewModelScope.launch { deliver(authorizer.connect()) }
    }

    fun onConsentResult(
        resultOk: Boolean,
        data: Intent?,
    ) {
        viewModelScope.launch { deliver(authorizer.completeConnect(resultOk, data)) }
    }

    fun disconnect() {
        viewModelScope.launch { events.send(AccountEvent.Disconnected(authorizer.disconnect())) }
    }

    private suspend fun deliver(step: ConnectStep) {
        if (step is ConnectStep.Resolve && step.pendingIntent == null) {
            // Nothing to launch: end the flow so the state leaves Connecting.
            authorizer.completeConnect(resultOk = false, data = null)
            events.send(AccountEvent.Failed(null))
            return
        }
        events.send(
            when (step) {
                is ConnectStep.Done -> AccountEvent.Connected(step.email)
                is ConnectStep.Resolve ->
                    step.pendingIntent?.let { AccountEvent.LaunchConsent(it) } ?: AccountEvent.Failed(null)
                ConnectStep.Cancelled -> AccountEvent.Cancelled
                is ConnectStep.Failed -> AccountEvent.Failed(step.statusCode)
            },
        )
    }

    companion object {
        fun factory(authorizer: GoogleAuthorizer): ViewModelProvider.Factory = viewModelFactory { initializer { AccountViewModel(authorizer) } }
    }
}
