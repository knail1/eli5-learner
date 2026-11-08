package io.github.eli5learner.reader

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.eli5learner.data.LibraryIndex
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Holds an earlier version opened from the Versions sheet (16 §6.2) for as long as its Reader entry
 * is on the back stack. Scoped to the navigation entry, it survives rotation and other configuration
 * changes, so the preview's file is neither pruned by a sync pass nor dropped while the Reader is
 * recreated. The lease starts before the download; when the entry leaves the back stack the lease
 * ends and the downloaded copy is dropped ([LibraryIndex.dropPreview] keeps the phone's own copy, the
 * Mac's current one and anything another Reader still shows).
 */
class PreviewLease(
    private val index: LibraryIndex,
    private val key: String,
    private val sha: String,
    private val scope: CoroutineScope,
) : ViewModel() {
    init {
        index.lease(key, sha)
    }

    override fun onCleared() {
        index.release(key, sha)
        // Not viewModelScope: it is cancelled by now.
        scope.launch { index.dropPreview(key, sha) }
    }

    companion object {
        fun factory(
            index: LibraryIndex,
            key: String,
            sha: String,
            scope: CoroutineScope,
        ): ViewModelProvider.Factory = viewModelFactory { initializer { PreviewLease(index, key, sha, scope) } }
    }
}
