package io.github.eli5learner.inbox

import java.security.SecureRandom

/** Job ids are UUIDv7 (16 §4.2): a millisecond timestamp, then randomness, so they sort by creation. */
object JobIds {
    private val random = SecureRandom()

    fun new(nowMs: Long = System.currentTimeMillis()): String = of(nowMs, ByteArray(16).also { random.nextBytes(it) })

    /** The UUIDv7 for [nowMs] with [randomBytes] (16 bytes) filling the random bits. */
    fun of(
        nowMs: Long,
        randomBytes: ByteArray,
    ): String {
        require(randomBytes.size == 16) { "need 16 random bytes" }
        require(nowMs in 0..0xFFFF_FFFF_FFFFL) { "timestamp out of range" }
        val b = randomBytes.copyOf()
        for (i in 0 until 6) b[i] = (nowMs ushr (8 * (5 - i))).toByte()
        b[6] = ((b[6].toInt() and 0x0F) or 0x70).toByte()
        b[8] = ((b[8].toInt() and 0x3F) or 0x80).toByte()
        val hex = b.joinToString("") { "%02x".format(it) }
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }
}
