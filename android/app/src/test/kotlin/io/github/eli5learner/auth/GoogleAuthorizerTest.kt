package io.github.eli5learner.auth

import android.content.Intent
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** GoogleAuthorizer with a fake AuthorizationClient (16 §3.3, §12). */
class GoogleAuthorizerTest {
    // Assembled at runtime so the repository never contains token-shaped literals.
    private fun token(n: Int) = listOf("ya29", "fake", n.toString()).joinToString(".")

    private class FakeGateway : AuthorizationGateway {
        /** Each authorize() takes the next answer: an outcome, or a Throwable to throw. */
        val answers = ArrayDeque<Any>()
        var fromIntent: Any = AuthorizeOutcome.NeedsResolution(null)
        var authorizeCalls = 0
        val cleared = mutableListOf<String>()
        val revoked = mutableListOf<String>()
        var revokeFails = false

        override suspend fun authorize(): AuthorizeOutcome {
            authorizeCalls++
            return when (val a = answers.removeFirstOrNull() ?: error("unexpected authorize()")) {
                is Throwable -> throw a
                else -> a as AuthorizeOutcome
            }
        }

        override fun resultFromIntent(data: Intent?): AuthorizeOutcome =
            when (val a = fromIntent) {
                is Throwable -> throw a
                else -> a as AuthorizeOutcome
            }

        override suspend fun clearToken(token: String) {
            cleared += token
        }

        override suspend fun revokeAccess(email: String) {
            if (revokeFails) throw AuthorizationFailure(8)
            revoked += email
        }
    }

    private class MemoryStore(
        var saved: SavedAuth = SavedAuth(connected = false, email = null),
    ) : AuthStore {
        override suspend fun read() = saved

        override suspend fun write(saved: SavedAuth) {
            this.saved = saved
        }
    }

    private val gateway = FakeGateway()
    private var clock = 0L

    private fun authorizer(
        store: AuthStore = MemoryStore(),
        lookup: suspend (String) -> String? = { null },
    ) = GoogleAuthorizer(gateway, store, lookup, now = { clock })

    private suspend fun expectAuthError(block: suspend () -> Unit) {
        try {
            block()
            fail("expected E_SYNC_AUTH")
        } catch (e: SyncException) {
            assertEquals(SyncErrorCode.E_SYNC_AUTH, e.code)
        }
    }

    @Test
    fun requestsExactlyTheThreeNonSensitiveScopes() {
        assertEquals(listOf("openid", "email", "https://www.googleapis.com/auth/drive.appdata"), SYNC_SCOPES)
    }

    @Test
    fun disconnectedMakesNoGoogleCall() =
        runTest {
            val a = authorizer()
            assertEquals(AuthState.Disconnected, a.load())
            expectAuthError { a.accessToken() }
            assertEquals(0, gateway.authorizeCalls)
        }

    @Test
    fun connectWithAnExistingGrantStoresOnlyTheFlagAndEmail() =
        runTest {
            val store = MemoryStore()
            val a = authorizer(store)
            gateway.answers += AuthorizeOutcome.Granted(token(1), "me@example.com")
            assertEquals(ConnectStep.Done("me@example.com"), a.connect())
            assertEquals(AuthState.Connected("me@example.com"), a.state.value)
            assertEquals(SavedAuth(connected = true, email = "me@example.com"), store.saved)
            // The token is reused, not persisted.
            assertEquals(token(1), a.accessToken())
            assertEquals(1, gateway.authorizeCalls)
        }

    @Test
    fun connectThatNeedsConsentResolvesThroughTheIntent() =
        runTest {
            val a = authorizer(lookup = { "looked-up@example.com" })
            gateway.answers += AuthorizeOutcome.NeedsResolution(null)
            assertEquals(ConnectStep.Resolve(null), a.connect())
            assertEquals(AuthState.Connecting, a.state.value)

            gateway.fromIntent = AuthorizeOutcome.Granted(token(2), null)
            assertEquals(ConnectStep.Done("looked-up@example.com"), a.completeConnect(resultOk = true, data = null))
            assertEquals(AuthState.Connected("looked-up@example.com"), a.state.value)
        }

    @Test
    fun cancelledConsentLeavesTheAppDisconnected() =
        runTest {
            val store = MemoryStore()
            val a = authorizer(store)
            gateway.answers += AuthorizeOutcome.NeedsResolution(null)
            a.connect()
            assertEquals(ConnectStep.Cancelled, a.completeConnect(resultOk = false, data = null))
            assertEquals(AuthState.Disconnected, a.state.value)
            assertFalse(store.saved.connected)
        }

    @Test
    fun aDeveloperErrorIsReportedWithItsCode() =
        runTest {
            val a = authorizer()
            gateway.answers += AuthorizationFailure(10)
            assertEquals(ConnectStep.Failed(10), a.connect())
            assertEquals(AuthState.Disconnected, a.state.value)
        }

    @Test
    fun backgroundAuthorizeThatNeedsConsentSetsNeedsReconnect() =
        runTest {
            val store = MemoryStore(SavedAuth(connected = true, email = "me@example.com"))
            val a = authorizer(store)
            gateway.answers += AuthorizeOutcome.NeedsResolution(null)
            expectAuthError { a.accessToken() }
            assertEquals(AuthState.NeedsReconnect("me@example.com"), a.state.value)
            assertTrue(store.saved.needsReconnect)
            // No more Google calls until the user reconnects.
            expectAuthError { a.accessToken() }
            assertEquals(1, gateway.authorizeCalls)
            // After a restart the banner is still there.
            assertEquals(AuthState.NeedsReconnect("me@example.com"), authorizer(store).load())
        }

