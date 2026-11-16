package io.github.eli5learner.share

import androidx.core.content.FileProvider
import java.lang.reflect.Modifier

/**
 * FileProvider caches each authority's roots in a static map. Robolectric gives every test a new
 * data folder but keeps loaded classes across tests, so a cached `cacheDir` from an earlier test
 * would make [ShareIntents.uriFor] reject this test's copies. Tests that build share URIs call
 * [reset] first.
 */
object FileProviderCache {
    fun reset() {
        FileProvider::class.java.declaredFields
            .filter { Modifier.isStatic(it.modifiers) && Map::class.java.isAssignableFrom(it.type) }
            .forEach { f ->
                f.isAccessible = true
                val map = f.get(null) as MutableMap<*, *>
                synchronized(map) { map.clear() }
            }
    }
}
