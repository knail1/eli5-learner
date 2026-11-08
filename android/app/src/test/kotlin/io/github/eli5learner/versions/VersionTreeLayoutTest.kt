package io.github.eli5learner.versions

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin port of the desktop's version-tree layout (16 §6.2 Versions) against the shared
 * `layout.<name>.json` fixtures, whose expected rows the desktop's own `layoutVersionTree` computed.
 */
class VersionTreeLayoutTest {
    @Serializable
    private data class Entry(
        val file: String,
        val type: String,
    )

    @Serializable
    private data class Index(
        val fixtures: List<Entry>,
    )

    @Serializable
    private data class Node(
        val id: String,
        val parentId: String?,
        val createdAt: String,
    )

    @Serializable
    private data class Tree(
        val currentId: String,
        val nodes: List<Node>,
    )

    @Serializable
    private data class Row(
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
    private data class Fixture(
        val tree: Tree,
        val collapsed: List<String>,
        val rows: List<Row>,
    )

    private fun VersionRow.wire() = Row(id, level, groupId, isCurrent, onCurrentPath, hasChildren, expanded, forced, branchStart, laneEnd, setsize, posinset)

    private val json = Json { ignoreUnknownKeys = true }

    private fun read(file: String): String =
        requireNotNull(javaClass.getResourceAsStream("/sync/fixtures/$file")) { "missing $file" }.use { it.readBytes().toString(Charsets.UTF_8) }

    @Test fun `every shared layout fixture lays out exactly as on the desktop`() {
        val layouts = json.decodeFromString<Index>(read("index.json")).fixtures.filter { it.type == "layout" }
        assertTrue(layouts.size >= 5)
        for (e in layouts) {
            val f = json.decodeFromString<Fixture>(read(e.file))
            val rows = VersionTreeLayout.layout(f.tree.nodes.map { LayoutNode(it.id, it.parentId, it.createdAt) }, f.tree.currentId, f.collapsed.toSet())
            assertEquals(e.file, f.rows, rows.map { it.wire() })
        }
    }

    @Test fun `an unknown current id marks nothing current and still shows every version`() {
        val nodes =
            listOf(
                LayoutNode("v-000000000001", null, "2026-10-01T09:00:00.000Z"),
                LayoutNode("v-000000000002", "v-000000000001", "2026-10-01T09:01:00.000Z"),
            )
        val rows = VersionTreeLayout.layout(nodes, "v-0000000000ff")
        assertEquals(listOf("v-000000000001", "v-000000000002"), rows.map { it.id })
        assertTrue(rows.none { it.isCurrent || it.onCurrentPath })
        assertEquals(emptyList<VersionRow>(), VersionTreeLayout.layout(emptyList(), null))
    }
}
