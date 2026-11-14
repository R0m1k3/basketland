package app.basketland

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {
    @Test
    fun comparesNumerically() {
        assertTrue(UpdateChecker.compareVersions("1.2.10", "1.2.9") > 0)
        assertTrue(UpdateChecker.compareVersions("1.0", "1.0.1") < 0)
        assertEquals(0, UpdateChecker.compareVersions("1.0.0", "1.0"))
    }

    @Test
    fun ignoresSuffix() {
        assertEquals(0, UpdateChecker.compareVersions("0.1.0-dev", "0.1.0"))
        assertTrue(UpdateChecker.compareVersions("0.2.0", "0.1.0-dev") > 0)
    }
}
