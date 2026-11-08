package io.github.eli5learner.data.db

import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.FtsOptions

/**
 * Full-text index over title, summary, headings and the plain text of the embedded model of cached
 * documents (16 §6.4). Kept in step with [DocumentEntity] by [DocumentDao]; `key` is stored, not
 * indexed.
 */
@Fts4(notIndexed = ["key"], tokenizer = FtsOptions.TOKENIZER_UNICODE61)
@Entity(tableName = "document_fts")
data class DocumentFts(
    val key: String,
    val title: String,
    val summary: String,
    val headings: String,
    val body: String,
)

/** Builds FTS4 MATCH expressions from what the user typed: every term is a prefix match, all must match. */
object FtsQuery {
    private val TERM = Regex("[\\p{L}\\p{N}]+")

    /** Null when [input] has no searchable term. */
    fun of(input: String): String? {
        val terms = TERM.findAll(input.lowercase()).map { it.value }.take(MAX_TERMS).toList()
        if (terms.isEmpty()) return null
        return terms.joinToString(" ") { "$it*" }
    }

    private const val MAX_TERMS = 8
}
