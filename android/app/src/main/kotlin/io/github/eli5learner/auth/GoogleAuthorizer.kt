package io.github.eli5learner.auth

import android.accounts.Account
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.google.android.gms.auth.api.identity.AuthorizationClient
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import io.github.eli5learner.drive.AccessTokenSource
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

/** The three scopes (16 §3.1). All non-sensitive; never `drive`, `drive.readonly` or `drive.metadata*`. */
val SYNC_SCOPES: List<String> = listOf("openid", "email", "https://www.googleapis.com/auth/drive.appdata")

/** What one `authorize()` call returned. */
sealed interface AuthorizeOutcome {
    data class Granted(
        val accessToken: String,
        val email: String?,
    ) : AuthorizeOutcome

    /** Consent (or an account choice) is needed; only the UI may launch [pendingIntent]. */
    data class NeedsResolution(
        val pendingIntent: PendingIntent?,
    ) : AuthorizeOutcome
}

/** Thrown by a gateway when Google Play services answered with an error status (e.g. 10, developer error). */
class AuthorizationFailure(
    val statusCode: Int?,
) : Exception("Authorization failed (${statusCode ?: "unknown"})")

/**
 * The narrow seam over `AuthorizationClient` (16 §3.3). The app uses [PlayServicesAuthorization];
 * tests use a fake. Implementations throw [AuthorizationFailure] for Play services errors and may
 * throw [IllegalStateException] as the client does.
 */
interface AuthorizationGateway {
    suspend fun authorize(): AuthorizeOutcome

    /** Reads the result of the consent activity launched from [AuthorizeOutcome.NeedsResolution]. */
    fun resultFromIntent(data: Intent?): AuthorizeOutcome

    suspend fun clearToken(token: String)

    /** Revokes every scope the app holds for [email]'s account. */
    suspend fun revokeAccess(email: String)
}

/** The real gateway: `Identity.getAuthorizationClient`, no client ID, no offline access, no Web client. */
class PlayServicesAuthorization(
    context: Context,
) : AuthorizationGateway {
    private val client: AuthorizationClient = Identity.getAuthorizationClient(context.applicationContext)
    private val scopes = SYNC_SCOPES.map(::Scope)

    override suspend fun authorize(): AuthorizeOutcome {
        val request = AuthorizationRequest.builder().setRequestedScopes(scopes).build()
        val result =
            try {
                client.authorize(request).await()
            } catch (e: ApiException) {
                throw AuthorizationFailure(e.statusCode)
            }
        return outcome(result)
    }

    override fun resultFromIntent(data: Intent?): AuthorizeOutcome =
        try {
            outcome(client.getAuthorizationResultFromIntent(data))
        } catch (e: ApiException) {
            throw AuthorizationFailure(e.statusCode)
        }

    override suspend fun clearToken(token: String) {
        try {
            client.clearToken(ClearTokenRequest.builder().setToken(token).build()).await()
        } catch (e: ApiException) {
            throw AuthorizationFailure(e.statusCode)
        }
    }

    override suspend fun revokeAccess(email: String) {
        val request =
            RevokeAccessRequest
                .builder()
                .setAccount(Account(email, GOOGLE_ACCOUNT_TYPE))
                .setScopes(scopes)
                .build()
        try {
            client.revokeAccess(request).await()
        } catch (e: ApiException) {
            throw AuthorizationFailure(e.statusCode)
        }
    }

    private fun outcome(result: AuthorizationResult): AuthorizeOutcome {
        if (result.hasResolution()) return AuthorizeOutcome.NeedsResolution(result.pendingIntent)
        val token = result.accessToken ?: throw AuthorizationFailure(null)
        return AuthorizeOutcome.Granted(token, accountEmail(result))
    }

    @Suppress("DEPRECATION") // The only way the result names its account; the email is a display hint.
    private fun accountEmail(result: AuthorizationResult): String? = result.toGoogleSignInAccount()?.email

    private companion object {
        const val GOOGLE_ACCOUNT_TYPE = "com.google"
    }
}

/** One step of the interactive Connect flow. */
sealed interface ConnectStep {
    data class Done(
        val email: String?,
    ) : ConnectStep

