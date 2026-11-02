package com.mwakete.sms

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import org.json.JSONObject

/** Hands one message to Android on the SIM the store chose. Never switches SIM. */
object Sender {
    const val ACTION_SENT = "com.mwakete.sms.SENT"
    const val ACTION_DELIVERED = "com.mwakete.sms.DELIVERED"

    fun canSend(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    fun send(context: Context, store: Store, m: JSONObject) {
        val id = m.optString("messageId")
        val simKey = m.optString("simKey")
        val subId = m.optString("subscriptionId").toIntOrNull() ?: -1
        val to = m.optString("to")
        val body = m.optString("body")
        if (to.isEmpty() || body.isEmpty()) { store.failNow(id, "bad_message", simKey); return }
        if (subId < 0 || !Sims.isActive(context, subId)) { store.failNow(id, "sim_missing", simKey); return }

        val manager = managerFor(context, subId)
        val parts = manager.divideMessage(body)
        // Committed before the send: if the app dies right after, the message is not sent again.
        store.markInFlight(id, parts.size)
        val sent = ArrayList<PendingIntent>()
        val delivered = ArrayList<PendingIntent>()
        for (i in parts.indices) {
            sent.add(pending(context, ACTION_SENT, id, i, parts.size, simKey))
            delivered.add(pending(context, ACTION_DELIVERED, id, i, parts.size, simKey))
        }
        try {
            if (parts.size == 1) manager.sendTextMessage(to, null, parts[0], sent[0], delivered[0])
            else manager.sendMultipartTextMessage(to, null, parts, sent, delivered)
            store.addResult(id, "submitted", "", simKey)
        } catch (e: Exception) {
            store.applyPart(id, false, 1)   // generic_failure
        }
    }

    private fun managerFor(context: Context, subId: Int): SmsManager =
        if (Build.VERSION.SDK_INT >= 31) context.getSystemService(SmsManager::class.java).createForSubscriptionId(subId)
        else @Suppress("DEPRECATION") SmsManager.getSmsManagerForSubscriptionId(subId)

    private fun pending(context: Context, action: String, id: String, part: Int, parts: Int, simKey: String): PendingIntent {
        // A distinct data URI per message part keeps every PendingIntent separate.
        val intent = Intent(action, Uri.parse("mwakete-sms://$action/$id/$part"), context, SmsResultReceiver::class.java)
            .putExtra("messageId", id).putExtra("part", part).putExtra("parts", parts).putExtra("simKey", simKey)
        // Mutable so Android can attach the delivery report (pdu); the intent is explicit.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, 0, intent, flags)
    }
}
