package com.mwakete.sms.core

/**
 * The phone's own sending rules, kept out of the Android code so they can be
 * tested anywhere. The server already enforces quiet hours, daily limits and
 * which SIM a campaign uses when it hands messages out (SmsDevices.gs); the
 * phone checks quiet hours again for messages it already holds, and turns
 * Android's per-part results into one status per message.
 */
object SenderRules {

    /** Local hour from a UTC hour and the store's offset (Kiribati: +12..+14). */
    fun localHour(utcHour: Int, utcOffset: Int): Int = ((utcHour + utcOffset) % 24 + 24) % 24

    /** Same rule as smsInQuietHours (SmsDevices.gs): start == end means no quiet hours; it may wrap past midnight. */
    fun inQuietHours(utcHour: Int, utcOffset: Int, quietStart: Int, quietEnd: Int): Boolean {
        if (quietStart == quietEnd) return false
        val h = localHour(utcHour, utcOffset)
        return if (quietStart < quietEnd) h in quietStart until quietEnd else h >= quietStart || h < quietEnd
    }

    /** How many new messages to ask for: room left in the batch, none while paused, quiet or suspended. */
    fun take(batchSize: Int, pendingNow: Int, paused: Boolean, quiet: Boolean, suspended: Boolean): Int =
        if (paused || quiet || suspended) 0 else maxOf(0, batchSize - pendingNow)

    /**
     * Android's SmsManager result codes as the error words the server knows
     * (SMS_RETRYABLE_ERRORS in SmsCampaigns.gs). Codes: RESULT_ERROR_GENERIC_FAILURE 1,
     * RADIO_OFF 2, NULL_PDU 3, NO_SERVICE 4, LIMIT_EXCEEDED 5.
     */
    fun errorName(resultCode: Int): String = when (resultCode) {
        1 -> "generic_failure"
        2 -> "radio_off"
        3 -> "null_pdu"
        4 -> "no_service"
        5 -> "limit_exceeded"
        else -> "error_$resultCode"
    }

    /**
     * One message is split into parts; Android reports each part. The message
     * is "sent" when every part was accepted, "failed" as soon as one part
     * failed (with that part's error), and undecided until then.
     */
    data class PartTally(val parts: Int, val ok: Int = 0, val error: String? = null) {
        fun add(success: Boolean, resultCode: Int): PartTally =
            if (success) copy(ok = ok + 1) else if (error == null) copy(error = errorName(resultCode)) else this
        val outcome: String? get() = when {
            error != null -> "failed"
            ok >= parts -> "sent"
            else -> null
        }
    }
}
