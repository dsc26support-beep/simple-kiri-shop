package com.mwakete.sms.core

/**
 * Mwakete Contacts & SMS - the shared rules, Kotlin port of
 * apps-script/SmsCore.gs (the server) and assets/js/sms-core.js (the web
 * composer). All three must give the answers in tests/sms-core-cases.json;
 * SmsCoreTest checks this port against that table. Plain Kotlin: no Android.
 */
object SmsCore {

    // GSM 03.38 basic set (one septet each) and the extension table (two:
    // escape + char). Anything else forces UCS-2 for the whole message.
    const val GSM7_BASIC = "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
        "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    const val GSM7_EXT = "^{}\\[~]|€\u000C"
    const val MAX_SEGMENTS = 10

    data class SegmentInfo(
        val encoding: String,      // "gsm7" | "ucs2"
        val units: Int,            // septets (GSM-7) or UTF-16 code units (UCS-2)
        val segments: Int,
        val perSegment: Int,
        val remaining: Int,
        val unicodeChars: List<String>
    )

    fun segmentInfo(text: String?): SegmentInfo {
        val s = text ?: ""
        var septets = 0
        val unicode = ArrayList<String>()
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            when {
                GSM7_BASIC.indexOf(ch) != -1 -> septets += 1
                GSM7_EXT.indexOf(ch) != -1 -> septets += 2
                else -> {
                    val cp = s.codePointAt(i)
                    val whole = if (cp > 0xFFFF) s.substring(i, i + 2) else ch.toString()
                    if (!unicode.contains(whole)) unicode.add(whole)
                    if (cp > 0xFFFF) i++
                }
            }
            i++
        }
        val encoding = if (unicode.isEmpty()) "gsm7" else "ucs2"
        val units = if (encoding == "gsm7") septets else s.length
        val single = if (encoding == "gsm7") 160 else 70
        val part = if (encoding == "gsm7") 153 else 67
        val segments = when {
            units == 0 -> 0
            units <= single -> 1
            else -> (units + part - 1) / part
        }
        val perSegment = if (segments <= 1) single else part
        val remaining = if (segments == 0) single else segments * perSegment - units
        return SegmentInfo(encoding, units, segments, perSegment, remaining, unicode)
    }

    data class Phone(val status: String, val e164: String, val country: String, val mobile: Boolean, val note: String)

    private const val KI_CODE = "686"
    private const val KI_NATIONAL_LEN = 8

    /** Checks a number without ever changing its digits (the only change: +686 added to a local number). */
    fun normalisePhone(raw: String?): Phone {
        val original = (raw ?: "").trim()
        if (original.isEmpty()) return Phone("missing", "", "", false, "No number")
        var s = original.replace(Regex("[\\s()\\-./]"), "")
        var intl = false
        if (s.startsWith("+")) { intl = true; s = s.substring(1) } else if (s.startsWith("00")) { intl = true; s = s.substring(2) }
        if (!Regex("^\\d+$").matches(s)) return Phone("invalid", "", "", false, "Not a phone number")

        var national: String? = null
        if (s.startsWith(KI_CODE) && (intl || s.length == KI_CODE.length + KI_NATIONAL_LEN)) national = s.substring(3)
        else if (!intl) national = s

        if (national != null) {
            if (national.length != KI_NATIONAL_LEN) return Phone("invalid", "", "KI", false, "Kiribati numbers have $KI_NATIONAL_LEN digits")
            val mobile = national.startsWith("730") || national.startsWith("630")
            return Phone(if (mobile) "ok" else "check", "+$KI_CODE$national", "KI", mobile,
                if (mobile) "" else "Not a Kiribati mobile number (may be a landline)")
        }
        if (s.length < 7 || s.length > 15) return Phone("invalid", "", "intl", false, "International numbers have 7 to 15 digits")
        return Phone("ok", "+$s", "intl", true, "International number")
    }

    val FIELDS = listOf("first_name", "last_name", "business_name", "island", "village")

    data class Rendered(val text: String, val missing: List<String>, val unknown: List<String>)

    /** {first_name}, {first_name|friend} and the other FIELDS from a contact map (firstName, lastName, businessName, island, village). */
    fun render(template: String?, contact: Map<String, String?> = emptyMap(), defaults: Map<String, String> = emptyMap()): Rendered {
        val values = mapOf("first_name" to contact["firstName"], "last_name" to contact["lastName"], "business_name" to contact["businessName"],
            "island" to contact["island"], "village" to contact["village"])
        val missing = ArrayList<String>()
        val unknown = ArrayList<String>()
        val text = Regex("\\{([a-z_]+)(\\|([^{}]*))?\\}").replace(template ?: "") { m ->
            val field = m.groupValues[1]
            val hasFb = m.groups[2] != null
            if (field !in FIELDS) { if (field !in unknown) unknown.add(field); return@replace m.value }
            val v = (values[field] ?: "").trim()
            when {
                v.isNotEmpty() -> v
                hasFb -> m.groupValues[3]
                !defaults[field].isNullOrEmpty() -> defaults[field]!!
                else -> { if (field !in missing) missing.add(field); "" }
            }
        }
        return Rendered(text.replace(Regex(" {2,}"), " ").replace(Regex(" ([,.!?])"), "$1").trim(), missing, unknown)
    }

    /** A reply that asks the store to stop - same words as SMS_STOP_WORDS in SmsDevices.gs. Only these leave the phone. */
    val STOP_WORDS = setOf("stop", "unsubscribe", "stop all", "stopall", "cancel", "end", "quit")
    fun isStopReply(text: String?): Boolean = (text ?: "").trim().lowercase().replace(Regex("[.!]+$"), "") in STOP_WORDS
}
