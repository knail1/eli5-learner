package io.github.eli5learner.sync.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The shared sync contract (16 §12): the golden fixtures in test/contracts/sync/fixtures, put on the
 * test classpath by app/build.gradle.kts, are the same files Vitest checks against the desktop's zod
 * schemas. The phone must accept every valid one and reject every invalid one.
 */
class FixturesTest {
    @Serializable
    private data class Entry(
        val file: String,
        val type: String,
        val valid: Boolean,
    )

    @Serializable
    private data class Index(
        val fixtures: List<Entry>,
    )

    @Serializable
    private data class LayoutRow(
        val id: String,
        val level: Int,
        val groupId: String?,
        val isCurrent: Boolean,
        val onCurrentPath: Boolean,
        val hasChildren: Boolean,
        val expanded: Boolean,
        val forced: Boolean,
        val branchStart: Boolean,
        val laneEnd: Boolean,
        val setsize: Int,
        val posinset: Int,
    )

    @Serializable
    private data class LayoutFixture(
        val tree: kotlinx.serialization.json.JsonElement,
        val collapsed: List<String>,
        val rows: List<LayoutRow>,
    )

    private fun resource(path: String): String =
        requireNotNull(javaClass.getResourceAsStream("/sync/$path")) { "missing test resource sync/$path" }
            .use { it.readBytes().toString(Charsets.UTF_8) }

    private fun read(file: String): String = resource("fixtures/$file")

    private val index: List<Entry> = Json.decodeFromString<Index>(read("index.json")).fixtures
    private val protocol = index.filter { it.type != "layout" }

    @Test fun `the index covers every file type with valid and invalid fixtures`() {
        assertTrue(protocol.size > 50)
        for (type in SyncFileType.entries) {
            assertTrue("${type.id} valid", protocol.any { it.type == type.id && it.valid })
            assertTrue("${type.id} invalid", protocol.any { it.type == type.id && !it.valid })
        }
        assertEquals(SyncFileType.entries.map { it.id }.toSet() + "layout", index.map { it.type }.toSet())
    }

    @Test fun `accepts every valid fixture and re-encodes it to the same JSON`() {
        for (e in protocol.filter { it.valid }) {
            val text = read(e.file)
            val type = SyncFileType.of(e.type)
            val value =
                try {
                    SyncProtocol.decode(type, text)
                } catch (x: ProtocolException) {
                    fail("${e.file} rejected: ${x.message}")
                    return
                }
            @Suppress("UNCHECKED_CAST")
            val encoded = SyncProtocol.encode(type.serializer as kotlinx.serialization.KSerializer<Validated>, value)
            assertEquals(e.file, Json.parseToJsonElement(text), Json.parseToJsonElement(encoded))
        }
    }

    @Test fun `rejects every invalid fixture`() {
        val accepted =
            protocol.filter { !it.valid }.filter { e ->
                try {
                    SyncProtocol.decode(SyncFileType.of(e.type), read(e.file))
                    true
                } catch (_: ProtocolException) {
                    false
                }
            }
        assertEquals("invalid fixtures that parsed", emptyList<String>(), accepted.map { it.file })
    }

    @Test fun `layout fixtures hold valid trees and lay out every visible node once`() {
        val layouts = index.filter { it.type == "layout" }
        assertTrue(layouts.size >= 5)
        for (e in layouts) {
            val f = Json.decodeFromString<LayoutFixture>(read(e.file))
            val tree = SyncProtocol.decodeTree(f.tree.toString())
            val ids = tree.nodes.map { it.id }.toSet()
            val rows = f.rows.map { it.id }
            assertEquals(e.file, rows.size, rows.toSet().size)
            assertTrue(e.file, ids.containsAll(rows))
            assertTrue(e.file, f.rows.filter { it.isCurrent }.all { it.id == tree.currentId })
            assertTrue(e.file, f.rows.count { it.isCurrent } <= 1)
            if (f.collapsed.isEmpty()) assertEquals(e.file, ids, rows.toSet())
        }
    }