    /** The UI launches this through `StartIntentSenderForResult`, then calls [GoogleAuthorizer.completeConnect]. */
    data class Resolve(
        val pendingIntent: PendingIntent?,
    ) : ConnectStep

    data object Cancelled : ConnectStep

    data class Failed(
        val statusCode: Int?,
    ) : ConnectStep
}

/**
 * The phone's Google authorization (16 §3.3). Interactive [connect] for the UI; [accessToken] for
 * Drive requests, which never shows consent: when consent is needed it sets
 * [AuthState.NeedsReconnect] and throws `E_SYNC_AUTH`. On a refused token ([invalidate], HTTP 401) or
 * an [IllegalStateException] from the client it clears the token and authorizes once more; a second
 * failure sets `NeedsReconnect`. While disconnected it makes no Google call at all.
 */
class GoogleAuthorizer(
    private val gateway: AuthorizationGateway,
    private val store: AuthStore,
    /** Fallback account lookup (OpenID userinfo) when the grant names no email. */
    private val emailLookup: suspend (accessToken: String) -> String? = { null },
    private val now: () -> Long = System::currentTimeMillis,
) : AccessTokenSource {
    private val _state = MutableStateFlow<AuthState>(AuthState.Unknown)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private val mutex = Mutex()
    private var cached: String? = null
    private var cachedAt = 0L

    /** Loads the saved state once; later calls are no-ops. */
    suspend fun load(): AuthState {
        if (_state.value == AuthState.Unknown) {
            val saved = store.read()
            _state.compareAndSet(
                AuthState.Unknown,
                when {
                    !saved.connected -> AuthState.Disconnected
                    saved.needsReconnect -> AuthState.NeedsReconnect(saved.email)
                    else -> AuthState.Connected(saved.email)
                },
            )
        }
        return _state.value
    }

    /** Starts Connect (or Reconnect) from the UI. */
    suspend fun connect(): ConnectStep {
        load()
        val before = _state.value
        _state.value = AuthState.Connecting
        val outcome =
            try {
                authorizeRetryingOnce()
            } catch (e: CancellationException) {
                _state.value = before
                throw e
            } catch (e: AuthorizationFailure) {
                _state.value = before
                return ConnectStep.Failed(e.statusCode)
            } catch (_: IllegalStateException) {
                _state.value = before
                return ConnectStep.Failed(null)
            }
        return when (outcome) {
            is AuthorizeOutcome.Granted -> ConnectStep.Done(granted(outcome))
            is AuthorizeOutcome.NeedsResolution -> ConnectStep.Resolve(outcome.pendingIntent)
        }
    }

    /** Finishes Connect with the consent activity's result. */
    suspend fun completeConnect(
        resultOk: Boolean,
        data: Intent?,
    ): ConnectStep {
        if (!resultOk) {
            restoreFromStore()
            return ConnectStep.Cancelled
        }
        val outcome =
            try {
                gateway.resultFromIntent(data)
            } catch (e: AuthorizationFailure) {
                restoreFromStore()
                return ConnectStep.Failed(e.statusCode)
            } catch (_: IllegalStateException) {
                restoreFromStore()
                return ConnectStep.Failed(null)
            }
        return when (outcome) {
            is AuthorizeOutcome.Granted -> ConnectStep.Done(granted(outcome))
            // Consent did not stick (for example the user backed out of an inner screen).
            is AuthorizeOutcome.NeedsResolution -> {
                restoreFromStore()
                ConnectStep.Cancelled
            }
        }
    }

    /**
     * Disconnect (16 §3.3): revoke every scope, forget the grant. Local data stays; the caller offers
     * to delete downloaded data. Returns false when the revocation itself failed (the user can still
     * revoke at myaccount.google.com/permissions); the app forgets the grant either way.
     */
    suspend fun disconnect(): Boolean {
        load()
        val email =
            when (val s = _state.value) {
                is AuthState.Connected -> s.email
                is AuthState.NeedsReconnect -> s.email
                else -> null
            }
        val revoked =
            mutex.withLock {
                val token = cached
                cached = null
                if (token != null) runCatching { gateway.clearToken(token) }
                if (email == null) {
                    false
                } else {
                    try {
                        gateway.revokeAccess(email)
                        true
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        false
                    }
                }
            }
        store.write(SavedAuth(connected = false, email = null))
        _state.value = AuthState.Disconnected
        return revoked
    }

    /**
     * Forces a fresh `authorize()`; the sync worker calls it before every sync (16 §3.3). Same rules
     * as [accessToken].
     */
    suspend fun prepare(): String {
        mutex.withLock { cached = null }
        return accessToken()
    }

    override suspend fun accessToken(): String {
        // Only a standing grant: never while disconnected, while Connect runs (a background
        // NeedsResolution then would turn local mode into "sign in again"), or once reconnect is needed.
        if (load() !is AuthState.Connected) throw SyncException(SyncErrorCode.E_SYNC_AUTH, "Not connected")
        return mutex.withLock {
            cached?.takeIf { now() - cachedAt < TOKEN_REUSE_MS }?.let { return@withLock it }
            val outcome =
                try {
                    authorizeRetryingOnce()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: IllegalStateException) {
                    lostGrant()
                    throw SyncException(SyncErrorCode.E_SYNC_AUTH)
                } catch (_: AuthorizationFailure) {
                    // Play services unavailable or offline: transient, the grant may still stand.
                    throw SyncException(SyncErrorCode.E_SYNC_HTTP, "Authorization unavailable")
                }
            when (outcome) {
                is AuthorizeOutcome.Granted -> {
                    cached = outcome.accessToken
                    cachedAt = now()
                    outcome.accessToken
                }
                is AuthorizeOutcome.NeedsResolution -> {
                    // Background work never shows consent.
                    lostGrant()
                    throw SyncException(SyncErrorCode.E_SYNC_AUTH)
                }
            }
        }
    }

    override suspend fun invalidate(token: String) {
        mutex.withLock {
            if (cached == token) cached = null
            try {
                gateway.clearToken(token)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Clearing is best effort; the next authorize() asks Play services again either way.
            }
        }
    }

    override suspend fun authFailed() {
        mutex.withLock { lostGrant() }
    }

    /** `authorize()`, and on an [IllegalStateException] clear the cached token and authorize once more. */
    private suspend fun authorizeRetryingOnce(): AuthorizeOutcome =
        try {
            gateway.authorize()
        } catch (_: IllegalStateException) {
            cached?.let { runCatching { gateway.clearToken(it) } }
            cached = null
            gateway.authorize()
        }

    private suspend fun granted(outcome: AuthorizeOutcome.Granted): String? {
        // Cache and publish the grant first, so a userinfo lookup through the Drive client reuses this token.
        mutex.withLock {
            cached = outcome.accessToken
            cachedAt = now()
        }
        store.write(SavedAuth(connected = true, email = outcome.email))
        _state.value = AuthState.Connected(outcome.email)
        if (outcome.email != null) return outcome.email
        val email =
            try {
                emailLookup(outcome.accessToken)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            } ?: return null
        // Only fill in the hint while that grant still stands (a Disconnect may have won meanwhile).
        if (_state.value == AuthState.Connected(null)) {
            store.write(SavedAuth(connected = true, email = email))
            _state.value = AuthState.Connected(email)
        }
        return email
    }

    private suspend fun lostGrant() {
        cached = null
        // A disconnect that happened meanwhile wins: never turn local mode into "sign in again".
        if (_state.value == AuthState.Disconnected) return
        val email =
            when (val s = _state.value) {
                is AuthState.Connected -> s.email
                is AuthState.NeedsReconnect -> s.email
                else -> null
            }
        store.write(SavedAuth(connected = true, email = email, needsReconnect = true))
        _state.value = AuthState.NeedsReconnect(email)
    }

    private suspend fun restoreFromStore() {
        _state.value = AuthState.Unknown
        load()
    }

    companion object {
        /** A token from `authorize()` is reused this long; a 401 clears it sooner (16 §3.3). */
        const val TOKEN_REUSE_MS = 10 * 60_000L
    }
}
