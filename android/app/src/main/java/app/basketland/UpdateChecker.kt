package app.basketland

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL

/**
 * Mise à jour sans Play Store : au démarrage (au plus une fois par jour), lit les Releases
 * GitHub du dépôt, prend la plus récente dont le tag est `android-vX.Y.Z` et, si elle est plus
 * récente que l'appli installée, propose de télécharger l'APK puis de l'installer.
 */
object UpdateChecker {
    private const val PREFS = "update"
    private const val KEY_LAST = "last_check"
    private const val DAY_MS = 24 * 3600 * 1000L

    fun checkLater(activity: MainActivity) {
        if (BuildConfig.VERSION_NAME.endsWith("-dev")) return
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(KEY_LAST, 0) < DAY_MS) return
        Thread {
            val found = runCatching { latest() }.getOrNull() ?: return@Thread
            prefs.edit().putLong(KEY_LAST, now).apply()
            if (compareVersions(found.version, BuildConfig.VERSION_NAME) <= 0) return@Thread
            activity.runOnUiThread { if (!activity.isFinishing) offer(activity, found) }
        }.start()
    }

    private data class Release(val version: String, val apkUrl: String)

    private fun latest(): Release? {
        val conn = URL(BuildConfig.RELEASES_API).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        val body = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        val list = JSONArray(body)
        var best: Release? = null
        for (i in 0 until list.length()) {
            val r = list.getJSONObject(i)
            if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue
            val tag = r.optString("tag_name")
            if (!tag.startsWith("android-v")) continue
            val assets = r.optJSONArray("assets") ?: continue
            var apk: String? = null
            for (j in 0 until assets.length()) {
                val a = assets.getJSONObject(j)
                if (a.optString("name").endsWith(".apk")) apk = a.optString("browser_download_url")
            }
            val version = tag.removePrefix("android-v")
            if (apk != null && (best == null || compareVersions(version, best.version) > 0)) best = Release(version, apk)
        }
        return best
    }

    /** Compare `1.2.10` et `1.2.9` numériquement ; un suffixe (`-dev`) est ignoré. */
    fun compareVersions(a: String, b: String): Int {
        fun parts(v: String) = v.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        val pa = parts(a)
        val pb = parts(b)
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val d = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
            if (d != 0) return d
        }
        return 0
    }

    private fun offer(activity: MainActivity, r: Release) {
        AlertDialog.Builder(activity)
            .setTitle(R.string.update_title)
            .setMessage(activity.getString(R.string.update_body, r.version, BuildConfig.VERSION_NAME))
            .setPositiveButton(R.string.update_download) { _, _ -> download(activity, r) }
            .setNegativeButton(R.string.later, null)
            .show()
    }

    private fun download(activity: MainActivity, r: Release) {
        // Android 8+ : l'appli doit être autorisée à installer des applications.
        if (!activity.packageManager.canRequestPackageInstalls()) {
            runCatching {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                )
            }
            return
        }
        val dm = activity.getSystemService(DownloadManager::class.java)
        val name = "basketland-${r.version}.apk"
        val id = dm.enqueue(
            DownloadManager.Request(Uri.parse(r.apkUrl))
                .setTitle("BasketLand ${r.version}")
                .setMimeType(APK_MIME)
                .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED),
        )
        val done = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return
                runCatching { context.unregisterReceiver(this) }
                val uri = dm.getUriForDownloadedFile(id) ?: return
                runCatching {
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW)
                            .setDataAndType(uri, APK_MIME)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        // Diffusion système du DownloadManager : le receiver doit être exporté.
        @SuppressLint("InlinedApi")
        activity.registerReceiver(done, filter, Context.RECEIVER_EXPORTED)
    }

    private const val APK_MIME = "application/vnd.android.package-archive"
}
