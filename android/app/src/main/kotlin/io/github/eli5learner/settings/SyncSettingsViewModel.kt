package io.github.eli5learner.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.AppContainer
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.OfflinePolicy
import io.github.eli5learner.data.SyncOptions
import io.github.eli5learner.data.SyncPrefs
import io.github.eli5learner.data.db.DeviceEntity
import io.github.eli5learner.sync.SyncStatus
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Settings > Sync (16 §6.2). */
data class SyncSettingsState(
    val options: SyncOptions = SyncOptions(),
    val status: SyncStatus = SyncStatus(),
    val lastSyncAt: Long? = null,
    /** Macs only (the phone's own record is not listed), newest heartbeat first. */
    val macs: List<DeviceEntity> = emptyList(),
    val storageBytes: Long = 0,
)

class SyncSettingsViewModel(
    private val prefs: SyncPrefs,
    private val index: LibraryIndex,
    status: Flow<SyncStatus>,
    devices: Flow<List<DeviceEntity>>,
    private val syncNow: () -> Unit,
) : ViewModel() {
    private val storage = MutableStateFlow(0L)
    private val events = Channel<Int>(Channel.BUFFERED)

    /** Cleared-copy counts after Clear cache, for a snackbar. */
    val cleared: Flow<Int> = events.receiveAsFlow()

    val state: StateFlow<SyncSettingsState> =
        combine(prefs.options, status, prefs.lastSyncAt, devices, storage) { o, s, t, d, b ->
            SyncSettingsState(
                options = o,
                status = s,
                lastSyncAt = t,
                macs = d.filter { it.platform == "macos" }.sortedByDescending { it.seen ?: 0 },
                storageBytes = b,
            )
        }.stateIn(viewModelScope, SharingStarted.Eagerly, SyncSettingsState())

    init {
        refreshStorage()
    }

    fun setPolicy(policy: OfflinePolicy) =
        update {
            it.copy(offlinePolicy = policy)
        }

    fun setLargeOnWifiOnly(on: Boolean) = update { it.copy(largeOnWifiOnly = on) }

    fun syncNow() = syncNow.invoke()

    fun clearCache() {
        viewModelScope.launch {
            events.send(index.clearDownloads())
            storage.value = index.storageBytes()
        }
    }

    private fun refreshStorage() {
        viewModelScope.launch { storage.value = index.storageBytes() }
    }

    private fun update(change: (SyncOptions) -> SyncOptions) {
        viewModelScope.launch {
            val before = prefs.options.first()
            val after = change(before)
            if (after == before) return@launch
            prefs.setOptions(after)
            // A looser policy (or Wi-Fi rule) may want downloads now.
            syncNow()
        }
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    SyncSettingsViewModel(
                        prefs = container.preferences,
                        index = container.libraryIndex,
                        status = container.syncRepository.status,
                        devices = container.syncRepository.devices,
                        syncNow = { container.syncScheduler.syncNow() },
                    )
                }
            }
    }
}
