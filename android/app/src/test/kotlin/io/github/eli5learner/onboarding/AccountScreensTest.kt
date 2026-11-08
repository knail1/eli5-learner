package io.github.eli5learner.onboarding

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.library.LibraryScreen
import io.github.eli5learner.library.LibraryUiState
import io.github.eli5learner.settings.DiagnosticsScreen
import io.github.eli5learner.settings.ProbeActions
import io.github.eli5learner.settings.ProbeUiState
import io.github.eli5learner.settings.SettingsScreen
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Onboarding, the Settings account row, the reconnect banner and Diagnostics (16 §6.2, §3.3). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AccountScreensTest {
    @get:Rule val compose = createComposeRule()

    private val noProbe = ProbeActions({}, {}, {}, {}, {}, {}, {})

    @Test fun `onboarding offers local use and Connect`() {
        var local = 0
        var connect = 0
        compose.setContent {
            Eli5Theme { OnboardingScreen(AuthState.Disconnected, onUseLocally = { local++ }, onConnect = { connect++ }, onDone = {}) }
        }
        compose.onNodeWithText("Use on this phone").performScrollTo().performClick()
        compose.onAllNodesWithText("Connect Google Drive")[1].performScrollTo().performClick()
        assertEquals(1, local)
        assertEquals(1, connect)
    }

    @Test fun `onboarding waits for the Mac once connected`() {
        var done = 0
        compose.setContent {
            Eli5Theme { OnboardingScreen(AuthState.Connected("me@example.com"), {}, {}, onDone = { done++ }) }
        }
        compose.onNodeWithText("Connected as me@example.com").assertIsDisplayed()
        compose.onNodeWithText("Waiting for your Mac…").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Continue").performScrollTo().performClick()
        assertEquals(1, done)
    }

    @Test fun `settings disconnects only after confirmation`() {
        var disconnects = 0
        compose.setContent {
            Eli5Theme {
                SettingsScreen(onImport = {}, auth = AuthState.Connected("me@example.com"), onDisconnect = { disconnects++ }, versionName = "0", commit = "c")
            }
        }
        compose.onNodeWithText("Connected as me@example.com").assertIsDisplayed()
        compose.onNodeWithText("Disconnect").performClick()
        compose.onNodeWithText("Disconnect Google Drive?").assertIsDisplayed()
        assertEquals(0, disconnects)
        compose.onAllNodesWithText("Disconnect")[1].performClick()
        assertEquals(1, disconnects)
    }

    @Test fun `settings shows Connect while connecting is disabled`() {
        compose.setContent {
            Eli5Theme { SettingsScreen(onImport = {}, auth = AuthState.Connecting, versionName = "0", commit = "c") }
        }
        compose.onNodeWithText("Connecting…").assertIsNotEnabled()
    }

    @Test fun `a lost grant shows the reconnect banner in the library`() {
        var reconnects = 0
        compose.setContent {
            Eli5Theme {
                LibraryScreen(LibraryUiState(loaded = true), {}, {}, {}, {}, needsReconnect = true, onReconnect = { reconnects++ })
            }
        }
        compose.onNodeWithText("Sign in again to keep syncing").assertIsDisplayed()
        compose.onNodeWithText("Sign in again").performClick()
        assertEquals(1, reconnects)
    }

    @Test fun `release diagnostics show counts and no probe`() {
        compose.setContent {
            Eli5Theme { DiagnosticsScreen(3, AuthState.Disconnected, showProbe = false, probe = ProbeUiState(), actions = noProbe, onBack = {}) }
        }
        compose.onNodeWithText("Documents on this phone: 3").assertIsDisplayed()
        compose.onNodeWithText("Google Drive: not connected").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("Drive probe (debug builds)").fetchSemanticsNodes().size)
    }

    @Test fun `the debug probe needs a connection`() {
        compose.setContent {
            Eli5Theme {
                DiagnosticsScreen(0, AuthState.Disconnected, showProbe = true, probe = ProbeUiState(log = listOf("app folder: 2 files, 1 probes")), actions = noProbe, onBack = {})
            }
        }
        compose.onNodeWithText("Write probe-phone.json").assertIsNotEnabled()
        compose.onNodeWithText("app folder: 2 files, 1 probes").assertIsDisplayed()
    }
}
