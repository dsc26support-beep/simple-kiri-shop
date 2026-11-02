package com.mwakete.sms.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The same table the server (SmsCore.gs) and web copy (sms-core.js) are tested against. */
class SmsCoreTest {
    private val cases: JSONObject by lazy {
        val f = listOf("../../tests/sms-core-cases.json", "../tests/sms-core-cases.json").map { File(it) }.first { it.exists() }
        JSONObject(f.readText())
    }

    private fun strings(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }

    @Test fun segments() {
        val list = cases.getJSONArray("segments")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            val text = if (c.has("repeat")) c.getString("repeat").repeat(c.getInt("times")) else c.getString("text")
            val got = SmsCore.segmentInfo(text)
            val label = if (c.has("repeat")) c.getString("repeat") + "x" + c.getInt("times") else c.getString("text")
            assertEquals(c.getString("encoding"), got.encoding, "encoding of $label")
            assertEquals(c.getInt("units"), got.units, "units of $label")
            assertEquals(c.getInt("segments"), got.segments, "segments of $label")
        }
    }

    @Test fun phones() {
        val list = cases.getJSONArray("phones")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            val got = SmsCore.normalisePhone(c.getString("in"))
            assertEquals(c.getString("status"), got.status, "status of ${c.getString("in")}")
            assertEquals(c.getString("e164"), got.e164, "e164 of ${c.getString("in")}")
        }
    }

    @Test fun render() {
        val list = cases.getJSONArray("render")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            val contact = c.getJSONObject("contact").let { o -> o.keySet().associateWith { o.getString(it) } }
            val got = SmsCore.render(c.getString("template"), contact)
            assertEquals(c.getString("text"), got.text, "text of ${c.getString("template")}")
            assertEquals(strings(c.getJSONArray("missing")), got.missing, "missing of ${c.getString("template")}")
            if (c.has("unknown")) assertEquals(strings(c.getJSONArray("unknown")), got.unknown, "unknown of ${c.getString("template")}")
        }
    }

    @Test fun stopReplies() {
        assertTrue(SmsCore.isStopReply("STOP"))
        assertTrue(SmsCore.isStopReply(" Unsubscribe! "))
        assertTrue(SmsCore.isStopReply("stop all."))
        assertFalse(SmsCore.isStopReply("stop the music please"))
        assertFalse(SmsCore.isStopReply("Mauri, is the rice in?"))
    }

    @Test fun quietHours() {
        // Store at UTC+12, quiet 21:00-07:00 (the defaults).
        assertTrue(SenderRules.inQuietHours(10, 12, 21, 7))     // 22:00 local
        assertTrue(SenderRules.inQuietHours(18, 12, 21, 7))     // 06:00 local
        assertFalse(SenderRules.inQuietHours(19, 12, 21, 7))    // 07:00 local
        assertFalse(SenderRules.inQuietHours(0, 12, 21, 7))     // 12:00 local
        assertFalse(SenderRules.inQuietHours(5, 12, 0, 0))      // start == end: never quiet
        assertTrue(SenderRules.inQuietHours(1, 12, 13, 14))     // 13:00 local, a daytime window
        assertEquals(13, SenderRules.localHour(23, 14))         // UTC+14 (Line Islands) wraps
    }

    @Test fun take() {
        assertEquals(50, SenderRules.take(50, 0, paused = false, quiet = false, suspended = false))
        assertEquals(10, SenderRules.take(50, 40, paused = false, quiet = false, suspended = false))
        assertEquals(0, SenderRules.take(50, 60, paused = false, quiet = false, suspended = false))
        assertEquals(0, SenderRules.take(50, 0, paused = true, quiet = false, suspended = false))
        assertEquals(0, SenderRules.take(50, 0, paused = false, quiet = true, suspended = false))
        assertEquals(0, SenderRules.take(50, 0, paused = false, quiet = false, suspended = true))
    }

    @Test fun parts() {
        var t = SenderRules.PartTally(parts = 2)
        t = t.add(true, -1)
        assertEquals(null, t.outcome)
        t = t.add(true, -1)
        assertEquals("sent", t.outcome)
        var f = SenderRules.PartTally(parts = 3).add(true, -1).add(false, 4).add(false, 1)
        assertEquals("failed", f.outcome)
        assertEquals("no_service", f.error)   // the first failure wins
        assertEquals("error_99", SenderRules.errorName(99))
    }
}