    @Test fun `typed decoders return the sealed variants`() {
        val job = SyncProtocol.decodeJob(read("job.valid.ask.json"))
        assertTrue(job is JobRequest.Ask)
        val manifest = SyncProtocol.decodeManifest(read("manifest.valid.basic.json"))
        assertEquals(
            listOf(Placement.Folder("f-0a1b2c3d"), Placement.Unfiled, Placement.Archive, Placement.Trash),
            manifest.docs.map { it.placement },
        )
        val status = SyncProtocol.decodeJobStatus(read("jobstatus.valid.done.json"))
        assertTrue(status.state.terminal)
        assertFalse(SyncProtocol.decodeJobStatus(read("jobstatus.valid.running.json")).state.terminal)
    }

    @Test fun `encoding checks the writer side too`() {
        val bad = JobCancel(jobId = "not-a-job", at = "2026-10-01T09:00:00Z")
        assertThrows(ProtocolException::class.java) { SyncProtocol.encode(JobCancel.serializer(), bad) }
        val status = JobStatus(v = 1, jobId = "019a3c5e-7d2f-7a1b-9c3d-4e5f6a7b8c9d", updatedAt = "2026-10-01T09:00:00Z", state = JobState.QUEUED)
        assertEquals(
            """{"v":1,"jobId":"019a3c5e-7d2f-7a1b-9c3d-4e5f6a7b8c9d","updatedAt":"2026-10-01T09:00:00Z","state":"queued"}""",
            SyncProtocol.encode(JobStatus.serializer(), status),
        )
    }

    @Test fun `http URLs follow the desktop's rule`() {
        for (ok in listOf("https://example.com/a?b=1", "http://a.b/1", "HTTPS://Example.COM/", "https://example.com:8443/a%20b#x")) {
            assertTrue(ok, isHttpUrl(ok))
        }
        for (bad in listOf(
            "ftp://example.com/a",
            "javascript:alert(1)",
            "https://",
            "example.com/a",
            "file:///etc/passwd",
            "https://exa\tmple.com/",
            " https://example.com/",
            "https:\\\\example.com/",
            "http:example.com/",
            "https://user:pw@example.com/",
            "https://user@example.com/",
            "https://b\u00fccher.example/",
            "https://[::1]/",
            "https://example.com:99999/",
        )) {
            assertFalse(bad, isHttpUrl(bad))
        }
    }

    @Test fun `patterns, limits and enums repeat the desktop's character for character`() {
        val c = Json.parseToJsonElement(resource("patterns.json")).jsonObject
        val patterns = c.getValue("patterns").jsonObject.mapValues { it.value.jsonPrimitive.content }
        val kotlin =
            mapOf(
                "DEVICE_ID" to Patterns.DEVICE_ID,
                "JOB_ID" to Patterns.JOB_ID,
                "DOC_ID" to Patterns.DOC_ID,
                "VERSION_ID" to Patterns.VERSION_ID,
                "FOLDER_ID" to Patterns.FOLDER_ID,
                "TAB_KEY" to Patterns.TAB_KEY,
                "SECTION_ID" to Patterns.SECTION_ID,
                "SHA256" to Patterns.SHA256,
                "ERROR_CODE" to Patterns.ERROR_CODE,
                "ATTACHMENT_NAME" to Patterns.ATTACHMENT_NAME,
                "ANCHOR_ID" to Patterns.ANCHOR_ID,
                "HTTP_URL" to Patterns.HTTP_URL,
                "ONE_LINE" to Patterns.ONE_LINE,
                "BLANK" to Patterns.BLANK,
                "TIMESTAMP" to Patterns.TIMESTAMP,
                "HOSTNAME" to Patterns.HOSTNAME,
            ).mapValues { it.value.pattern }
        assertEquals(patterns, kotlin)
        val limits = c.getValue("limits").jsonObject.mapValues { it.value.jsonPrimitive.long }
        assertEquals(
            limits,
            mapOf(
                "urls" to Limits.URLS.toLong(),
                "urlChars" to Limits.URL_CHARS.toLong(),
                "attachmentNameChars" to Limits.ATTACHMENT_NAME_CHARS.toLong(),
                "textChars" to Limits.TEXT_CHARS.toLong(),
                "clarifyingInputChars" to Limits.CLARIFYING_INPUT_CHARS.toLong(),
                "attachments" to Limits.ATTACHMENTS.toLong(),
                "attachmentBytes" to Limits.ATTACHMENT_BYTES,
                "jobAttachmentBytes" to Limits.JOB_ATTACHMENT_BYTES,
                "questionMinChars" to Limits.QUESTION_MIN_CHARS.toLong(),
                "questionMaxChars" to Limits.QUESTION_MAX_CHARS.toLong(),
                "treeNodes" to Limits.TREE_NODES.toLong(),
                "manifestDocs" to Limits.MANIFEST_DOCS.toLong(),
                "manifestFolders" to Limits.MANIFEST_FOLDERS.toLong(),
                "ackedJobs" to Limits.ACKED_JOBS.toLong(),
            ),
        )
        fun strings(key: String) = c.getValue(key).jsonArray.map { it.jsonPrimitive.content }
        fun <E : Enum<E>> names(values: Array<E>, serializer: KSerializer<E>) =
            values.map { serializer.descriptor.getElementName(it.ordinal) }
        assertEquals(PROTOCOL_VERSION, c.getValue("protocolVersion").jsonPrimitive.int)
        assertEquals(SYNC_FORMAT_VERSION, c.getValue("syncFormatVersion").jsonPrimitive.int)
        assertEquals(strings("attachmentMimeTypes").toSet(), ATTACHMENT_MIME_TYPES)
        assertEquals(strings("versionChangeKinds"), names(VersionChangeKind.entries.toTypedArray(), VersionChangeKind.serializer()))
        assertEquals(strings("jobKinds"), names(JobKind.entries.toTypedArray(), JobKind.serializer()))
        assertEquals(strings("focusChips"), names(FocusChip.entries.toTypedArray(), FocusChip.serializer()))
        assertEquals(strings("jobStates"), names(JobState.entries.toTypedArray(), JobState.serializer()))
    }