    @Test
    fun reconnectClearsNeedsReconnect() =
        runTest {
            val store = MemoryStore(SavedAuth(connected = true, email = "me@example.com", needsReconnect = true))
            val a = authorizer(store)
            gateway.answers += AuthorizeOutcome.Granted(token(3), "me@example.com")
            assertEquals(ConnectStep.Done("me@example.com"), a.connect())
            assertEquals(AuthState.Connected("me@example.com"), a.state.value)
            assertFalse(store.saved.needsReconnect)
        }

    @Test
    fun anIllegalStateExceptionClearsTheTokenAndAuthorizesOnceMore() =
        runTest {
            val a = authorizer(MemoryStore(SavedAuth(connected = true, email = null)))
            gateway.answers += AuthorizeOutcome.Granted(token(1), null)
            assertEquals(token(1), a.accessToken())
            clock += GoogleAuthorizer.TOKEN_REUSE_MS
            gateway.answers += IllegalStateException("stale")
            gateway.answers += AuthorizeOutcome.Granted(token(2), null)
            assertEquals(token(2), a.accessToken())
            assertEquals(listOf(token(1)), gateway.cleared)
            assertEquals(AuthState.Connected(null), a.state.value)
        }

    @Test
    fun aSecondIllegalStateExceptionSetsNeedsReconnect() =
        runTest {
            val a = authorizer(MemoryStore(SavedAuth(connected = true, email = null)))
            gateway.answers += IllegalStateException("one")
            gateway.answers += IllegalStateException("two")
            expectAuthError { a.accessToken() }
            assertEquals(AuthState.NeedsReconnect(null), a.state.value)
        }

    @Test
    fun a401ClearsTheTokenAndTheNextCallAuthorizesAgain() =
        runTest {
            val a = authorizer(MemoryStore(SavedAuth(connected = true, email = null)))
            gateway.answers += AuthorizeOutcome.Granted(token(1), null)
            gateway.answers += AuthorizeOutcome.Granted(token(2), null)
            val first = a.accessToken()
            a.invalidate(first)
            assertEquals(listOf(token(1)), gateway.cleared)
            assertEquals(token(2), a.accessToken())
            a.authFailed()
            assertEquals(AuthState.NeedsReconnect(null), a.state.value)
        }

    @Test
    fun prepareAlwaysCallsAuthorize() =
        runTest {
            val a = authorizer(MemoryStore(SavedAuth(connected = true, email = null)))
            gateway.answers += AuthorizeOutcome.Granted(token(1), null)
            gateway.answers += AuthorizeOutcome.Granted(token(2), null)
            a.accessToken()
            assertEquals(token(2), a.prepare())
            assertEquals(2, gateway.authorizeCalls)
        }

    @Test
    fun playServicesUnavailableInTheBackgroundIsTransient() =
        runTest {
            val a = authorizer(MemoryStore(SavedAuth(connected = true, email = null)))
            gateway.answers += AuthorizationFailure(7)
            try {
                a.accessToken()
                fail("expected a failure")
            } catch (e: SyncException) {
                assertEquals(SyncErrorCode.E_SYNC_HTTP, e.code)
            }
            assertEquals(AuthState.Connected(null), a.state.value)
        }

    @Test
    fun disconnectRevokesAndForgetsTheGrant() =
        runTest {
            val store = MemoryStore()
            val a = authorizer(store)
            gateway.answers += AuthorizeOutcome.Granted(token(1), "me@example.com")
            a.connect()
            assertTrue(a.disconnect())
            assertEquals(listOf("me@example.com"), gateway.revoked)
            assertEquals(listOf(token(1)), gateway.cleared)
            assertEquals(AuthState.Disconnected, a.state.value)
            assertEquals(SavedAuth(connected = false, email = null), store.saved)
            expectAuthError { a.accessToken() }
        }

    @Test
    fun aFailedRevocationStillDisconnectsLocally() =
        runTest {
            val store = MemoryStore(SavedAuth(connected = true, email = "me@example.com"))
            val a = authorizer(store)
            gateway.revokeFails = true
            assertFalse(a.disconnect())
            assertEquals(AuthState.Disconnected, a.state.value)
            assertFalse(store.saved.connected)
        }

    @Test
    fun aLostGrantAfterDisconnectStaysDisconnected() =
        runTest {
            val a = authorizer(MemoryStore(SavedAuth(connected = true, email = null)))
            a.disconnect()
            a.authFailed()
            assertEquals(AuthState.Disconnected, a.state.value)
        }

    @Test
    fun backgroundWorkDuringConnectMakesNoCallAndKeepsLocalMode() =
        runTest {
            val store = MemoryStore()
            val a = authorizer(store)
            gateway.answers += AuthorizeOutcome.NeedsResolution(null)
            a.connect()
            assertEquals(AuthState.Connecting, a.state.value)
            // A sync that starts while consent is on screen must not mark local mode "sign in again".
            expectAuthError { a.accessToken() }
            assertEquals(1, gateway.authorizeCalls)
            a.completeConnect(resultOk = false, data = null)
            assertEquals(AuthState.Disconnected, a.state.value)
            assertEquals(SavedAuth(connected = false, email = null), store.saved)
        }

    @Test
    fun theEmailLookupGoesThroughTheJustGrantedToken() =
        runTest {
            val store = MemoryStore()
            lateinit var a: GoogleAuthorizer
            a = authorizer(store, lookup = { if (a.accessToken() == token(3)) "via-userinfo@example.com" else null })
            gateway.answers += AuthorizeOutcome.Granted(token(3), null)
            assertEquals(ConnectStep.Done("via-userinfo@example.com"), a.connect())
            assertEquals(AuthState.Connected("via-userinfo@example.com"), a.state.value)
            assertEquals(SavedAuth(connected = true, email = "via-userinfo@example.com"), store.saved)
            assertEquals(1, gateway.authorizeCalls)
        }
}
