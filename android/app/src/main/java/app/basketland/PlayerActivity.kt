package app.basketland

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.CookieManager
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import java.io.File

/**
 * Lecteur vidéo natif (ExoPlayer) des TV : le WebView des TV lit mal la vidéo (image
 * noire ou saccadée). Ouvert par le site (`BasketLandApp.playNative`, voir WebBridge) avec
 * l'adresse du flux (HLS ou MP4 du serveur BasketLand, cookie de session du WebView) et la
 * VF en WebVTT ; en sortie, rend la position au site (`window.__blNativeEnded`).
 *
 * Télécommande, barre masquée : OK lecture/pause, ←/→ −10/+10 s (appui long : 30 puis 60 s),
 * ↑/↓ affichent la barre. Barre affichée : navigation normale entre ses boutons. Retour
 * masque la barre, puis revient à la fiche du match.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {

    private lateinit var view: PlayerView
    private var player: ExoPlayer? = null
    private var repeats = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val url = intent.getStringExtra(EXTRA_URL)
        if (url == null) {
            finish()
            return
        }
        val ua = intent.getStringExtra(EXTRA_UA)
        val cookie = CookieManager.getInstance().getCookie(url)
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
            .apply { if (ua != null) setUserAgent(ua) }
            .setDefaultRequestProperties(if (cookie != null) mapOf("Cookie" to cookie) else emptyMap())

        val p = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .setSeekBackIncrementMs(SKIP_MS)
            .setSeekForwardIncrementMs(SKIP_MS)
            .build()
        player = p
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setPreferredTextLanguage("fr")
            .build()

        view = PlayerView(this).apply {
            setBackgroundColor(Color.BLACK)
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShowSubtitleButton(true)
            setShowNextButton(false)
            setShowPreviousButton(false)
            controllerShowTimeoutMs = 3500
            setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
            this.player = p
        }
        styleSubtitles(view.subtitleView, intent.getFloatExtra(EXTRA_SUB_SCALE, 1f))
        setContentView(view)

        val item = MediaItem.Builder()
            .setUri(url)
            .setMimeType(if (intent.getStringExtra(EXTRA_KIND) == "mp4") MimeTypes.VIDEO_MP4 else MimeTypes.APPLICATION_M3U8)
        intent.getStringExtra(EXTRA_VTT)?.let { path ->
            val f = File(path)
            if (f.isFile) {
                item.setSubtitleConfigurations(
                    listOf(
                        MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage("fr")
                            .setLabel("VF")
                            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                            .build(),
                    ),
                )
            }
        }
        p.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Toast.makeText(this@PlayerActivity, getString(R.string.player_error, error.errorCodeName), Toast.LENGTH_LONG).show()
                done()
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) done(ended = true)
            }
        })
        p.setMediaItem(item.build(), (intent.getDoubleExtra(EXTRA_POSITION, 0.0) * 1000).toLong().coerceAtLeast(0))
        p.playWhenReady = true
        p.prepare()
    }

    private fun styleSubtitles(sv: SubtitleView?, scale: Float) {
        sv ?: return
        // VF lisible de loin : texte blanc sur fond sombre, taille selon le réglage du site.
        sv.setStyle(
            CaptionStyleCompat(
                Color.WHITE,
                Color.argb(170, 0, 0, 0),
                Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_NONE,
                Color.BLACK,
                null,
            ),
        )
        sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * 1.1f * scale)
        sv.setApplyEmbeddedStyles(true)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val p = player ?: return super.dispatchKeyEvent(event)
        val code = event.keyCode
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) {
                if (view.isControllerFullyVisible) view.hideController() else done()
            }
            return true
        }
        // Barre masquée : la télécommande pilote directement la lecture.
        if (!view.isControllerFullyVisible) {
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        repeats = if (event.repeatCount == 0) 0 else repeats + 1
                        val step = when {
                            repeats < 6 -> SKIP_MS
                            repeats < 16 -> 30_000L
                            else -> 60_000L
                        }
                        val delta = if (code == KeyEvent.KEYCODE_DPAD_LEFT) -step else step
                        p.seekTo((p.currentPosition + delta).coerceIn(0, maxOf(0, p.duration)))
                    }
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    if (event.action == KeyEvent.ACTION_UP) {
                        if (p.isPlaying) {
                            p.pause()
                            view.showController()
                        } else {
                            p.play()
                        }
                    }
                    return true
                }
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
                    if (event.action == KeyEvent.ACTION_DOWN) view.showController()
                    return true
                }
            }
        }
        return view.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    override fun onStop() {
        super.onStop()
        // Appli quittée (touche Accueil) : on met en pause, la position reste.
        player?.pause()
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }

    private var finished = false

    /** Retour à la fiche du match, avec la position (secondes) pour « Reprendre à ». */
    private fun done(ended: Boolean = false) {
        if (finished) return
        finished = true
        val p = player
        val pos = if (p == null || ended) 0.0 else p.currentPosition / 1000.0
        setResult(RESULT_OK, Intent().putExtra(EXTRA_POSITION, pos).putExtra(EXTRA_ENDED, ended))
        finish()
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_KIND = "kind"
        const val EXTRA_POSITION = "position"
        const val EXTRA_ENDED = "ended"
        const val EXTRA_VTT = "vtt"
        const val EXTRA_SUB_SCALE = "subScale"
        const val EXTRA_UA = "ua"
        private const val SKIP_MS = 10_000L

        fun intent(ctx: Context, url: String, kind: String, position: Double, vtt: File?, subScale: Float, ua: String?): Intent =
            Intent(ctx, PlayerActivity::class.java)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_KIND, kind)
                .putExtra(EXTRA_POSITION, position)
                .putExtra(EXTRA_VTT, vtt?.absolutePath)
                .putExtra(EXTRA_SUB_SCALE, subScale)
                .putExtra(EXTRA_UA, ua)
    }
}
