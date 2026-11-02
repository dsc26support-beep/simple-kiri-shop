package com.mwakete.sms

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

object Notify {
    private const val CHANNEL = "sending"
    const val SENDING_ID = 1
    private const val ALERT_ID = 2

    private fun channel(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Sending texts", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun builder(context: Context): Notification.Builder {
        channel(context)
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
        return b.setSmallIcon(R.drawable.ic_notify).setContentIntent(open)
    }

    fun sending(context: Context, text: String): Notification =
        builder(context).setContentTitle("Mwakete SMS").setContentText(text).setOngoing(true).build()

    fun alert(context: Context, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        context.getSystemService(NotificationManager::class.java)
            .notify(ALERT_ID, builder(context).setContentTitle("Mwakete SMS").setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text)).setAutoCancel(true).build())
    }
}
