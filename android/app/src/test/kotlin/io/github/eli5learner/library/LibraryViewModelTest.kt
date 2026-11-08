package io.github.eli5learner.library

import android.net.Uri
import io.github.eli5learner.TestDocs
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.inMemoryDb
import io.github.eli5learner.importer.HtmlImporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LibraryViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `imports content URIs only and reports what was skipped`() =
        runTest {
            val store = DocStore(tmp.newFolder("docs"))
            val index = LibraryIndex(inMemoryDb(), store)
            val files =
                mapOf(
                    Uri.parse("content://files/a") to ("a.html" to TestDocs.eli5().toByteArray()),
                    Uri.parse("file:///data/data/io.github.eli5learner/files/library-index.json") to ("x" to "<html></html>".toByteArray()),
                )
            val vm = LibraryViewModel(index, HtmlImporter(store, index), UriReader { files[it] })

            vm.import(files.keys.toList() + Uri.parse("content://files/unreadable"))
            assertEquals(LibraryEvent.Imported(imported = 1, skipped = 2), vm.messages.first())
            assertEquals(listOf("Widgets explained"), index.load().map { it.title })

            vm.import(emptyList())
            assertEquals(LibraryEvent.NothingToImport, vm.messages.first())

            vm.remove(index.load().single().key)
            assertEquals(LibraryEvent.Removed("Widgets explained"), vm.messages.first())
            assertEquals(emptyList<Pair<String, String>>(), store.list())
        }
}
