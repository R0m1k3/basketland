package app.basketland

import android.annotation.SuppressLint
import android.app.Activity
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Coquille de l'application : un WebView plein écran sur le site BasketLand.
 *
 * Tout le contenu (lecteur, VF, statistiques) vient du site ; l'appli ajoute ce qu'un
 * navigateur ne fait pas sur téléphone et TV : plein écran vidéo natif, touches de la
 * télécommande, session média (notification, écran verrouillé, Alexa), écran gardé allumé,
 * page « pas de connexion ».
 *
 * Le site reconnaît l'appli à son User-Agent : `BasketLandApp/<version>` et `; TV` sur une TV.
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var offline: View
    private lateinit var media: MediaController

    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    val isTv: Boolean by lazy { detectTv(this) }
    private val siteHost: String = Uri.parse(BuildConfig.SITE_URL).host ?: ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        web = WebView(this).apply {
            setBackgroundColor(BG)
            isFocusable = true
            isFocusableInTouchMode = true
        }
        offline = buildOfflineView()
        root.addView(web, MATCH)
        root.addView(offline, MATCH)
        offline.visibility = View.GONE
        setContentView(root)

        media = MediaController(this, ::runMediaAction)

        CookieManager.getInstance().setAcceptCookie(true)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString BasketLandApp/${BuildConfig.VERSION_NAME}" + if (isTv) "; TV" else ""
        }
        web.addJavascriptInterface(WebBridge(this, media), "BasketLandApp")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(startUrl(intent))
        web.requestFocus()

        if (!isTv) media.askNotificationPermission(this)
        UpdateChecker.checkLater(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.data?.let { web.loadUrl(startUrl(intent)) }
    }

    /** Lien `https://land.vonrodbox.eu/...` ouvert dans l'appli, sinon l'accueil. */
    private fun startUrl(intent: Intent?): String {
        val data = intent?.data
        return if (data != null && data.scheme == "https" && data.host == siteHost) data.toString() else BuildConfig.SITE_URL
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        media.release()
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- télécommande

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val action = mediaKeyAction(event.keyCode)
        if (action != null) {
            // Les touches média vont au lecteur du site, quel que soit l'élément qui a le focus.
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) runMediaAction(action)
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) handleBack()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun mediaKeyAction(code: Int): String? = when (code) {
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> "playpause"
        KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
        KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP -> "pause"
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "forward"
        KeyEvent.KEYCODE_MEDIA_REWIND -> "rewind"
        KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "previous"
        KeyEvent.KEYCODE_MENU -> "menu"
        else -> null
    }

    /** Action média vers le site (`window.__blMedia`, voir `src/lib/appBridge.ts`). */
    fun runMediaAction(action: String, arg: Double? = null) {
        val js = "window.__blMedia&&window.__blMedia(${jsString(action)},${arg ?: "null"})"
        web.post { web.evaluateJavascript(js, null) }
    }

    /**
     * Retour : le site d'abord (fermer un menu, sortir du plein écran — `window.__blBack`),
     * puis le plein écran natif, puis l'historique, puis on quitte.
     */
    private fun handleBack() {
        if (offline.visibility == View.VISIBLE) {
            finish()
            return
        }
        web.evaluateJavascript("(window.__blBack&&window.__blBack())===true") { consumed ->
            if (consumed == "true") return@evaluateJavascript
            when {
                customView != null -> customCallback?.onCustomViewHidden()
                web.canGoBack() -> web.goBack()
                else -> finish()
            }
        }
    }

    // ---------------------------------------------------------------- écran

    /** Garde l'écran allumé pendant la lecture (appelé par le pont). */
    fun setKeepScreenOn(on: Boolean) {
        runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun setImmersiveBars(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            val c = window.insetsController ?: return
            if (on) {
                c.hide(WindowInsets.Type.systemBars())
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                c.show(WindowInsets.Type.systemBars())
            }
        } else {
            // Android 9-10 (Fire OS 7) : ancienne API.
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (on) {
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            } else {
                View.SYSTEM_UI_FLAG_VISIBLE
            }
        }
    }

    // ---------------------------------------------------------------- page hors ligne

    private fun buildOfflineView(): View {
        val pad = (32 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(BG)
            setPadding(pad, pad, pad, pad)
            addView(TextView(context).apply {
                setText(R.string.offline_title)
                setTextColor(Color.WHITE)
                textSize = if (isTv) 34f else 24f
                gravity = Gravity.CENTER
            })
            addView(TextView(context).apply {
                setText(R.string.offline_body)
                setTextColor(Color.rgb(0xB4, 0xB4, 0xBC))
                textSize = if (isTv) 22f else 16f
                gravity = Gravity.CENTER
                setPadding(0, pad / 2, 0, pad)
            })
            addView(Button(context).apply {
                setText(R.string.retry)
                textSize = if (isTv) 22f else 16f
                setOnClickListener { retry() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun showOffline() {
        offline.visibility = View.VISIBLE
        (offline as ViewGroup).getChildAt(2).requestFocus()
    }

    private fun retry() {
        offline.visibility = View.GONE
        web.reload()
        web.requestFocus()
    }

    // ---------------------------------------------------------------- clients du WebView

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.scheme == "https" && url.host == siteHost) return false
            // Tout lien hors du site s'ouvre dans le navigateur du système.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {
                // Pas de navigateur (cas fréquent sur TV) : on reste où on est.
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showOffline()
        }

        override fun onPageFinished(view: WebView, url: String) {
            CookieManager.getInstance().flush()
        }
    }

    private inner class Chrome : WebChromeClient() {
        // Plein écran du site (Fullscreen API sur le cadre du lecteur) : la vue fournie par
        // le WebView contient le cadre complet, VF comprise.
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customCallback = callback
            root.addView(view, MATCH)
            web.visibility = View.INVISIBLE
            setImmersiveBars(true)
            if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }

        override fun onHideCustomView() {
            val v = customView ?: return
            root.removeView(v)
            customView = null
            customCallback = null
            web.visibility = View.VISIBLE
            setImmersiveBars(false)
            if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            web.requestFocus()
        }
    }

    companion object {
        private val BG = Color.rgb(0x0B, 0x0B, 0x0E)
        private val MATCH: FrameLayout.LayoutParams
            get() = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

        fun detectTv(ctx: Context): Boolean {
            val ui = ctx.getSystemService(UI_MODE_SERVICE) as UiModeManager
            val pm = ctx.packageManager
            return ui.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
                pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
                pm.hasSystemFeature("amazon.hardware.fire_tv")
        }

        fun jsString(s: String): String =
            "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""
    }
}
