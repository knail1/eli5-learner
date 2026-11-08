package io.github.eli5learner.auth

/**
 * The phone's Google Drive grant (16 §3.3). The app stores no refresh token, client ID or secret:
 * only whether the user connected and the account email, which is a display hint.
 */
sealed interface AuthState {
    /** Not loaded from storage yet. */
    data object Unknown : AuthState

    /** Local mode: never connected, or disconnected. No Google request is ever made in this state. */
    data object Disconnected : AuthState

    /** The consent flow is running. */
    data object Connecting : AuthState

    data class Connected(
        val email: String?,
    ) : AuthState

    /**
     * The grant was lost (revoked, expired in Testing, or a token refused twice). Background work never
     * shows consent; the Library shows "Sign in again to keep syncing" and reading keeps working.
     */
    data class NeedsReconnect(
        val email: String?,
    ) : AuthState
}

/** What the app remembers about the grant between launches. */
data class SavedAuth(
    val connected: Boolean,
    val email: String?,
    val needsReconnect: Boolean = false,
)

/** Persistence for [SavedAuth] (DataStore in the app, in memory in tests). */
interface AuthStore {
    suspend fun read(): SavedAuth

    suspend fun write(saved: SavedAuth)
}
