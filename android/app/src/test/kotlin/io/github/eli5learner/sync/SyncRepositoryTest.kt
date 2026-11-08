package io.github.eli5learner.sync

import io.github.eli5learner.TestDocs
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.AppPreferences
import io.github.eli5learner.data.DocStore
import io.github.eli5learner.data.LibraryIndex
import io.github.eli5learner.data.OfflinePolicy
import io.github.eli5learner.data.SyncOptions
import io.github.eli5learner.data.db.DocumentEntity
import io.github.eli5learner.data.db.Eli5Db
import io.github.eli5learner.drive.SyncErrorCode
import io.github.eli5learner.drive.SyncException
import io.github.eli5learner.importer.HtmlImporter
import io.github.eli5learner.importer.ImportResult
import io.github.eli5learner.inMemoryDb
import io.github.eli5learner.reader.PreviewLease
import io.github.eli5learner.sync.protocol.DeviceRole
import io.github.eli5learner.sync.protocol.InboxState
import io.github.eli5learner.sync.protocol.ManifestFolder
import io.github.eli5learner.sync.protocol.Placement
import io.github.eli5learner.sync.protocol.Platform
import io.github.eli5learner.sync.protocol.RemoteVersionNode
import io.github.eli5learner.sync.protocol.SyncProtocol
import io.github.eli5learner.sync.protocol.VersionChangeKind
import io.github.eli5learner.sync.protocol.VersionTree
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * Library sync on the phone (16 §4.8, §6.4) against an in-memory Drive and in-memory Room:
 * bootstrap, seq regression, eventual consistency, offline policy, re-minted ids, imported copies,
 * integrity, token loss, format, takeover and the phone's own device file.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SyncRepositoryTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var db: Eli5Db
    private lateinit var store: DocStore
    private lateinit var index: LibraryIndex
    private lateinit var prefs: AppPreferences
    private val drive = FakeDrive()
    private var auth: AuthState = AuthState.Connected("reader@example.com")
    private var unmetered = true

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
            deviceWriter = DeviceWriter(drive, prefs, "Pixel 9", "0.1.0", now = { NOW }),
            authState = { auth },
            isUnmetered = { unmetered },
            now = { NOW },
        )

    private fun doc(
        n: Int,
        title: String = "Doc $n",
        updatedAt: String = "2026-11-01T10:00:%02dZ".format(n % 60),
        body: String = "v1",
        placement: Placement = Placement.Unfiled,
        replaces: String? = null,
    ) = MacDoc(
        docId = docId(n),
        title = title,
        html = TestDocs.eli5(docId = docId(n), title = title, script = "document.body.dataset.v='$body';").toByteArray(),
        updatedAt = updatedAt,
        placement = placement,
        replaces = replaces,
    )

    @Test fun `bootstrap lists the store, applies the manifest and trees, downloads current versions and writes the device file`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val folder = ManifestFolder("f-00000001", "Marketing")
            val a = doc(1, placement = Placement.Folder(folder.id))
            val b = doc(2)
            mac.publish(seq = 3, docs = listOf(a, b), folders = listOf(folder))

            val r = repo()
            assertEquals(SyncOutcome.Synced, r.sync())

            val entries = index.load().associateBy { it.key }
            assertEquals(setOf(a.docId, b.docId), entries.keys)
            val ea = entries.getValue(a.docId)
            assertTrue(ea.synced)
            assertEquals(a.sha, ea.sha)
            assertEquals(folder.id, ea.folderId)
            assertEquals(listOf("In depth", "ELI5"), ea.tabs)
            assertFalse("the first manifest marks nothing unread", ea.unread)
            assertArrayEquals(a.html, store.read(a.docId, a.sha))
            assertEquals(listOf("Marketing"), db.folders().all().map { it.name })
            assertEquals(listOf("v-000000000001"), db.versions().forDoc(a.docId).map { it.id })
            assertEquals(3L, prefs.cursor().manifestSeq)
            assertNotNull(prefs.cursor().startToken)

            // The Mac's heartbeat and inbox state reach the status sheet.
            val mac0 = r.status.value.mac!!
            assertEquals("Studio", mac0.name)
            assertEquals(1_800_000_000_000L, mac0.lastSeenMs)
            assertEquals(InboxState.ON, mac0.inbox)
            assertEquals(0, r.status.value.pendingDownloads)

            // The phone's own device file: role phone, no jobs, no inbox, a heartbeat.
            val me = prefs.deviceId()
            val own = drive.byKind("device").single { it.meta.appProperties?.get("dev") == me }
            val record = SyncProtocol.decodeDevice(own.body.decodeToString())
            assertEquals(Platform.ANDROID, record.platform)
            assertEquals(DeviceRole.PHONE, record.role)
            assertEquals(emptyList<Any>(), record.accepts)
            assertEquals((NOW / 1000).toString(), own.meta.appProperties?.get("seen"))
            assertEquals(own.meta.id, prefs.cursor().deviceFileId)
        }

    @Test fun `a steady-state pass uses the change feed and only touches the device file`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            mac.publish(1, listOf(doc(1)))
            val r = repo()
            r.sync()
            drive.calls.clear()

            assertEquals(SyncOutcome.Synced, r.sync())
            assertEquals(listOf("changes", "patchProperties"), drive.calls)
        }

    @Test fun `a manifest whose seq is not greater than the one held is ignored`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            mac.publish(5, listOf(doc(1, title = "Current")))
            val r = repo()
            r.sync()

            // A stale manifest (lower seq) with a truthful n, then one whose n lies (n higher, seq lower).
            mac.writeLib(4, mac.manifest(4, listOf(doc(1, title = "Stale"))))
            r.sync()
            mac.writeLib(9, mac.manifest(5, listOf(doc(1, title = "Same seq"))), nProp = 9)
            r.sync()
            assertEquals("Current", index.find(docId(1))!!.title)
            assertEquals(5L, prefs.cursor().manifestSeq)

            mac.publish(6, listOf(doc(1, title = "Newer")))
            r.sync()
            assertEquals("Newer", index.find(docId(1))!!.title)
        }

    @Test fun `a blob the listing does not show yet is retried on the next pass without an error`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val a = doc(1)
            val blobs = mac.publish(1, listOf(a), hideBlobs = setOf(a.docId))
            val r = repo()

            assertEquals(SyncOutcome.Synced, r.sync())
            val e = index.find(a.docId)!!
            assertFalse(e.available)
            assertNull(r.status.value.problem)
            assertEquals(1, r.status.value.pendingDownloads)

            drive.reveal(blobs.getValue(a.docId))
            assertEquals(SyncOutcome.Synced, r.sync())
            assertEquals(a.sha, index.find(a.docId)!!.sha)
            assertEquals(0, r.status.value.pendingDownloads)
        }

    @Test fun `the offline policy decides which current versions download eagerly`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val docs = (1..22).map { doc(it, updatedAt = "2026-11-01T10:%02d:00Z".format(it)) }
            mac.publish(1, docs)
            val r = repo()

            prefs.setOptions(SyncOptions(offlinePolicy = OfflinePolicy.PINNED))
            r.sync()
            assertTrue(index.load().none { it.available })
            assertEquals(0, r.status.value.pendingDownloads)

            index.setPinned(docId(3), true)
            r.sync()
            assertEquals(listOf(docId(3)), index.load().filter { it.available }.map { it.key })

            prefs.setOptions(SyncOptions(offlinePolicy = OfflinePolicy.RECENT))
            r.sync()
            val available = index.load().filter { it.available }.map { it.key }.toSet()
            // The 20 most recently updated (3..22), plus the pinned one (already among them).
            assertEquals((3..22).map { docId(it) }.toSet(), available)

            prefs.setOptions(SyncOptions(offlinePolicy = OfflinePolicy.ALL))
            r.sync()
            assertTrue(index.load().all { it.available })
        }

    @Test fun `large downloads wait for an unmetered network when Wi-Fi only is on`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val big = doc(1, body = "x".repeat(6 * 1024 * 1024))
            // gzip shrinks repetition; give the listing the size the Mac would report for a large blob.
            val blobs = mac.publish(1, listOf(big))
            drive.files.getValue(blobs.getValue(big.docId)).let { it.meta = it.meta.copy(size = (6L * 1024 * 1024).toString()) }
            unmetered = false
            val r = repo()

            r.sync()
            assertFalse(index.find(big.docId)!!.available)
            assertEquals(1, r.status.value.pendingDownloads)

            // Opening it fetches it anyway: the user asked.
            assertEquals(SyncRepository.FetchResult.OK, r.fetch(big.docId))
            assertTrue(index.find(big.docId)!!.available)
        }

    @Test fun `a re-minted id replaces the old entry and keeps its pin`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val old = doc(1, title = "Before")
            mac.publish(1, listOf(old))
            val r = repo()
            r.sync()
            index.setPinned(old.docId, true)
            assertTrue(store.exists(old.docId, old.sha))

            val reminted = doc(2, title = "After", replaces = old.docId)
            mac.publish(2, listOf(reminted))
            r.sync()

            val entries = index.load()
            assertEquals(listOf(reminted.docId), entries.map { it.key })
            assertTrue(entries.single().pinned)
            assertFalse("a replacement is not news", entries.single().unread)
            assertFalse(store.exists(old.docId, old.sha))
            assertTrue(db.versions().forDoc(old.docId).isEmpty())
        }

    @Test fun `a synced copy replaces an imported copy of the same document`() =
        runTest {
            val a = doc(1, title = "From the Mac")
            val imported = HtmlImporter(store, index).import(TestDocs.eli5(docId = a.docId, title = "Imported").toByteArray(), "index.html")
            val importedKey = (imported as ImportResult.Imported).entry.key

            TestMac(drive).bootstrap().publish(1, listOf(a))
            repo().sync()

            val entries = index.load()
            assertEquals(listOf(a.docId), entries.map { it.key })
            assertEquals("From the Mac", entries.single().title)
            assertTrue(store.list().none { it.first == importedKey })
        }

    @Test fun `a blob whose content does not match its sha, or is not gzip, is never written`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val a = doc(1)
            val b = doc(2)
            val blobs = mac.publish(1, listOf(a, b))
            drive.files.getValue(blobs.getValue(a.docId)).body = FakeDrive.gzip("tampered".toByteArray())
            drive.files.getValue(blobs.getValue(b.docId)).body = "not gzip".toByteArray()
            val r = repo()

            assertEquals(SyncOutcome.Synced, r.sync())
            assertTrue(store.list().isEmpty())
            assertEquals(2, r.status.value.pendingDownloads)
        }

    @Test fun `a new version marks the document unread and keeps the version a Reader shows`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val v1 = doc(1, body = "one")
            mac.publish(1, listOf(v1))
            val r = repo()
            r.sync()
            index.lease(v1.docId, v1.sha)

            val v2 = doc(1, body = "two").copy(versionId = "v-000000000002")
            mac.publish(2, listOf(v2))
            r.sync()

            val e = index.find(v1.docId)!!
            assertEquals(v2.sha, e.sha)
            assertTrue(e.unread)
            assertTrue("the leased version stays", store.exists(v1.docId, v1.sha))

            index.release(v1.docId, v1.sha)
            index.markOpened(v1.docId)
            assertFalse(index.find(v1.docId)!!.unread)
            mac.publish(3, listOf(doc(1, body = "three").copy(versionId = "v-000000000003")))
            r.sync()
            assertFalse("released versions are pruned", store.exists(v1.docId, v1.sha))
        }

    @Test fun `documents that leave the manifest leave the phone, Trash stays hidden but listed`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            mac.publish(1, listOf(doc(1), doc(2), doc(3)))
            val r = repo()
            r.sync()

            mac.publish(2, listOf(doc(1), doc(2, placement = Placement.Trash)))
            r.sync()
            val entries = index.load().associateBy { it.key }
            assertEquals(setOf(docId(1), docId(2)), entries.keys)
            assertTrue(entries.getValue(docId(2)).trashed)
            assertFalse(store.list().any { it.first == docId(3) })
        }

    @Test fun `an expired change token triggers a full rescan`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            mac.publish(1, listOf(doc(1)))
            val r = repo()
            r.sync()
            mac.publish(2, listOf(doc(1), doc(2)))
            drive.expiredBelow = Int.MAX_VALUE
            drive.calls.clear()

            assertEquals(SyncOutcome.Synced, r.sync())
            assertEquals(listOf("changes", "startPageToken", "list"), drive.calls.take(3))
            assertEquals(2, index.load().size)
        }

    @Test fun `local mode makes no request, and a lost grant stops without one`() =
        runTest {
            TestMac(drive).bootstrap()
            auth = AuthState.Disconnected
            assertEquals(SyncOutcome.NotConnected, repo().sync())
            auth = AuthState.NeedsReconnect("reader@example.com")
            val r = repo()
            assertEquals(SyncOutcome.NeedsReconnect, r.sync())
            assertEquals(SyncProblem.NEEDS_RECONNECT, r.status.value.problem)
            assertTrue(drive.calls.isEmpty())
        }

    @Test fun `Drive errors map to outcomes the worker understands`() =
        runTest {
            TestMac(drive).bootstrap()
            val r = repo()
            drive.failNext = SyncException(SyncErrorCode.E_SYNC_HTTP, "Network error")
            assertEquals(SyncOutcome.Transient(SyncErrorCode.E_SYNC_HTTP), r.sync())
            assertEquals(SyncProblem.OFFLINE, r.status.value.problem)
            drive.failNext = SyncException(SyncErrorCode.E_SYNC_AUTH, status = 401)
            assertEquals(SyncOutcome.NeedsReconnect, r.sync())
            assertEquals(SyncOutcome.Synced, r.sync())
            assertNull(r.status.value.problem)
        }

    @Test fun `a store written by a newer app is left alone`() =
        runTest {
            drive.put("sync-info.json", mapOf("k" to "info", "dev" to TestMac.MAC_ID), """{"formatVersion":2,"minReaderVersion":2}""".toByteArray())
            val mac = TestMac(drive).bootstrap(withInfo = false)
            mac.publish(1, listOf(doc(1)))
            val r = repo()
            assertEquals(SyncOutcome.FormatTooNew, r.sync())
            assertEquals(SyncProblem.FORMAT_TOO_NEW, r.status.value.problem)
            assertTrue(index.load().isEmpty())
            assertTrue("nothing is written", drive.byKind("device").none { it.meta.appProperties?.get("dev") != TestMac.MAC_ID })
        }

    @Test fun `with no Mac yet the phone waits and still says hello`() =
        runTest {
            val r = repo()
            assertEquals(SyncOutcome.Synced, r.sync())
            assertTrue(r.status.value.waitingForMac)
            assertEquals(1, drive.byKind("device").size)
        }

    @Test fun `readers follow the newest claim's device`() =
        runTest {
            val old = TestMac(drive).bootstrap()
            old.publish(5, listOf(doc(1, title = "Old primary")))
            val r = repo()
            r.sync()

            val newId = "22222222-2222-4222-8222-222222222222"
            val next = TestMac(drive, deviceId = newId, claimMs = 2_000).bootstrap(withInfo = false)
            // Until the new primary writes its manifest, the phone keeps what it has.
            r.sync()
            assertEquals("Old primary", index.find(docId(1))!!.title)
            // The new primary continues above the old seq (16 §4.5 step 3).
            next.publish(6, listOf(doc(1, title = "New primary")))
            old.publish(7, listOf(doc(1, title = "Old primary, still writing")))
            r.sync()
            assertEquals("New primary", index.find(docId(1))!!.title)
            assertEquals("Studio", r.status.value.mac?.name)
        }

    @Test fun `the device file is created once under a persisted id and recreated if it disappears`() =
        runTest {
            TestMac(drive).bootstrap()
            val r = repo()
            r.sync()
            val first = prefs.cursor().deviceFileId!!
            r.sync()
            assertEquals(first, prefs.cursor().deviceFileId)
            assertEquals(1, drive.calls.count { it == "create" })

            drive.remove(first)
            r.sync()
            val second = prefs.cursor().deviceFileId!!
            assertTrue(second != first)
            assertEquals(1, drive.byKind("device").count { it.meta.appProperties?.get("dev") == prefs.deviceId() })
        }

    @Test fun `forget drops the remote index so the next sync lists from scratch`() =
        runTest {
            TestMac(drive).bootstrap().publish(1, listOf(doc(1)))
            val r = repo()
            r.sync()
            r.forget()
            assertNull(prefs.cursor().startToken)
            assertEquals(0, db.remoteFiles().count())
            assertEquals(1, index.load().size)
            drive.calls.clear()
            r.sync()
            assertTrue(drive.calls.contains("list"))
        }

    @Test fun `a database rebuilt from files accepts the current manifest again`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val a = doc(1, title = "Kept")
            mac.publish(4, listOf(a))
            repo().sync()

            // A new database (schema change): only the files remain.
            db.close()
            db = inMemoryDb()
            index = LibraryIndex(db, store)
            assertEquals(DocumentEntity.SOURCE_SYNCED, index.load().single().source)
            repo().sync()
            val e = index.find(a.docId)!!
            assertEquals("Kept", e.title)
            assertEquals("About Kept", e.summary)
        }

    @Test fun `a disk that cannot take a document leaves it pending and never throws`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val a = doc(1)
            val b = doc(2)
            mac.publish(1, listOf(a, b))
            // A plain file where the document's folder should go: the write fails with an IOException.
            File(store.root, a.docId).writeText("in the way")
            val r = repo()

            assertEquals(SyncOutcome.Synced, r.sync())
            assertEquals(1, r.status.value.pendingDownloads)
            assertEquals(b.sha, index.find(b.docId)!!.sha)
            assertNull(index.find(a.docId)!!.sha)
        }

    @Test fun `a file without a listed size is still read within its cap`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            mac.publish(1, listOf(doc(1)))
            // A device file whose listing has no size and whose body is over the 4 MiB cap.
            val f = drive.files.getValue(mac.deviceFileId!!)
            f.body = ByteArray((SyncRepository.MAX_JSON_BYTES + 1).toInt()) { ' '.code.toByte() }
            f.meta = f.meta.copy(size = null)
            val r = repo()

            assertEquals(SyncOutcome.Synced, r.sync())
            assertNull("an oversized device file is skipped, not parsed", r.status.value.mac)
            assertEquals(1, index.load().size)
        }

    @Test fun `connecting another account forgets the old account's cursors, reconnecting the same one does not`() =
        runTest {
            TestMac(drive).bootstrap().publish(1, listOf(doc(1)))
            val r = repo()
            r.sync()

            suspend fun reconnect(to: String): List<String> {
                drive.calls.clear()
                auth = AuthState.Connected(to)
                val states = MutableStateFlow<AuthState>(AuthState.NeedsReconnect("reader@example.com"))
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                try {
                    SyncScheduler(r, { null }, scope).start(states)
                    withContext(Dispatchers.Default) {
                        withTimeout(10_000) { while (states.subscriptionCount.value == 0) delay(10) }
                        delay(50)
                    }
                    states.value = AuthState.Connected(to)
                    withContext(Dispatchers.Default) {
                        withTimeout(10_000) { while (drive.calls.none { it == "patchProperties" }) delay(10) }
                    }
                    return drive.calls.toList()
                } finally {
                    scope.cancel()
                }
            }

            val same = reconnect("Reader@example.com")
            assertTrue(same.contains("changes"))
            assertFalse(same.contains("list"))

            val other = reconnect("someone@example.com")
            assertTrue("a different account starts from a full listing", other.contains("list"))
        }

    @Test fun `an older uploaded version downloads on demand for a preview and is dropped afterwards`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val v1 = doc(1, body = "first")
            mac.publish(1, listOf(v1))
            val r = repo()
            r.sync()
            val v2 = doc(1, body = "second").copy(versionId = "v-000000000002")
            mac.publish(2, listOf(v2))
            // The Mac's tree now holds both versions; the first is uploaded, a third one is not.
            val tree =
                VersionTree(
                    1,
                    v1.docId,
                    3,
                    "v-000000000002",
                    listOf(
                        RemoteVersionNode("v-000000000001", null, VersionChangeKind.INITIAL, "Original", "2026-11-01T10:00:00Z", v1.sha, true),
                        RemoteVersionNode("v-000000000002", "v-000000000001", VersionChangeKind.EXPAND, "Expanded", "2026-11-01T10:01:00Z", v2.sha, true),
                        RemoteVersionNode("v-000000000003", "v-000000000001", VersionChangeKind.ANALOGY, "Analogy", "2026-11-01T10:02:00Z", "e".repeat(64), false),
                    ),
                )
            val treeFile = drive.byKind("tree").single()
            val props = mapOf("k" to "tree", "dev" to TestMac.MAC_ID, "d" to v1.docId, "n" to "3")
            drive.rewrite(treeFile.meta.id, SyncProtocol.encode(VersionTree.serializer(), tree).toByteArray(), props)
            r.sync()
            assertEquals(v2.sha, index.find(v1.docId)!!.sha)
            assertFalse("the old copy was pruned when the new one arrived", store.exists(v1.docId, v1.sha))
            assertEquals(3, db.versions().forDoc(v1.docId).size)

            index.lease(v1.docId, v1.sha)
            assertEquals(SyncRepository.FetchResult.OK, r.fetchVersion(v1.docId, v1.sha))
            assertArrayEquals(v1.html, store.read(v1.docId, v1.sha))
            assertEquals("the current copy is untouched", v2.sha, index.find(v1.docId)!!.sha)
            // A pass while the preview is open keeps it.
            r.sync()
            assertTrue(store.exists(v1.docId, v1.sha))
            // Not uploaded, or not in the tree: nothing to download.
            assertEquals(SyncRepository.FetchResult.MISSING, r.fetchVersion(v1.docId, "e".repeat(64)))
            assertEquals(SyncRepository.FetchResult.MISSING, r.fetchVersion(v1.docId, "f".repeat(64)))

            index.release(v1.docId, v1.sha)
            index.dropPreview(v1.docId, v1.sha)
            assertFalse(store.exists(v1.docId, v1.sha))
            assertTrue(store.exists(v1.docId, v2.sha))
            // The current copy is never dropped as a preview.
            index.dropPreview(v1.docId, v2.sha)
            assertTrue(store.exists(v1.docId, v2.sha))

            // A blob whose bytes do not hash to its sha is refused and never written.
            val blob = drive.byKind("blob").single { it.meta.appProperties?.get("s") == v1.sha }
            drive.rewrite(blob.meta.id, FakeDrive.gzip("<html>planted</html>".toByteArray()))
            assertEquals(SyncRepository.FetchResult.FAILED, r.fetchVersion(v1.docId, v1.sha))
            assertFalse(store.exists(v1.docId, v1.sha))
            // A key that is not a synced document, or a malformed sha, is refused before any listing.
            assertEquals(SyncRepository.FetchResult.FAILED, r.fetchVersion("../" + v1.docId, v1.sha))
            assertEquals(SyncRepository.FetchResult.FAILED, r.fetchVersion(v1.docId, "../x"))

            auth = AuthState.Disconnected
            assertEquals(SyncRepository.FetchResult.NOT_CONNECTED, r.fetchVersion(v1.docId, v1.sha))
        }

    @Test fun `a preview's lease lasts as long as its navigation entry, through rotation`() =
        runTest {
            val mac = TestMac(drive).bootstrap()
            val v1 = doc(1, body = "first")
            mac.publish(1, listOf(v1))
            repo().sync()
            val html = "<html>older</html>".toByteArray()
            val sha = store.write(v1.docId, html)
            val dropScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
            val owner = ViewModelStore()
            val lease =
                ViewModelProvider.create(owner, PreviewLease.factory(index, v1.docId, sha, dropScope))[PreviewLease::class.java]
            assertNotNull(lease)
            assertTrue(sha in index.leased(v1.docId))
            // A Reader composed, disposed (rotation) and composed again keeps the entry's lease.
            index.lease(v1.docId, sha)
            index.release(v1.docId, sha)
            assertTrue(sha in index.leased(v1.docId))
            index.dropPreview(v1.docId, sha)
            assertTrue("leased: not dropped", store.exists(v1.docId, sha))
            // The entry leaves the back stack: the lease ends and the copy goes; the current one stays.
            owner.clear()
            withTimeout(5_000) { while (store.exists(v1.docId, sha)) delay(10) }
            assertFalse(sha in index.leased(v1.docId))
            assertTrue(store.exists(v1.docId, v1.sha))
            dropScope.cancel()
        }

    private companion object {
        const val NOW = 1_800_000_100_000L

        fun docId(n: Int) = "aaaaaaaa-0000-4000-8000-%012d".format(n)
    }
}
