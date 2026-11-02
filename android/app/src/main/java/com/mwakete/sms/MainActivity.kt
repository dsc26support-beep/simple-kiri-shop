package com.mwakete.sms

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

/**
 * Two screens, built in code (no layout files):
 *  - not connected: type the 8-character code from Mwakete.com > SMS > Phones & SIMs;
 *  - connected: store, SIMs, what is waiting, Check now / Pause / Disconnect.
 */
class MainActivity : Activity() {

    private lateinit var store: Store
    private val ui = Handler(Looper.getMainLooper())
    private val refresher = object : Runnable {
        override fun run() { if (store.paired) render(); ui.postDelayed(this, 5_000) }
    }

    private val purple = Color.parseColor("#5B3FA0")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        render()
    }

    override fun onResume() { super.onResume(); ui.post(refresher) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(refresher) }

    private fun permissionsNeeded(): Array<String> {
        val all = mutableListOf(Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= 33) all.add(Manifest.permission.POST_NOTIFICATIONS)
        return all.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toTypedArray()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
        if (store.paired) Scheduler.syncNow(this)
    }

    // ---- building blocks ----
    private fun page(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(24), dp(20), dp(24))
    }

    private fun text(s: String, size: Float = 16f, bold: Boolean = false, color: Int = Color.parseColor("#222222")) =
        TextView(this).apply {
            text = s; textSize = size; setTextColor(color)
            if (bold) typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(6), 0, dp(6))
        }

    private fun button(label: String, primary: Boolean = true, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 16f
        if (primary) { setBackgroundColor(purple); setTextColor(Color.WHITE) }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(10) }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun show(root: LinearLayout) { setContentView(ScrollView(this).apply { addView(root) }) }

    private fun render() { if (store.paired) renderConnected() else renderPairing() }

    // ---- not connected ----
    private fun renderPairing(message: String = "") {
        val root = page()
        root.addView(text("Mwakete SMS", 24f, true, purple))
        root.addView(text("Sends your store's texts from this phone's SIM. Each text uses your normal SMS credit with your carrier."))
        root.addView(text("1. On Mwakete.com open SMS › Phones & SIMs and press “Get a code”.\n2. Type the 8-character code here within 10 minutes.", 15f))
        val code = EditText(this).apply {
            hint = "ABCD2345"; textSize = 22f; gravity = Gravity.CENTER
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            filters = arrayOf(InputFilter.LengthFilter(12), InputFilter.AllCaps())
        }
        root.addView(code)
        val status = text(message, 15f, color = Color.parseColor("#B00020"))
        val connect = button("Connect") {}
        connect.setOnClickListener {
            val missing = permissionsNeeded()
            if (missing.any { it != Manifest.permission.POST_NOTIFICATIONS }) {
                status.text = "Please allow SMS and phone access first - the app cannot send without them."
                requestPermissions(missing, 1)
                return@setOnClickListener
            }
            connect.isEnabled = false
            status.setTextColor(Color.parseColor("#444444")); status.text = "Connecting…"
            pair(code.text.toString(), status, connect)
        }
        root.addView(connect)
        root.addView(status)
        root.addView(text("Only a reply of STOP (or UNSUBSCRIBE, CANCEL, END, QUIT) is reported to your store, so the number is opted out. No other messages leave this phone.", 13f, color = Color.parseColor("#666666")))
        show(root)
    }

    private fun pair(raw: String, status: TextView, connect: Button) {
        val body = JSONObject().put("code", raw.trim()).put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("appVersion", BuildConfig.VERSION_NAME).put("androidVersion", Build.VERSION.RELEASE)
        Thread {
            val error = try {
                store.savePairing(Api.call("smsPairDevice", body)); null
            } catch (e: ApiError) { e.message } catch (e: Exception) { "No connection to Mwakete.com. Check the internet and try again." }
            ui.post {
                if (error == null) {
                    Scheduler.ensurePeriodic(this); Scheduler.syncNow(this); render()
                } else {
                    connect.isEnabled = true
                    status.setTextColor(Color.parseColor("#B00020")); status.text = error
                }
            }
        }.start()
    }

    // ---- connected ----
    private fun renderConnected() {
        val s = store.settings
        val root = page()
        root.addView(text(store.storeName.ifEmpty { "Your store" }, 22f, true, purple))
        root.addView(text("This phone: ${store.deviceName}", 15f))

        val state = when {
            permissionsNeeded().any { it != Manifest.permission.POST_NOTIFICATIONS } -> "Needs SMS permission"
            store.paused -> "Paused on this phone"
            store.suspended -> "Sending is suspended for your store"
            store.quietNow() -> "Quiet hours (${s.optInt("quietStart")}:00–${s.optInt("quietEnd")}:00) - waiting"
            else -> "Ready"
        }
        root.addView(text(state, 18f, true))
        val last = store.lastSyncAt
        root.addView(text(
            "Last check-in: " + (if (last == 0L) "not yet" else DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(last))) +
            "\nWaiting to send: ${store.pendingCount()}   ·   Reports to upload: ${store.waiting("results")}" +
            "\nSent from this phone: ${store.sentCount}   ·   Failed: ${store.failedCount}", 15f))
        if (store.lastError.isNotEmpty()) root.addView(text(store.lastError, 14f, color = Color.parseColor("#B00020")))

        val sims = store.sims
        root.addView(text("SIMs", 17f, true))
        if (sims.length() == 0) root.addView(text("No SIM found (or phone access not allowed).", 14f))
        for (i in 0 until sims.length()) {
            val sim = sims.getJSONObject(i)
            val hint = sim.optString("numberHint").let { if (it.isEmpty()) "" else " · …$it" }
            root.addView(text("Slot ${sim.optInt("slotIndex") + 1}: ${sim.optString("carrierName").ifEmpty { sim.optString("displayName") }}$hint", 15f))
        }
        root.addView(text("Choose which SIM sends, and set limits, on Mwakete.com › SMS › Phones & SIMs.", 13f, color = Color.parseColor("#666666")))

        if (permissionsNeeded().isNotEmpty()) root.addView(button("Allow permissions") { requestPermissions(permissionsNeeded(), 1) })
        root.addView(button("Check now") { Scheduler.syncNow(this); toastLine(root, "Checking with Mwakete.com…") })
        root.addView(button(if (store.paused) "Resume sending" else "Pause sending", primary = false) {
            store.paused = !store.paused
            if (!store.paused) Scheduler.syncNow(this)
            render()
        })
        root.addView(button("Keep running in the background", primary = false) {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (e: Exception) { }
        })
        root.addView(button("Disconnect this phone", primary = false) { confirmDisconnect() })
        root.addView(text("Version ${BuildConfig.VERSION_NAME}", 12f, color = Color.parseColor("#888888")))
        show(root)
    }

    private fun toastLine(root: LinearLayout, s: String) {
        root.addView(text(s, 14f, color = Color.parseColor("#444444")), 3)
    }

    private fun confirmDisconnect() {
        AlertDialog.Builder(this)
            .setTitle("Disconnect this phone?")
            .setMessage("It stops sending for ${store.storeName.ifEmpty { "your store" }}. Texts it was holding will not be sent. Also remove it on Mwakete.com › SMS › Phones & SIMs.")
            .setPositiveButton("Disconnect") { _, _ ->
                Scheduler.stopAll(this); store.clearPairing(); render()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

}
