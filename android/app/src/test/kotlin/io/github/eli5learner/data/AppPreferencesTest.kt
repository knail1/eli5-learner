package io.github.eli5learner.data

import io.github.eli5learner.auth.SavedAuth
import io.github.eli5learner.sync.protocol.Patterns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import androidx.datastore.preferences.core.PreferenceDataStoreFactory

/** DataStore preferences: onboarding flag, device id, and the grant's display state (no tokens). */
class AppPreferencesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun prefs() =
        AppPreferences(
            PreferenceDataStoreFactory.create(scope = scope, produceFile = { tmp.root.resolve("settings.preferences_pb") }),
        )

    @Test
    fun defaultsAreLocalMode() =
        runBlocking {
            val p = prefs()
            assertFalse(p.onboardingDone.first())
            assertEquals(SavedAuth(connected = false, email = null), p.read())
        }

    @Test
    fun deviceIdIsAStableUuidV4() =
        runBlocking {
            val p = prefs()
            val id = p.deviceId()
            assertTrue(id, Patterns.DEVICE_ID.matches(id))
            assertEquals(id, p.deviceId())
        }

    @Test
    fun authAndOnboardingRoundTrip() =
        runBlocking {
            val p = prefs()
            p.setOnboardingDone()
            p.write(SavedAuth(connected = true, email = "me@example.com", needsReconnect = true))
            assertTrue(p.onboardingDone.first())
            assertEquals(SavedAuth(connected = true, email = "me@example.com", needsReconnect = true), p.read())
            p.write(SavedAuth(connected = false, email = null))
            assertEquals(SavedAuth(connected = false, email = null), p.read())
            val stored = tmp.root.resolve("settings.preferences_pb").readBytes().decodeToString()
            assertFalse("no email after disconnect", stored.contains("example.com"))
        }
}
