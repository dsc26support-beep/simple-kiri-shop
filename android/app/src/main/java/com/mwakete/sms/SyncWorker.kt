package com.mwakete.sms

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.mwakete.sms.core.SenderRules
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException

/**
 * One check-in-and-send run:
 *  1. report results / STOP replies / SIMs and take a batch (smsDeviceSync);
 *  2. send held messages one at a time, waiting the store's interval between
 *     them, stopping for pause, quiet hours or suspension;
 *  3. check in again every minute (to hear about cancelled campaigns) and at the end.
 * The server decides what may be sent; the phone never makes up messages.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        private val running = Mutex()
        private const val APP_VERSION_FALLBACK = "1.0"
    }

    private val store = Store(applicationContext)
    private var foreground = false

    override suspend fun doWork(): Result {
        if (!store.paired) return Result.success()
        if (!running.tryLock()) return Result.success()
        try {
            withContext(Dispatchers.IO) { loop() }
            store.lastError = ""
        } catch (e: ApiError) {
            store.lastError = e.message ?: "Refused"
            if (e.kind == "device_revoked") {
                store.clearPairing()
                Scheduler.stopAll(applicationContext)
                Notify.alert(applicationContext, "This phone was disconnected from your store. Open the app to connect it again.")
            }
        } catch (e: IOException) {
            store.lastError = "No connection to Mwakete.com (${e.message ?: "network"}). Will try again."
        } finally {
            running.unlock()
        }
        return Result.success()
    }

    private suspend fun loop() {
        val started = SystemClock.elapsedRealtime()
        fun timeUp() = SystemClock.elapsedRealtime() - started > (if (foreground) 50 else 8) * 60_000L
        sync(allowTake = true)
        var lastSync = SystemClock.elapsedRealtime()
        while (true) {
            store.dropStale()
            if (store.paused || store.quietNow() || store.suspended || timeUp() || !Sender.canSend(applicationContext)) break
            val m = store.nextPending()
            if (m == null) {
                // Let Android's answers arrive, report them, and ask for more.
                if (store.heldCount() > 0) delay(4_000)
                val got = sync(allowTake = !timeUp())
                lastSync = SystemClock.elapsedRealtime()
                if (got == 0) return
                continue
            }
            goForeground()
            Sender.send(applicationContext, store, m)
            delay(maxOf(5, m.optInt("intervalSeconds", store.settings.optInt("intervalSeconds", 20))) * 1000L)
            if (SystemClock.elapsedRealtime() - lastSync > 60_000L) {
                sync(allowTake = false)
                lastSync = SystemClock.elapsedRealtime()
            }
        }
        // Stopped early (pause, quiet hours, time): report what we have.
        if (store.heldCount() > 0) delay(3_000)
        sync(allowTake = false)
    }

    /** One smsDeviceSync. Answers how many new messages arrived. */
    private fun sync(allowTake: Boolean): Int {
        val ctx = applicationContext
        val results = store.peek("results", 500)
        val inbound = store.peek("inbound", 100)
        val settings = store.settings
        val take = if (!allowTake || !Sender.canSend(ctx)) 0 else SenderRules.take(
            settings.optInt("batchSize", 20), store.pendingCount(), store.paused, store.quietNow(), store.suspended)
        val sims = Sims.report(ctx, store.deviceId)
        val body = JSONObject()
            .put("deviceId", store.deviceId).put("deviceSecret", store.deviceSecret)
            .put("appVersion", appVersion()).put("androidVersion", Build.VERSION.RELEASE)
            .put("sims", sims).put("results", results).put("inbound", inbound).put("take", take)
        val res = Api.call("smsDeviceSync", body)
        store.drop("results", results.length())
        store.drop("inbound", inbound.length())
        store.sims = sims
        res.optJSONObject("settings")?.let { store.settings = it }
        store.dropStopped(res.optJSONArray("stop"))
        val messages = res.optJSONArray("messages")
        store.addMessages(messages)
        store.lastSyncAt = System.currentTimeMillis()
        if (res.optBoolean("rotateSecret", false)) rotate()
        return messages?.length() ?: 0
    }

    private fun rotate() {
        val res = Api.call("smsDeviceRotate", JSONObject().put("deviceId", store.deviceId).put("deviceSecret", store.deviceSecret))
        val secret = res.optString("deviceSecret")
        if (secret.isNotEmpty()) store.saveSecret(secret)
    }

    private suspend fun goForeground() {
        if (foreground) return
        try {
            setForeground(foregroundInfo())
            foreground = true
        } catch (e: Exception) {
            // Android may refuse a foreground service from the background; sending
            // still works, the run is just shorter (about 8 minutes).
        }
    }

    private fun foregroundInfo(): ForegroundInfo {
        val n = Notify.sending(applicationContext, "Sending your store's texts…")
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(Notify.SENDING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(Notify.SENDING_ID, n)
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo()

    private fun appVersion(): String = try {
        applicationContext.packageManager.getPackageInfo(applicationContext.packageName, 0).versionName ?: APP_VERSION_FALLBACK
    } catch (e: Exception) { APP_VERSION_FALLBACK }
}
