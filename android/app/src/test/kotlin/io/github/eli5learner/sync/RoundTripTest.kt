package io.github.eli5learner.sync

import androidx.test.core.app.ApplicationProvider
import io.github.eli5learner.TestDocs
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.AppPreferences
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.inMemoryDb
import io.github.eli5learner.reader.DocWebViewFactory
import io.github.eli5learner.reader.UrlPolicy
import io.github.eli5learner.versions.VersionsViewModel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/**
 * The phone half of the sync round trip (16 §12, S10 mobile parity). The desktop's engine pushed a
 * library to its fake Drive and recorded every file in `test/contracts/sync/roundtrip/library.json`
 * (test/unit/main/sync/roundtrip.test.ts): an old two-tab document, and a document rebuilt as a new
 * version of itself with an ASD-STE100 tab, a section ELI5 tab and sandboxed animation frames. This
 * test loads exactly those files into the phone's fake Drive, syncs, and opens the result in the
 * reader: the bytes, tabs, History and the reader's no-network policy must all hold.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RoundTripTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var store: DocStore
    private lateinit var index: LibraryIndex
    private lateinit var prefs: AppPreferences
    private val drive = FakeDrive()

    @Before fun setUp() {
        db = inMemoryDb()
        store = DocStore(tmp.newFolder("docs"))
        index = LibraryIndex(db, store)
        prefs = AppPreferences.create(File(tmp.root, "settings.preferences_pb"))
    }

    @After fun tearDown() = db.close()

    private fun repo() =
        SyncRepository(
            db = db,
            index = index,
            store = store,
            drive = drive,
            prefs = prefs,
            deviceWriter = DeviceWriter(drive, prefs, "Pixel 9", "0.4.0", now = { NOW }),
            authState = { AuthState.Connected("reader@example.com") },
            isUnmetered = { true },
            now = { NOW },
        )

    /** Puts the desktop's files into the fake Drive, in the order the desktop wrote them. */
    private fun loadDesktopPush() {
        val contract =
            requireNotNull(javaClass.getResourceAsStream("/sync/roundtrip/library.json")) { "missing sync/roundtrip/library.json" }
                .use { Json.parseToJsonElement(it.readBytes().toString(Charsets.UTF_8)).jsonObject }
        for (f in contract.getValue("files").jsonArray.map { it.jsonObject }) {
            val props = f.getValue("appProperties").jsonObject.mapValues { it.value.jsonPrimitive.content }
            val body =
                (f["html"]?.jsonPrimitive?.content)?.let { FakeDrive.gzip(TestDocs.fixture(it)) }
                    ?: f.getValue("text").jsonPrimitive.content.toByteArray()
            drive.put(f.getValue("name").jsonPrimitive.content, props, body)
        }
    }

    private fun manifestDocIdOf(title: String): String {
        val lib = drive.byKind("lib").single().body.toString(Charsets.UTF_8)
        return Json
            .parseToJsonElement(lib)
            .jsonObject
            .getValue("docs")
            .jsonArray
            .map { it as JsonObject }
            .single { it.getValue("title").jsonPrimitive.content == title }
            .getValue("docId")
            .jsonPrimitive.content
    }

    @Test fun `a rebuilt three-tab document with animations arrives byte-identical as a new version`() =
        runTest {
            loadDesktopPush()
            val r = repo()
            assertEquals(SyncOutcome.Synced, r.sync())

            val withSte = TestDocs.fixture("with-ste.html")
            val rebuiltId = manifestDocIdOf("Getting a widget to the door")
            val rebuilt = index.find(rebuiltId)!!
            assertTrue(rebuilt.synced)
            assertFalse("an ELI5 document, so its pinned scripts may run", rebuilt.foreign)
            assertEquals(DocStore.sha256Hex(withSte), rebuilt.sha)
            assertArrayEquals(withSte, store.read(rebuiltId, rebuilt.sha!!))
            // The Mac still leaves 'ste' out of the manifest for 0.3.0 phones; the labels come from the document.
            assertEquals(listOf("In depth", "ELI5", "ASD-STE100", "ELI5: From click to doorstep"), rebuilt.tabs)

            // The old two-tab document is unchanged.
            val old = index.find(manifestDocIdOf("Where the ad money goes"))!!
            assertFalse(old.foreign)
            assertEquals(listOf("In depth", "ELI5"), old.tabs)
            assertArrayEquals(TestDocs.fixture("full.html"), store.read(old.key, old.sha!!))

            // The desktop's device file carries its app version; this push came from a 0.4.0 Mac, which
            // does not read `deadpan`, so the phone would not offer the Deadpan tab.
            assertEquals("0.4.0", r.status.value.mac?.appVersion)
            assertFalse(io.github.eli5learner.util.AppVersions.macTakesDeadpan(r.status.value.mac?.appVersion))

            // History: the rebuild is the current child of the first version, and both can be read.
            val state = VersionsViewModel.stateOf(rebuilt, db.versions().forDoc(rebuiltId), r.status.value.mac, emptySet()) { false }
            assertEquals(2, state.items.size)
            val (first, rebuild) = state.items
            assertEquals("first version", first.label)
            assertEquals("outside", rebuild.kind)
            assertEquals("Rebuilt with prompt set default (0123abcd)", rebuild.label)
            assertTrue(rebuild.row.isCurrent)
            assertTrue(first.available && rebuild.available)

            // The first version downloads on demand for a preview, byte-identical too.
            val showcase = TestDocs.fixture("showcase.html")
            index.lease(rebuiltId, first.sha!!)
            assertEquals(SyncRepository.FetchResult.OK, r.fetchVersion(rebuiltId, first.sha!!))
            assertArrayEquals(showcase, store.read(rebuiltId, first.sha!!))
        }

    @Test fun `the reader serves the rebuilt document with its frame scripts pinned and nothing else reachable`() =
        runTest {
            loadDesktopPush()
            repo().sync()
            val id = manifestDocIdOf("Getting a widget to the door")
            val entry = index.find(id)!!
            val html = store.read(id, entry.sha!!)!!.toString(Charsets.UTF_8)
            val docUrl = UrlPolicy.docUrl(id, entry.sha!!)

            val external = mutableListOf<String>()
            val view =
                DocWebViewFactory.create(
                    context = ApplicationProvider.getApplicationContext(),
                    store = store,
                    docUrl = docUrl,
                    foreign = entry.foreign,
                    onExternal = { external += it },
                    onHistoryChanged = {},
                    onRendererGone = {},
                )
            assertTrue(view.settings.javaScriptEnabled)
            view.loadUrl(docUrl)
            assertEquals(docUrl, shadowOf(view).lastLoadedUrl)
            val client = shadowOf(view).webViewClient as DocWebViewFactory.Client

            // The document itself, with the CSP header pinning the runtime and both frames' scripts.
            val page = client.intercept(docUrl)
            assertEquals(200, page.statusCode)
            assertArrayEquals(html.toByteArray(), page.data.readBytes())
            val csp = page.responseHeaders.getValue("Content-Security-Policy")
            val hashes = HtmlImporter.inspect(html).scriptHashes
            assertEquals("runtime, frame shell, frame code (both frames share them)", 3, hashes.size)
            assertTrue(csp, csp.contains("script-src ${hashes.joinToString(" ")};"))
            for (d in listOf("default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'")) {
                assertTrue(d, csp.contains(d))
            }
            assertEquals(2, Regex("<iframe sandbox=\"allow-scripts\" srcdoc=\"").findAll(html).count())
            assertTrue("the STE hint is in the page, visible without JavaScript", html.contains("id=\"tab-hint-ste\""))

            // An animation frame may load its srcdoc; nothing it (or the page) asks for reaches the network.
            assertFalse(client.decide(UrlPolicy.SRCDOC, hasGesture = false, isMainFrame = false))
            assertTrue(client.decide(UrlPolicy.SRCDOC, hasGesture = true, isMainFrame = true))
            for (u in listOf("https://example.com/beacon", "http://example.com/x.png", "data:text/html,hi", "blob:https://x/y", "about:blank")) {
                assertTrue(u, client.decide(u, hasGesture = false, isMainFrame = false))
                assertEquals(u, 403, client.intercept(u).statusCode)
            }
            assertTrue(external.isEmpty())
            view.destroy()
        }

    private companion object {
        /** Ten minutes after the desktop's push (2026-11-08T12:00:00Z). */
        const val NOW = 1_794_139_800_000L
    }
}
