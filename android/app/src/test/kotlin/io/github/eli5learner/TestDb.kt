package io.github.eli5learner

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.eli5learner.data.db.Eli5Db

/** An in-memory Room database for Robolectric tests. */
fun inMemoryDb(): Eli5Db =
    Room
        .inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), Eli5Db::class.java)
        .allowMainThreadQueries()
        .build()
