package io.github.eli5learner

import io.github.eli5learner.importer.HtmlImporter

/** Test documents: the desktop's built fixtures (test/fixtures/documents/build) and small synthetic ones. */
object TestDocs {
    /** A fixture from the desktop build, read from the test classpath. */
    fun fixture(name: String): ByteArray =
        requireNotNull(TestDocs::class.java.getResourceAsStream("/$name")) { "missing test resource $name" }.use { it.readBytes() }

    /** A minimal valid ELI5 document whose meta CSP pins its one inline script. */
    fun eli5(
        docId: String = "doc-1",
        title: String = "Widgets explained",
        script: String = "document.body.dataset.ok='1';",
        pin: Boolean = true,
    ): String {
        val hash = if (pin) HtmlImporter.scriptHash(script) else "'sha256-AAAA'"
        val model =
            """{"formatVersion":1,"docId":"$docId","title":"$title","tabs":[""" +
                """{"key":"indepth","label":"In depth","sections":[{"heading":"How widgets work"}]},""" +
                """{"key":"eli5","label":"ELI5","sections":[{"heading":"Widgets for a five-year-old"}]}]}"""
        return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src $hash; base-uri 'none'">
<title>$title</title>
<script type="application/json" id="eli5-model">$model</script>
</head><body><main>hello</main><script id="eli5-runtime">$script</script></body></html>
"""
    }

    fun foreign(title: String = "Some page"): String =
        """<!doctype html><html><head><title>$title</title><script>alert(1)</script></head><body>hi</body></html>"""
}
