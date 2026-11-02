package com.mwakete.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.mwakete.sms.core.SmsCore

/**
 * Looks at incoming texts only for a lone STOP / UNSUBSCRIBE / STOP ALL /
 * CANCEL / END / QUIT. Those are reported so the number is opted out; every
 * other message stays on the phone and is never uploaded.
 */
class InboundSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val store = Store(context)
        if (!store.paired) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val bySender = LinkedHashMap<String, StringBuilder>()
        for (m in messages) {
            val from = m?.originatingAddress ?: continue
            bySender.getOrPut(from) { StringBuilder() }.append(m.messageBody ?: "")
        }
        var any = false
        for ((from, text) in bySender) {
            if (SmsCore.isStopReply(text.toString())) { store.addInbound(from, text.toString().trim()); any = true }
        }
        if (any) Scheduler.syncNow(context)
    }
}
