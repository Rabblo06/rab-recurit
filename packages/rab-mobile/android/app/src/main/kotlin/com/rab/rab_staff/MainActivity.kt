package com.rab.rab_staff

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.os.PersistableBundle
import android.provider.MediaStore
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// FlutterFragmentActivity (not FlutterActivity) — AndroidX BiometricPrompt
// requires a FragmentActivity host, used by local_auth for biometric login.
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // "Download PDF": saves already-authorised report bytes into the public Downloads collection via MediaStore
        // (Android 10+, no storage permission needed). Returns the content URI, or null below Android 10 so the Dart
        // side falls back to the share sheet. Bytes only — no URL, token or credential ever crosses this channel.
        // Account security: FLAG_SECURE while the setup key or recovery codes are on screen (blocks screenshots, screen
        // recording and the Recents thumbnail; cleared when those screens leave), and a clipboard copy marked sensitive
        // so Android 13+ does not preview it. Nothing crossing this channel is logged or stored.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "rab/secure_window").setMethodCallHandler { call, result ->
            when (call.method) {
                "setSecure" -> {
                    if (call.argument<Boolean>("secure") == true) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                    result.success(null)
                }
                "copySensitive" -> {
                    val text = call.argument<String>("text")
                    val clipboard = getSystemService(CLIPBOARD_SERVICE) as? ClipboardManager
                    if (text == null || clipboard == null) {
                        result.success(false)
                    } else {
                        val clip = ClipData.newPlainText("Crewflow", text)
                        clip.description.extras = PersistableBundle().apply {
                            val key = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                ClipDescription.EXTRA_IS_SENSITIVE
                            } else {
                                "android.content.extra.IS_SENSITIVE"
                            }
                            putBoolean(key, true)
                        }
                        clipboard.setPrimaryClip(clip)
                        result.success(true)
                    }
                }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "rab/downloads").setMethodCallHandler { call, result ->
            if (call.method != "saveToDownloads") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                result.success(null)
                return@setMethodCallHandler
            }
            try {
                val bytes = call.argument<ByteArray>("bytes")!!
                val filename = call.argument<String>("filename")!!
                val mime = call.argument<String>("mimeType") ?: "application/pdf"
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert failed")
                resolver.openOutputStream(uri)!!.use { it.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                result.success(uri.toString())
            } catch (e: Exception) {
                result.error("SAVE_FAILED", "Could not save the file to Downloads.", null)
            }
        }
    }
}
