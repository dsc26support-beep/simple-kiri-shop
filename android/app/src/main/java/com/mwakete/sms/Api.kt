package com.mwakete.sms

import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** A refusal from Mwakete.com (ok:false). [kind] is errorKind, e.g. "device_revoked". */
class ApiError(message: String, val kind: String = "") : Exception(message)

/**
 * Talks to the same Apps Script backend as the website: POST text/plain JSON
 * with "action" in the body. Apps Script answers a POST with a 302 to
 * script.googleusercontent.com, which must be fetched with a GET.
 */
object Api {

    @Throws(IOException::class, ApiError::class)
    fun call(action: String, body: JSONObject): JSONObject {
        body.put("action", action)
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        var conn = (URL(BuildConfig.API_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            instanceFollowRedirects = false
            connectTimeout = 30_000
            readTimeout = 90_000
            setRequestProperty("Content-Type", "text/plain;charset=utf-8")
            setFixedLengthStreamingMode(bytes.size)
        }
        try {
            conn.outputStream.use { it.write(bytes) }
            var code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location") ?: throw IOException("Redirect without a location")
                val next = URL(conn.url, location)
                conn.disconnect()
                conn = (next.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    instanceFollowRedirects = true
                    connectTimeout = 30_000
                    readTimeout = 90_000
                }
                code = conn.responseCode
            }
            if (code !in 200..299) throw IOException("Mwakete.com answered $code")
            val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val json = try { JSONObject(text) } catch (e: JSONException) { throw IOException("Unexpected answer from Mwakete.com") }
            if (!json.optBoolean("ok", false)) {
                throw ApiError(json.optString("error", "Mwakete.com refused the request."), json.optString("errorKind", ""))
            }
            return json
        } finally {
            conn.disconnect()
        }
    }
}
