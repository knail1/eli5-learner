package io.github.eli5learner.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.github.eli5learner.auth.AuthState
import io.github.eli5learner.data.OfflinePolicy
import io.github.eli5learner.data.db.DeviceEntity
import io.github.eli5learner.ui.theme.Eli5Theme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Settings > Sync and Storage (16 §6.2). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SyncSettingsScreenTest {
    @get:Rule val compose = createComposeRule()

    private val mac = DeviceEntity("11111111-1111-4111-8111-111111111111", "macos", "Studio", "primary", "capture", "on", null)

    @Test fun `the sync section shows while connected and its controls call back`() {
        val calls = mutableListOf<String>()
        compose.setContent {
            Eli5Theme {
                SettingsScreen(
                    onImport = {},
                    auth = AuthState.Connected("reader@example.com"),
                    sync = SyncSettingsState(macs = listOf(mac)),
                    syncActions =
                        SyncSettingsActions(
                            syncNow = { calls += "sync" },
                            setPolicy = { calls += it.id },
                            setLargeOnWifiOnly = { calls += "wifi:$it" },
                            clearCache = { calls += "clear" },
                        ),
                )
            }
        }
        compose.onNodeWithText("Sync now").performClick()
        compose.onNodeWithText("20 most recent").performScrollTo().performClick()
        compose.onNodeWithText("Large downloads on Wi-Fi only").performScrollTo().performClick()
        compose.onNodeWithText("Studio · primary").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Clear cache").performScrollTo().performClick()
        assertEquals(listOf("sync", OfflinePolicy.RECENT.id, "wifi:false", "clear"), calls)
    }

    @Test fun `local mode has no sync section but keeps Storage`() {
        compose.setContent {
            Eli5Theme { SettingsScreen(onImport = {}, auth = AuthState.Disconnected, sync = SyncSettingsState()) }
        }
        compose.onNodeWithText("Sync now").assertDoesNotExist()
        compose.onNodeWithText("Clear cache").performScrollTo().assertIsDisplayed()
    }
}
