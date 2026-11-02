package com.mwakete.sms

import android.content.Context
import android.content.SharedPreferences
import com.mwakete.sms.core.SenderRules
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Everything the phone keeps, in one private SharedPreferences file:
 * the pairing (device id + secret), the store's sending settings, the
 * messages it holds, and the reports (results / STOP replies) waiting to
 * be uploaded. Every change is committed straight away, so a message is
 * marked as handed to Android *before* it is sent and is never sent twice.
 */
class Store(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("mwakete_sms", Context.MODE_PRIVATE)

    // ---- pairing ----
    val paired: Boolean get() = deviceId.isNotEmpty() && deviceSecret.isNotEmpty()
    val deviceId: String get() = prefs.getString("deviceId", "") ?: ""
    val deviceSecret: String get() = prefs.getString("deviceSecret", "") ?: ""
    val deviceName: String get() = prefs.getString("deviceName", "") ?: ""
    val storeName: String get() = prefs.getString("storeName", "") ?: ""

    fun savePairing(res: JSONObject) = synchronized(LOCK) {
        prefs.edit()
            .putString("deviceId", res.getString("deviceId"))
            .putString("deviceSecret", res.getString("deviceSecret"))
            .putString("deviceName", res.optString("name"))
            .putString("storeName", res.optString("storeName"))
            .putString("settings", (res.optJSONObject("settings") ?: JSONObject()).toString())
            .putString("queue", "[]").putString("results", "[]").putString("inbound", "[]")
            .putString("lastError", "").putBoolean("paused", false)
            .commit()
    }

    fun saveSecret(secret: String) = synchronized(LOCK) { prefs.edit().putString("deviceSecret", secret).commit() }

    /** Forgets the store. Messages still held are dropped; the server expires them. */
    fun clearPairing() = synchronized(LOCK) { prefs.edit().clear().commit() }

    // ---- settings & status ----
    var settings: JSONObject
        get() = JSONObject(prefs.getString("settings", "{}") ?: "{}")
        set(v) { prefs.edit().putString("settings", v.toString()).commit() }

    var paused: Boolean
        get() = prefs.getBoolean("paused", false)
        set(v) { prefs.edit().putBoolean("paused", v).commit() }

    var lastError: String
        get() = prefs.getString("lastError", "") ?: ""
        set(v) { prefs.edit().putString("lastError", v).commit() }

    var lastSyncAt: Long
        get() = prefs.getLong("lastSyncAt", 0L)
        set(v) { prefs.edit().putLong("lastSyncAt", v).commit() }

    var sims: JSONArray
        get() = JSONArray(prefs.getString("sims", "[]") ?: "[]")
        set(v) { prefs.edit().putString("sims", v.toString()).commit() }

    val sentCount: Int get() = prefs.getInt("sentCount", 0)
    val failedCount: Int get() = prefs.getInt("failedCount", 0)

    fun quietNow(nowMs: Long = System.currentTimeMillis()): Boolean {
        val s = settings
        val utcHour = ((nowMs / 3_600_000L) % 24).toInt()
        return SenderRules.inQuietHours(utcHour, s.optInt("utcOffset", 12), s.optInt("quietStart", 21), s.optInt("quietEnd", 8))
    }

    val suspended: Boolean get() = settings.optBoolean("suspended", false)

    // ---- the messages this phone holds ----
    private fun queue(): JSONArray = JSONArray(prefs.getString("queue", "[]") ?: "[]")
    private fun saveQueue(q: JSONArray) { prefs.edit().putString("queue", q.toString()).commit() }

    fun pendingCount(): Int = synchronized(LOCK) {
        val q = queue(); (0 until q.length()).count { q.getJSONObject(it).optString("state") == "pending" }
    }

    fun heldCount(): Int = synchronized(LOCK) { queue().length() }

    /** Adds a new batch from the server, skipping any id already held. */
    fun addMessages(messages: JSONArray?) = synchronized(LOCK) {
        if (messages == null || messages.length() == 0) return@synchronized
        val q = queue()
        val have = (0 until q.length()).map { q.getJSONObject(it).optString("messageId") }.toHashSet()
        val now = System.currentTimeMillis()
        for (i in 0 until messages.length()) {
            val m = messages.getJSONObject(i)
            if (!have.add(m.optString("messageId"))) continue
            m.put("state", "pending").put("heldAt", now)
            q.put(m)
        }
        saveQueue(q)
    }

    /** The server said these must not be sent (campaign paused / cancelled). Only unsent ones are dropped. */
    fun dropStopped(ids: JSONArray?) = synchronized(LOCK) {
        if (ids == null || ids.length() == 0) return@synchronized
        val stop = (0 until ids.length()).map { ids.optString(it) }.toHashSet()
        val q = queue(); val keep = JSONArray()
        for (i in 0 until q.length()) {
            val m = q.getJSONObject(i)
            if (m.optString("state") == "pending" && m.optString("messageId") in stop) continue
            keep.put(m)
        }
        saveQueue(keep)
    }

    /**
     * Drops what can no longer be trusted: unsent messages held for longer than
     * the server keeps a claim (48 h - it has expired them), and sent ones whose
     * Android answer never came (already reported as submitted).
     */
    fun dropStale(nowMs: Long = System.currentTimeMillis()) = synchronized(LOCK) {
        val q = queue(); val keep = JSONArray()
        for (i in 0 until q.length()) {
            val m = q.getJSONObject(i)
            val age = nowMs - m.optLong(if (m.optString("state") == "pending") "heldAt" else "sentAt", nowMs)
            val limit = if (m.optString("state") == "pending") 46 * 3_600_000L else 2 * 3_600_000L
            if (age > limit) continue
            keep.put(m)
        }
        saveQueue(keep)
    }

    fun nextPending(): JSONObject? = synchronized(LOCK) {
        val q = queue()
        (0 until q.length()).map { q.getJSONObject(it) }.firstOrNull { it.optString("state") == "pending" }
    }

    /** Marks a message as handed to Android - committed before the send call. */
    fun markInFlight(messageId: String, parts: Int) = synchronized(LOCK) {
        val q = queue()
        for (i in 0 until q.length()) {
            val m = q.getJSONObject(i)
            if (m.optString("messageId") == messageId) {
                m.put("state", "inflight").put("parts", parts).put("ok", 0).put("sentAt", System.currentTimeMillis())
            }
        }
        saveQueue(q)
    }

    /** One part's answer from Android. When the message is decided it leaves the queue and a result is queued. */
    fun applyPart(messageId: String, success: Boolean, resultCode: Int) = synchronized(LOCK) {
        val q = queue(); val keep = JSONArray()
        for (i in 0 until q.length()) {
            val m = q.getJSONObject(i)
            if (m.optString("messageId") != messageId || m.optString("state") != "inflight") { keep.put(m); continue }
            val tally = SenderRules.PartTally(m.optInt("parts", 1), m.optInt("ok", 0), m.optString("error").ifEmpty { null })
                .add(success, resultCode)
            when (tally.outcome) {
                null -> { m.put("ok", tally.ok); if (tally.error != null) m.put("error", tally.error); keep.put(m) }
                "sent" -> { addResultLocked(messageId, "sent", "", m.optString("simKey")); bump("sentCount") }
                else -> { addResultLocked(messageId, "failed", tally.error ?: "failed", m.optString("simKey")); bump("failedCount") }
            }
        }
        saveQueue(keep)
    }

    /** A message that could not be handed to Android at all. */
    fun failNow(messageId: String, error: String, simKey: String) = synchronized(LOCK) {
        val q = queue(); val keep = JSONArray()
        for (i in 0 until q.length()) { val m = q.getJSONObject(i); if (m.optString("messageId") != messageId) keep.put(m) }
        saveQueue(keep)
        addResultLocked(messageId, "failed", error, simKey)
        bump("failedCount")
    }

    private fun bump(key: String) { prefs.edit().putInt(key, prefs.getInt(key, 0) + 1).commit() }

    // ---- reports waiting to be uploaded ----
    fun addResult(messageId: String, status: String, error: String, simKey: String) =
        synchronized(LOCK) { addResultLocked(messageId, status, error, simKey) }

    private fun addResultLocked(messageId: String, status: String, error: String, simKey: String) {
        val r = JSONArray(prefs.getString("results", "[]") ?: "[]")
        r.put(JSONObject().put("messageId", messageId).put("status", status).put("error", error)
            .put("at", isoNow()).put("simKey", simKey))
        prefs.edit().putString("results", r.toString()).commit()
    }

    fun addInbound(from: String, text: String) = synchronized(LOCK) {
        val r = JSONArray(prefs.getString("inbound", "[]") ?: "[]")
        r.put(JSONObject().put("from", from).put("text", text).put("at", isoNow()))
        prefs.edit().putString("inbound", r.toString()).commit()
    }

    /** First [max] waiting reports of a kind ("results" / "inbound"). */
    fun peek(kind: String, max: Int): JSONArray = synchronized(LOCK) {
        val all = JSONArray(prefs.getString(kind, "[]") ?: "[]")
        val out = JSONArray()
        for (i in 0 until minOf(max, all.length())) out.put(all.get(i))
        out
    }

    /** Removes the first [n] reports once the server has them (new ones may have been added since the peek). */
    fun drop(kind: String, n: Int) = synchronized(LOCK) {
        if (n <= 0) return@synchronized
        val all = JSONArray(prefs.getString(kind, "[]") ?: "[]")
        val rest = JSONArray()
        for (i in n until all.length()) rest.put(all.get(i))
        prefs.edit().putString(kind, rest.toString()).commit()
    }

    fun waiting(kind: String): Int = synchronized(LOCK) { JSONArray(prefs.getString(kind, "[]") ?: "[]").length() }

    companion object {
        /** One lock for the whole process: the worker and the receivers share the file. */
        private val LOCK = Any()

        fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    }
}
