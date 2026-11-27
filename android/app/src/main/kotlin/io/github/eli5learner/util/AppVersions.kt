package io.github.eli5learner.util

/**
 * App version checks against what another device wrote in its device file (16 §4.3), e.g. whether
 * the primary Mac can read a newer capture field. Only the leading `major.minor.patch` counts; a
 * `-suffix` or `+build` is ignored, and anything that does not parse is treated as too old.
 */
object AppVersions {
    /** The first desktop that reads the capture's `deadpan` field (16 §5.1). */
    const val DEADPAN_MIN_MAC = "0.6.0"

    private val VERSION = Regex("^(\\d{1,9})\\.(\\d{1,9})\\.(\\d{1,9})(?:[-+].*)?$")

    /** The leading major, minor and patch numbers, or null when [v] is not a dotted version. */
    fun parse(v: String?): List<Int>? {
        val m = VERSION.matchEntire(v?.trim().orEmpty()) ?: return null
        return m.groupValues.drop(1).map { it.toIntOrNull() ?: return null }
    }

    /** True when [v] is [min] or later; false when either does not parse. */
    fun atLeast(
        v: String?,
        min: String,
    ): Boolean {
        val a = parse(v) ?: return false
        val b = parse(min) ?: return false
        for (i in 0 until 3) {
            if (a[i] != b[i]) return a[i] > b[i]
        }
        return true
    }

    /** The primary Mac at [macVersion] can take a capture with `deadpan`. */
    fun macTakesDeadpan(macVersion: String?): Boolean = atLeast(macVersion, DEADPAN_MIN_MAC)
}
