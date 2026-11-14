package app.basketland

import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Pont `window.BasketLandApp` exposé au site (voir `src/lib/appBridge.ts`).
 *
 * Seul le site BasketLand est chargé dans le WebView (tout autre lien part dans le
 * navigateur) ; les méthodes ne donnent de toute façon accès à rien de sensible.
 */
class WebBridge(private val activity: MainActivity, private val media: MediaController) {

    @JavascriptInterface
    fun isTv(): Boolean = activity.isTv

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /** Nom montré lors de la validation du code de connexion. */
    @JavascriptInterface
    fun deviceName(): String {
        val pm = activity.packageManager
        // Les modèles Fire TV ont des noms opaques (AFTGAZL…) : nom commercial.
        if (pm.hasSystemFeature("amazon.hardware.fire_tv")) return "Fire TV"
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
    }

    /**
     * État du lecteur : `{"playing":true,"title":"…","subtitle":"…","position":12.3,"duration":7200}`
     * (secondes). Appelé à chaque lecture/pause/saut et toutes les quelques secondes.
     */
    @JavascriptInterface
    fun mediaState(json: String) {
        val o = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        val playing = o.optBoolean("playing")
        activity.setKeepScreenOn(playing)
        media.update(
            playing = playing,
            title = o.optString("title").take(200),
            subtitle = o.optString("subtitle").take(200),
            positionSec = o.optDouble("position", 0.0),
            durationSec = o.optDouble("duration", 0.0),
        )
    }

    /** Le lecteur a disparu (page quittée) : plus de session média. */
    @JavascriptInterface
    fun mediaClear() {
        activity.setKeepScreenOn(false)
        media.clear()
    }
}
