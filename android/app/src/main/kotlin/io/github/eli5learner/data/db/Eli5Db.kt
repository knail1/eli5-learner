package io.github.eli5learner.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * The phone's Room database (16 §6.1, §6.4). A cache only: it can always be rebuilt from
 * `filesDir/docs` and the next pull, so a schema change drops and recreates it rather than migrating.
 */
@Database(
    entities = [
        DocumentEntity::class,
        DocumentFts::class,
        FolderEntity::class,
        VersionEntity::class,
        DeviceEntity::class,
        RemoteFileEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class Eli5Db : RoomDatabase() {
    abstract fun documents(): DocumentDao

    abstract fun folders(): FolderDao

    abstract fun versions(): VersionDao

    abstract fun devices(): DeviceDao

    abstract fun remoteFiles(): RemoteFileDao

    companion object {
        const val NAME = "eli5.db"

        fun open(context: Context): Eli5Db =
            Room
                .databaseBuilder(context.applicationContext, Eli5Db::class.java, NAME)
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}
