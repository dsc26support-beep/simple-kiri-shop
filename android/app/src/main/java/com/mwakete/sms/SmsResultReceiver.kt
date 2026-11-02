package com.mwakete.sms

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsMessage

/** Android's answers: each part sent (or not), and the delivery report for the last part. */
class SmsResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("messageId") ?: return
        val store = Store(context)
        if (!store.paired) return
        when (intent.action) {
            Sender.ACTION_SENT -> store.applyPart(id, resultCode == Activity.RESULT_OK, resultCode)
            Sender.ACTION_DELIVERED -> {
                val last = intent.getIntExtra("part", 0) == intent.getIntExtra("parts", 1) - 1
                if (last && delivered(intent)) store.addResult(id, "delivered", "", intent.getStringExtra("simKey") ?: "")
            }
        }
    }

    /** GSM status 0x00-0x1F means the handset got it; 0x20+ is pending or failed. */
    private fun delivered(intent: Intent): Boolean {
        if (resultCode != Activity.RESULT_OK) return false
        val pdu = intent.getByteArrayExtra("pdu") ?: return false
        val format = intent.getStringExtra("format") ?: "3gpp"
        val msg = SmsMessage.createFromPdu(pdu, format) ?: return false
        return if (format == "3gpp") msg.status in 0..0x1F else msg.status == 0
    }
}
