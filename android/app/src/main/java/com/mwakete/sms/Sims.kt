package com.mwakete.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The SIMs in the phone, as the server wants them: subscription id, slot,
 * carrier, the last digits of the number (when Android shares it) and a
 * salted hash of the SIM id - never the full number or SIM id.
 */
object Sims {

    fun canRead(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

    fun active(context: Context): List<SubscriptionInfo> {
        if (!canRead(context)) return emptyList()
        val sm = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        return try { sm.activeSubscriptionInfoList ?: emptyList() } catch (e: SecurityException) { emptyList() }
    }

    fun isActive(context: Context, subscriptionId: Int): Boolean = active(context).any { it.subscriptionId == subscriptionId }

    fun report(context: Context, deviceId: String): JSONArray {
        val out = JSONArray()
        for (info in active(context)) {
            @Suppress("DEPRECATION") val number = try { info.number ?: "" } catch (e: Exception) { "" }
            val digits = number.filter { it.isDigit() }
            val icc = try { info.iccId ?: "" } catch (e: Exception) { "" }
            out.put(JSONObject()
                .put("subscriptionId", info.subscriptionId)
                .put("slotIndex", info.simSlotIndex)
                .put("carrierName", info.carrierName?.toString() ?: "")
                .put("displayName", info.displayName?.toString() ?: "")
                .put("numberHint", if (digits.length >= 3) digits.takeLast(3) else "")
                .put("iccHash", if (icc.isBlank()) "" else sha256("$deviceId:$icc").take(32)))
        }
        return out
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
