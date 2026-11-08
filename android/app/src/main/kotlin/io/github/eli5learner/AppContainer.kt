package io.github.eli5learner

import android.content.Context
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LocalIndex
import io.github.eli5learner.importer.HtmlImporter
import java.io.File

/**
 * Manual dependency injection (16 §6.1). One instance per process, owned by [Eli5App]. Local mode
 * only: documents under `filesDir/docs`, a JSON index beside them, the importer. Sync adds its
 * pieces here in later slices.
 */
class AppContainer(
    filesDir: File,
) {
    val docStore = DocStore(File(filesDir, "docs"))
    val localIndex = LocalIndex(File(filesDir, "library-index.json"), docStore)
    val importer = HtmlImporter(docStore, localIndex)

    companion object {
        fun from(context: Context): AppContainer = (context.applicationContext as Eli5App).container
    }
}
