package io.github.eli5learner.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
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
 * device id, the Drive grant's display state, and the sync cursors and options ([SyncPrefs]). No
 * access token, client ID or secret is ever stored. Excluded from backup by the data extraction rules
 * like everything else.
 */
class AppPreferences(
    private val store: DataStore<Preferences>,
) : AuthStore,
    SyncPrefs {
    val onboardingDone: Flow<Boolean> = store.data.map { it[ONBOARDING_DONE] ?: false }

    suspend fun setOnboardingDone() {
        store.edit { it[ONBOARDING_DONE] = true }
    }

    /** This phone's id (a random UUID v4, 16 §4.3), created on first use and kept until the app data is cleared. */
    override suspend fun deviceId(): String {
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

    override val options: Flow<SyncOptions> =
        store.data.map { p ->
            SyncOptions(
                offlinePolicy = OfflinePolicy.of(p[OFFLINE_POLICY]),
                largeOnWifiOnly = p[LARGE_ON_WIFI_ONLY] ?: true,
            )
        }

    override val lastSyncAt: Flow<Long?> = store.data.map { it[LAST_SYNC_AT] }

    /**
     * "Learnings ready" notifications (16 §6.1): null until the user was asked (after the first
     * capture), then their answer.
     */
    val readyNotifications: Flow<Boolean?> = store.data.map { it[READY_NOTIFICATIONS] }

    suspend fun readyNotificationsAnswer(): Boolean? = store.data.first()[READY_NOTIFICATIONS]

    suspend fun setReadyNotifications(on: Boolean) {
        store.edit { it[READY_NOTIFICATIONS] = on }
    }

    override suspend fun cursor(): SyncCursor = cursorOf(store.data.first())

    override suspend fun updateCursor(change: (SyncCursor) -> SyncCursor) {
        store.edit { prefs -> writeCursor(prefs, change(cursorOf(prefs))) }
    }

    override suspend fun setOptions(options: SyncOptions) {
        store.edit {
            it[OFFLINE_POLICY] = options.offlinePolicy.id
            it[LARGE_ON_WIFI_ONLY] = options.largeOnWifiOnly
        }
    }

    override suspend fun setLastSyncAt(ms: Long) {
        store.edit { it[LAST_SYNC_AT] = ms }
    }

    override suspend fun resetCursor() {
        store.edit { prefs ->
            writeCursor(prefs, SyncCursor())
            prefs.remove(LAST_SYNC_AT)
        }
    }

    override suspend fun lastMacVersion(): String? = store.data.first()[LAST_MAC_VERSION]

    override suspend fun setLastMacVersion(version: String?) {
        store.edit { if (version != null) it[LAST_MAC_VERSION] = version else it.remove(LAST_MAC_VERSION) }
    }

    private fun cursorOf(p: Preferences) =
        SyncCursor(
            startToken = p[START_TOKEN],
            manifestSeq = p[MANIFEST_SEQ] ?: 0,
            deviceFileId = p[DEVICE_FILE_ID],
            pendingDeviceFileId = p[PENDING_DEVICE_FILE_ID],
            deviceRecordHash = p[DEVICE_RECORD_HASH],
            acksFileId = p[ACKS_FILE_ID],
            pendingAcksFileId = p[PENDING_ACKS_FILE_ID],
            acksHash = p[ACKS_HASH],
        )

    private fun writeCursor(
        prefs: MutablePreferences,
        c: SyncCursor,
    ) {
        fun put(
            key: Preferences.Key<String>,
            value: String?,
        ) {
            if (value != null) prefs[key] = value else prefs.remove(key)
        }
        put(START_TOKEN, c.startToken)
        prefs[MANIFEST_SEQ] = c.manifestSeq
        put(DEVICE_FILE_ID, c.deviceFileId)
        put(PENDING_DEVICE_FILE_ID, c.pendingDeviceFileId)
        put(DEVICE_RECORD_HASH, c.deviceRecordHash)
        put(ACKS_FILE_ID, c.acksFileId)
        put(PENDING_ACKS_FILE_ID, c.pendingAcksFileId)
        put(ACKS_HASH, c.acksHash)
    }

    companion object {
        private val START_TOKEN = stringPreferencesKey("sync_start_token")
        private val MANIFEST_SEQ = longPreferencesKey("sync_manifest_seq")
        private val DEVICE_FILE_ID = stringPreferencesKey("sync_device_file_id")
        private val PENDING_DEVICE_FILE_ID = stringPreferencesKey("sync_pending_device_file_id")
        private val DEVICE_RECORD_HASH = stringPreferencesKey("sync_device_record_hash")
        private val ACKS_FILE_ID = stringPreferencesKey("sync_acks_file_id")
        private val PENDING_ACKS_FILE_ID = stringPreferencesKey("sync_pending_acks_file_id")
        private val ACKS_HASH = stringPreferencesKey("sync_acks_hash")
        private val READY_NOTIFICATIONS = booleanPreferencesKey("ready_notifications")
        private val LAST_SYNC_AT = longPreferencesKey("sync_last_at")
        private val LAST_MAC_VERSION = stringPreferencesKey("sync_last_mac_version")
        private val OFFLINE_POLICY = stringPreferencesKey("sync_offline_policy")
        private val LARGE_ON_WIFI_ONLY = booleanPreferencesKey("sync_large_on_wifi_only")
        private val ONBOARDING_DONE = booleanPreferencesKey("onboarding_done")
        private val DEVICE_ID = stringPreferencesKey("device_id")
        private val AUTH_CONNECTED = booleanPreferencesKey("auth_connected")
        private val AUTH_EMAIL = stringPreferencesKey("auth_email")
        private val AUTH_NEEDS_RECONNECT = booleanPreferencesKey("auth_needs_reconnect")

        fun create(file: File): AppPreferences = AppPreferences(PreferenceDataStoreFactory.create(produceFile = { file }))
    }
}
