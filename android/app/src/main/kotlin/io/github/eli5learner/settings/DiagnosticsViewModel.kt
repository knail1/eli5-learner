package io.github.eli5learner.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.data.DocEntry
import io.github.eli5learner.data.LocalIndex
import io.github.eli5learner.drive.DriveProbe
import io.github.eli5learner.drive.SyncException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ProbeUiState(
    val busy: Boolean = false,
    val log: List<String> = emptyList(),
    val changeToken: String? = null,
)

/**
 * Settings > Diagnostics: counts, plus the debug-only Drive probe for gate G1 (16 §13). The probe log
 * holds counts, probe file names and error codes only; never tokens or other file names.
 */
class DiagnosticsViewModel(
    private val index: LocalIndex,
    private val probe: DriveProbe,
    private val deviceId: suspend () -> String,
) : ViewModel() {
    val documents: StateFlow<List<DocEntry>> = index.entries

    private val _probe = MutableStateFlow(ProbeUiState())
    val probeState: StateFlow<ProbeUiState> = _probe.asStateFlow()

    init {
        viewModelScope.launch { index.load() }
    }

    fun write() =
        run("write") {
            val id = probe.write(deviceId())
            listOf("wrote ${DriveProbe.PHONE_PROBE} (id …${id.takeLast(6)})")
        }

    fun list() =
        run("list") {
            val l = probe.list()
            listOf("app folder: ${l.total} files, ${l.probes.size} probes") + l.probes.map { "  ${it.name} · ${it.size ?: "?"} bytes" }
        }

    fun read() =
        run("read") {
            val text = probe.readDesktopProbe()
            if (text == null) listOf("${DriveProbe.DESKTOP_PROBE}: not found") else listOf("${DriveProbe.DESKTOP_PROBE}: $text")
        }

    fun startChanges() =
        run("start") {
            val token = probe.startToken()
            _probe.update { it.copy(changeToken = token) }
            listOf("change feed started")
        }

    fun checkChanges() {
        val token = _probe.value.changeToken ?: return
        run("changes") {
            val (lines, next) = probe.changesSince(token)
            _probe.update { it.copy(changeToken = next) }
            listOf("changes: ${lines.size}") + lines.map { "  $it" }
        }
    }

    fun deleteOwn() = run("delete") { listOf("deleted ${probe.deleteOwn(deviceId())} probe file(s)") }

    fun clear() = _probe.update { it.copy(log = emptyList()) }

    private fun run(
        label: String,
        block: suspend () -> List<String>,
    ) {
        if (_probe.value.busy) return
        _probe.update { it.copy(busy = true) }
        viewModelScope.launch {
            val lines =
                try {
                    block()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: SyncException) {
                    listOf("$label failed: ${e.code}${e.status?.let { " (HTTP $it)" } ?: ""}")
                } catch (e: Exception) {
                    listOf("$label failed: ${e.javaClass.simpleName}")
                }
            _probe.update { it.copy(busy = false, log = (it.log + lines).takeLast(MAX_LOG)) }
        }
    }

    companion object {
        private const val MAX_LOG = 200

        fun factory(
            index: LocalIndex,
            probe: DriveProbe,
            deviceId: suspend () -> String,
        ): ViewModelProvider.Factory = viewModelFactory { initializer { DiagnosticsViewModel(index, probe, deviceId) } }
    }
}
