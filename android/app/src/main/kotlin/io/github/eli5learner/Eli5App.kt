package io.github.eli5learner

import android.app.Application

class Eli5App : Application() {
    val container: AppContainer by lazy { AppContainer(filesDir) }
}