    @Test fun `lengths count code points and blank text is what JavaScript trims`() {
        val emoji = "\uD83D\uDE00"
        assertTrue(Patterns.ATTACHMENT_NAME.matches(emoji.repeat(200)))
        for (cp in 0..0xFFFF) {
            val ch = cp.toChar().toString()
            val jsTrimmed = cp in listOf(0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF) || cp in 0x2000..0x200A
            assertEquals("U+%04x".format(cp), jsTrimmed, Patterns.BLANK.matches(ch))
        }
    }

    @Test fun `a job variant's own serializer is refused, since it would drop the kind`() {
        val job = SyncProtocol.decodeJob(read("job.valid.checkout.json")) as JobRequest.Checkout
        assertThrows(ProtocolException::class.java) { SyncProtocol.encode(JobRequest.Checkout.serializer(), job) }
        assertTrue(SyncProtocol.encode(JobRequest.serializer(), job).contains("\"kind\":\"checkout\""))
    }

    @Test fun `limits match the desktop at their edges`() {
        val att = { c: Char, size: Long -> Attachment(sha = c.toString().repeat(64), name = "$c.pdf", mime = "application/pdf", size = size) }
        fun capture(vararg a: Attachment) =
            JobRequest.Capture(
                v = 1,
                jobId = "019a3c5e-7d2f-7a1b-9c3d-4e5f6a7b8c9d",
                deviceId = "9c8d7e6f-5a4b-4c3d-a2e1-f0e9d8c7b6a5",
                createdAt = "2026-10-01T09:00:00.000Z",
                urls = emptyList(),
                text = "",
                clarifyingInput = "",
                focus = emptyList(),
                attachments = a.toList(),
            )
        val mib = 1024L * 1024
        SyncProtocol.encode(JobRequest.serializer(), capture(att('a', 20 * mib), att('b', 20 * mib), att('c', 10 * mib)))
        assertThrows(ProtocolException::class.java) {
            SyncProtocol.encode(JobRequest.serializer(), capture(att('a', 20 * mib), att('b', 20 * mib), att('c', 10 * mib + 1)))
        }
        for (sep in listOf("\n", "\r", "\u2028", "\u2029")) assertFalse(Patterns.ONE_LINE.matches("a${sep}b"))
        for (badName in listOf(".", "..", "a/b", "a\\b", "a\u0000b")) assertFalse(badName, Patterns.ATTACHMENT_NAME.matches(badName))
    }
}
