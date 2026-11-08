package io.github.eli5learner.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import io.github.eli5learner.auth.AuthStore
import io.github.eli5learner.auth.SavedAuth
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.io.File
import java.util.UUID

/**
 * Small app preferences in DataStore (16 §6.1, §6.4): whether onboarding was seen, this phone's
 * device id, and the Drive grant's display state. No token, client ID or secret is ever stored.
 * Excluded from backup by the data extraction rules like everything else.
 */
class AppPreferences(
    private val store: DataStore<Preferences>,
) : AuthStore {
    val onboardingDone: Flow<Boolean> = store.data.map { it[ONBOARDING_DONE] ?: false }

    suspend fun setOnboardingDone() {
        store.edit { it[ONBOARDING_DONE] = true }
    }

    /** This phone's id (a random UUID v4, 16 §4.3), created on first use and kept until the app data is cleared. */
    suspend fun deviceId(): String {
        store.data.first()[DEVICE_ID]?.let { return it }
        var id = ""
        store.edit { prefs ->
            id = prefs[DEVICE_ID] ?: UUID.randomUUID().toString().also { prefs[DEVICE_ID] = it }
        }
        return id
    }

    override suspend fun read(): SavedAuth {
        val p = store.data.first()
        return SavedAuth(
            connected = p[AUTH_CONNECTED] ?: false,
            email = p[AUTH_EMAIL],
            needsReconnect = p[AUTH_NEEDS_RECONNECT] ?: false,
        )
    }

    override suspend fun write(saved: SavedAuth) {
        store.edit { prefs ->
            prefs[AUTH_CONNECTED] = saved.connected
            prefs[AUTH_NEEDS_RECONNECT] = saved.needsReconnect
            if (saved.email != null) prefs[AUTH_EMAIL] = saved.email else prefs.remove(AUTH_EMAIL)
        }
    }

    companion object {
        private val ONBOARDING_DONE = booleanPreferencesKey("onboarding_done")
        private val DEVICE_ID = stringPreferencesKey("device_id")
        private val AUTH_CONNECTED = booleanPreferencesKey("auth_connected")
        private val AUTH_EMAIL = stringPreferencesKey("auth_email")
        private val AUTH_NEEDS_RECONNECT = booleanPreferencesKey("auth_needs_reconnect")

        fun create(file: File): AppPreferences = AppPreferences(PreferenceDataStoreFactory.create(produceFile = { file }))
    }
}
