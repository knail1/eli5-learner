package io.github.eli5learner.versions

/** One version as the layout needs it (a node of the remote tree, 16 §4.4). */
data class LayoutNode(
    val id: String,
    val parentId: String?,
    /** ISO 8601, compared as text (the desktop does the same). */
    val createdAt: String,
)

/** One laid-out row; the same fields as the shared `layout.<name>.json` fixtures (16 §12). */
data class VersionRow(
    val id: String,
    /** 1-based depth. */
    val level: Int,
    /** The branch point whose group holds this row; null for the top level. */
    val groupId: String?,
    val isCurrent: Boolean,
    /** On the path from the original to the current version. */
    val onCurrentPath: Boolean,
    /** A branch point: it owns a group of branches. */
    val hasChildren: Boolean,
    val expanded: Boolean,
    /** Expanded because it holds the current version; it cannot collapse. */
    val forced: Boolean,
    /** The first row of a branch lane (or of a later root). */
    val branchStart: Boolean,
    /** The last row of its lane. */
    val laneEnd: Boolean,
    val setsize: Int,
    val posinset: Int,
)

/**
 * Kotlin port of the desktop's `layoutVersionTree` (src/renderer/src/viewer/version-tree-layout.ts,
 * 11 §5.7), tested against the shared layout fixtures the desktop generates.
 *
 * A *lane* is a chain that follows each version's oldest child. Rows run chronologically down a
 * lane, starting with the original. Every later child of a version starts a branch: its own lane,
 * one level deeper, after the branch point's row. Collapsed branch points hide their branches,
 * except a branch that holds the current version. The remote tree has no redo pointer, so the
 * desktop's `isRedo` is left out.
 */
object VersionTreeLayout {
    private val byCreated = Comparator<LayoutNode> { a, b -> if (a.createdAt == b.createdAt) a.id.compareTo(b.id) else a.createdAt.compareTo(b.createdAt) }

    fun layout(
        nodes: List<LayoutNode>,
        currentId: String?,
        collapsed: Set<String> = emptySet(),
    ): List<VersionRow> {
        val ids = nodes.map { it.id }.toSet()
        val kids = LinkedHashMap<String, MutableList<LayoutNode>>()
        val roots = mutableListOf<LayoutNode>()
        for (n in nodes) {
            val p = n.parentId
            if (p != null && p in ids && p != n.id) kids.getOrPut(p) { mutableListOf() }.add(n) else roots.add(n)
        }
        for (list in kids.values) list.sortWith(byCreated)

        // A parent cycle (a damaged tree) reaches no root: its oldest node becomes a root, so every
        // version still shows exactly once.
        val reached = HashSet<String>()
        fun reach(n: LayoutNode) {
            val stack = ArrayDeque(listOf(n))
            while (stack.isNotEmpty()) {
                val c = stack.removeLast()
                if (!reached.add(c.id)) continue
                stack.addAll(kids[c.id].orEmpty())
            }
        }
        roots.forEach(::reach)
        for (n in nodes.sortedWith(byCreated)) {
            if (n.id in reached) continue
            kids[n.parentId]?.remove(n)
            roots.add(n)
            reach(n)
        }
        roots.sortWith(byCreated)

        // The path from the original to the current version.
        val byId = nodes.associateBy { it.id }
        val path = LinkedHashSet<String>()
        var cur = currentId?.let { byId[it] }
        while (cur != null && cur.id !in path) {
            path.add(cur.id)
            cur = cur.parentId?.let { byId[it] }
        }

        val rows = mutableListOf<VersionRow>()
        val seen = HashSet<String>()

        fun laneOf(start: LayoutNode): List<LayoutNode> {
            val lane = mutableListOf<LayoutNode>()
            var n: LayoutNode? = start
            while (n != null && n.id !in seen) {
                seen.add(n.id)
                lane.add(n)
                n = kids[n.id]?.firstOrNull()
            }
            return lane
        }

        // Hidden subtrees still count as laid out, so a node is never shown twice.
        fun markSeen(n: LayoutNode) {
            val stack = ArrayDeque(listOf(n))
            while (stack.isNotEmpty()) {
                val c = stack.removeLast()
                if (!seen.add(c.id)) continue
                stack.addAll(kids[c.id].orEmpty())
            }
        }

        fun emitGroup(
            starts: List<LayoutNode>,
            level: Int,
            groupId: String?,
        ) {
            val lanes = starts.map(::laneOf).filter { it.isNotEmpty() }
            val setsize = lanes.sumOf { it.size }
            var pos = 0
            lanes.forEachIndexed { li, lane ->
                lane.forEachIndexed { i, node ->
                    val branches = kids[node.id].orEmpty().drop(1).filter { it.id !in seen }
                    val hasChildren = branches.isNotEmpty()
                    val forced = hasChildren && branches.any { it.id in path }
                    val expanded = hasChildren && (forced || node.id !in collapsed)
                    rows.add(
                        VersionRow(
                            id = node.id,
                            level = level,
                            groupId = groupId,
                            isCurrent = node.id == currentId,
                            onCurrentPath = node.id in path,
                            hasChildren = hasChildren,
                            expanded = expanded,
                            forced = forced,
                            branchStart = i == 0 && (groupId != null || li > 0),
                            laneEnd = i == lane.size - 1,
                            setsize = setsize,
                            posinset = ++pos,
                        ),
                    )
                    if (expanded) emitGroup(branches, level + 1, node.id) else branches.forEach(::markSeen)
                }
            }
        }

        emitGroup(roots, 1, null)
        return rows
    }
}
