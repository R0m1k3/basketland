package app.basketland

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * Session média du système, alimentée par le lecteur du site.
 *
 * - Téléphone : contrôles dans la notification et sur l'écran verrouillé.
 * - Fire TV / Google TV : commandes vocales (« Alexa, pause », « avance de 30 secondes ») et
 *   touches média des télécommandes qui passent par la session plutôt que par la fenêtre.
 *
 * Chaque commande reçue est renvoyée au site par [onAction] (`window.__blMedia`).
 */
class MediaController(
    private val activity: MainActivity,
    private val onAction: (String, Double?) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val notifications = activity.getSystemService(NotificationManager::class.java)
    private val session = MediaSession(activity, "BasketLand").apply {
        setCallback(object : MediaSession.Callback() {
            override fun onPlay() = onAction("play", null)
            override fun onPause() = onAction("pause", null)
            override fun onStop() = onAction("pause", null)
            override fun onFastForward() = onAction("forward", null)
            override fun onRewind() = onAction("rewind", null)
            override fun onSkipToNext() = onAction("forward", null)
            override fun onSkipToPrevious() = onAction("rewind", null)
            override fun onSeekTo(pos: Long) = onAction("seekto", pos / 1000.0)
        })
        setSessionActivity(
            PendingIntent.getActivity(
                activity, 0,
                Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
    }

    private var lastTitle: String? = null
    private var lastDuration = -1L
    private var active = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PLAYPAUSE -> onAction("playpause", null)
                ACTION_REWIND -> onAction("rewind", null)
                ACTION_FORWARD -> onAction("forward", null)
            }
        }
    }

    init {
        if (!activity.isTv) {
            notifications.createNotificationChannel(
                NotificationChannel(CHANNEL, activity.getString(R.string.media_channel), NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
            val filter = IntentFilter().apply {
                addAction(ACTION_PLAYPAUSE)
                addAction(ACTION_REWIND)
                addAction(ACTION_FORWARD)
            }
            // Indicateur ignoré avant Android 13 : le receiver n'existe que pendant que l'appli tourne.
            @SuppressLint("InlinedApi")
            activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        }
    }

    fun askNotificationPermission(a: Activity) {
        if (Build.VERSION.SDK_INT >= 33 &&
            a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            a.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    fun update(playing: Boolean, title: String, subtitle: String, positionSec: Double, durationSec: Double) {
        main.post {
            val durationMs = if (durationSec.isFinite() && durationSec > 0) (durationSec * 1000).toLong() else -1L
            if (title != lastTitle || durationMs != lastDuration) {
                session.setMetadata(
                    MediaMetadata.Builder()
                        .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifBlank { "BasketLand" })
                        .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                        .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
                        .build(),
                )
                lastTitle = title
                lastDuration = durationMs
            }
            val posMs = if (positionSec.isFinite() && positionSec > 0) (positionSec * 1000).toLong() else 0L
            session.setPlaybackState(
                PlaybackState.Builder()
                    .setActions(
                        PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                            PlaybackState.ACTION_STOP or PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND or
                            PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS,
                    )
                    .setState(
                        if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                        posMs, if (playing) 1f else 0f, SystemClock.elapsedRealtime(),
                    )
                    .build(),
            )
            if (!active) {
                session.isActive = true
                active = true
            }
            if (!activity.isTv) postNotification(playing, title, subtitle)
        }
    }

    fun clear() {
        main.post {
            if (active) {
                session.isActive = false
                active = false
            }
            lastTitle = null
            lastDuration = -1L
            notifications.cancel(NOTIF_ID)
        }
    }

    fun release() {
        notifications.cancel(NOTIF_ID)
        if (!activity.isTv) runCatching { activity.unregisterReceiver(receiver) }
        session.release()
    }

    private fun postNotification(playing: Boolean, title: String, subtitle: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        fun action(icon: Int, label: Int, name: String, code: Int) = Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(activity, icon),
            activity.getString(label),
            PendingIntent.getBroadcast(
                activity, code, Intent(name).setPackage(activity.packageName),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        ).build()

        val n = Notification.Builder(activity, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title.ifBlank { "BasketLand" })
            .setContentText(subtitle)
            .setContentIntent(session.controller.sessionActivity)
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(action(android.R.drawable.ic_media_rew, R.string.rewind, ACTION_REWIND, 1))
            .addAction(
                if (playing) action(android.R.drawable.ic_media_pause, R.string.pause, ACTION_PLAYPAUSE, 2)
                else action(android.R.drawable.ic_media_play, R.string.play, ACTION_PLAYPAUSE, 2),
            )
            .addAction(action(android.R.drawable.ic_media_ff, R.string.forward, ACTION_FORWARD, 3))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
        notifications.notify(NOTIF_ID, n)
    }

    companion object {
        private const val CHANNEL = "playback"
        private const val NOTIF_ID = 1
        private const val ACTION_PLAYPAUSE = "app.basketland.PLAYPAUSE"
        private const val ACTION_REWIND = "app.basketland.REWIND"
        private const val ACTION_FORWARD = "app.basketland.FORWARD"
    }
}
