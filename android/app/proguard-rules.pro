# R8 rules for the release build (16 §6.1). Library rules (Compose, kotlinx.serialization, AndroidX)
# ship as consumer rules inside the dependencies; only app-specific rules go here.

# Serializable classes of the local index are looked up through their generated serializers.
-keepclassmembers @kotlinx.serialization.Serializable class io.github.eli5learner.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep line numbers readable in crash stack traces; the source file name is hidden.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
