package io.github.eli5learner.drive

import kotlinx.coroutines.delay
import kotlin.math.min
import kotlin.random.Random

/**
 * Retry policy for Drive requests, the same as the desktop's (16 §4.5): exponential backoff with full
 * jitter, base 1 s, capped at 64 s, at most [maxAttempts] attempts in all. Retried: network errors,
 * HTTP 429, 5xx and 403 with a rate-limit reason. Not retried: everything else.
 */
class Backoff(
    val baseMs: Long = BASE_MS,
    val capMs: Long = CAP_MS,
    val maxAttempts: Int = MAX_ATTEMPTS,
    private val random: () -> Double = { Random.nextDouble() },
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    init {
        require(baseMs > 0 && capMs >= baseMs) { "backoff: 0 < base <= cap" }
        require(maxAttempts >= 1) { "backoff: at least one attempt" }
    }

    /** Full-jitter delay before retry number [attempt] + 1 (0-based): uniform in [0, min(cap, base * 2^attempt)). */
    fun delayMs(attempt: Int): Long {
        val ceiling = if (attempt >= 30) capMs else min(capMs, baseMs shl attempt)
        return (random() * ceiling).toLong().coerceIn(0, ceiling)
    }

    /** True when another attempt is allowed after the 0-based [attempt] failed. */
    fun canRetry(attempt: Int): Boolean = attempt + 1 < maxAttempts

    suspend fun pause(attempt: Int) = sleep(delayMs(attempt))

    companion object {
        const val BASE_MS = 1_000L
        const val CAP_MS = 64_000L
        const val MAX_ATTEMPTS = 7

        private val RATE_LIMIT_REASONS = setOf("userRateLimitExceeded", "rateLimitExceeded")

        /** Whether an HTTP failure is transient (16 §4.5). */
        fun isRetryable(
            status: Int,
            reason: String?,
        ): Boolean = status == 429 || status >= 500 || (status == 403 && reason in RATE_LIMIT_REASONS)
    }
}
