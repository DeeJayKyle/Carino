package app.carino.android;

import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Catches the browser's return from "Sign in with Google / Microsoft / …". Providers send the
 * browser to http://localhost:47823/callback (or 127.0.0.1) with a one-time code; this listens on
 * the phone's loopback address only (never the network) for a few minutes, hands the code to the
 * app (which checks the random state it started with), and sends the browser back to Carino.
 */
final class SignInListener {
    static final int PORT = 47823;
    private static final int WAIT_MS = 10 * 60 * 1000;
    private static final String TAG = "Carino";
    private static final List<ServerSocket> sockets = new ArrayList<>();

    private SignInListener() {}

    /** Starts listening (or keeps listening). Returns an error message, or "" when ready. */
    static synchronized String start(NativeBridge bridge) {
        if (!sockets.isEmpty()) return "";
        String error = "";
        for (String host : new String[]{"127.0.0.1", "::1"}) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(InetAddress.getByName(host), PORT));
                s.setSoTimeout(WAIT_MS);
                sockets.add(s);
                Thread t = new Thread(() -> serve(s, bridge), "carino-sign-in");
                t.setDaemon(true);
                t.start();
            } catch (Exception e) {
                // ::1 isn't available on every phone; 127.0.0.1 is what matters.
                if (host.equals("127.0.0.1")) error = "Carino couldn’t get ready for sign-in (port " + PORT + " is busy). Close other apps and try again.";
                Log.w(TAG, "Sign-in listener on " + host + ": " + e.getMessage());
            }
        }
        if (!error.isEmpty()) stop();
        return error;
    }

    static synchronized void stop() {
        for (ServerSocket s : sockets) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
        sockets.clear();
    }

    private static void serve(ServerSocket server, NativeBridge bridge) {
        while (!server.isClosed()) {
            try (Socket client = server.accept()) {
                client.setSoTimeout(5000);
                BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                String line = in.readLine();
                String[] parts = line == null ? new String[0] : line.split(" ");
                String target = parts.length >= 2 ? parts[1] : "";
                OutputStream out = client.getOutputStream();
                if (!target.startsWith("/callback")) {
                    respond(out, "404 Not Found", "Not found");
                    continue;
                }
                int q = target.indexOf('?');
                String query = q >= 0 ? target.substring(q + 1) : "";
                respond(out, "200 OK", page());
                bridge.emit("window.__hn && __hn.oauth(" + NativeBridge.quote(query) + ")");
                stop();
                return;
            } catch (SocketTimeoutException e) {
                stop();
                return;
            } catch (Exception e) {
                if (server.isClosed()) return;
            }
        }
    }

    private static void respond(OutputStream out, String status, String html) throws Exception {
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String page() {
        String back = "intent://oauth#Intent;scheme=carino;package=" + BuildConfig.APPLICATION_ID + ";end";
        return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<title>Back to Carino</title><style>body{font-family:system-ui,sans-serif;background:#faf7f2;color:#1f1b2e;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px;text-align:center}"
                + "a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:999px;background:#1f1b2e;color:#fff;text-decoration:none;font-weight:600}</style></head>"
                + "<body><div><h1>Signed in</h1><p>You can go back to Carino now.</p><a href='" + back + "'>Back to Carino</a></div>"
                + "<script>setTimeout(function(){location.replace('" + back + "')},300)</script></body></html>";
    }
}
