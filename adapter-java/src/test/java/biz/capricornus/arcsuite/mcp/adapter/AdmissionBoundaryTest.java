package biz.capricornus.arcsuite.mcp.adapter;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpPrincipal;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Exercises internal admission directly without sending network requests. */
final class AdmissionBoundaryTest {
    static void run() throws Exception {
        AdapterLimits limits = new AdapterLimits(2, 2, 1, 1);
        var config = new AdapterConfig("https://arcsuite.example.invalid/soap", "synthetic-user", "synthetic-password",
                "synthetic-token", 0, "127.0.0.1", Duration.ofSeconds(1), Duration.ofSeconds(1),
                1500, 1700, 1, "ja", "4.0.0.0", Path.of(System.getProperty("java.io.tmpdir")), 1024, limits);
        try (var soap = new ArcSuiteSoapClient(config); var sessions = new SessionManager(config, soap);
                var server = new InternalServer(config, new AdapterService(soap, sessions))) {
            var sessionsField = SessionManager.class.getDeclaredField("sessions");
            sessionsField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, SessionManager.Session> cached = (Map<String, SessionManager.Session>) sessionsField.get(sessions);
            Semaphore sessionPermit = new Semaphore(1);
            long now = System.currentTimeMillis();
            cached.put("synthetic-profile", new SessionManager.Session("synthetic-session", "synthetic-user", "4.0.0.0", now, now, sessionPermit));
            try {
                try {
                    sessions.read("synthetic-profile", ignored -> { throw RequestDeadline.timeout(null); });
                    throw new AssertionError("Timeout was not propagated");
                } catch (AdapterException expected) {
                    if (!"ARCSUITE_TIMEOUT".equals(expected.code) || sessionPermit.availablePermits() != 1) throw new AssertionError("Session permit retained after timeout");
                }
                if (!"ok".equals(sessions.read("synthetic-profile", ignored -> "ok"))) throw new AssertionError("Session did not recover");
            } finally { cached.clear(); }
            var gateField = InternalServer.class.getDeclaredField("admission");
            gateField.setAccessible(true);
            Semaphore gate = (Semaphore) gateField.get(server);
            var dispatch = InternalServer.class.getDeclaredMethod("dispatch", HttpExchange.class, boolean.class, InternalServer.Handler.class);
            dispatch.setAccessible(true);
            if (!gate.tryAcquire()) throw new AssertionError("Missing initial capacity");
            var overload = new Exchange();
            dispatch.invoke(server, overload, true, (InternalServer.Handler) () -> { throw new AssertionError("Overload dispatched business work"); });
            if (overload.status != 503 || !overload.output.toString(java.nio.charset.StandardCharsets.UTF_8).contains("ARCSUITE_UPSTREAM_ERROR")
                    || !"1".equals(overload.response.getFirst("retry-after")) || gate.availablePermits() != 0) throw new AssertionError("Incorrect overload response or permit release");
            gate.release();
            var normal = new Exchange();
            dispatch.invoke(server, normal, true, (InternalServer.Handler) () -> Map.of("ok", true));
            if (normal.status != 200 || gate.availablePermits() != 1) throw new AssertionError("Normal request did not release admission");
            var failed = new Exchange();
            dispatch.invoke(server, failed, true, (InternalServer.Handler) () -> { throw RequestDeadline.timeout(null); });
            if (failed.status != 504 || gate.availablePermits() != 1) throw new AssertionError("Failed request retained admission");

            var executorField = InternalServer.class.getDeclaredField("executor");
            executorField.setAccessible(true);
            ThreadPoolExecutor executor = (ThreadPoolExecutor) executorField.get(server);
            CountDownLatch entered = new CountDownLatch(2);
            CountDownLatch release = new CountDownLatch(1);
            Runnable blocking = () -> {
                entered.countDown();
                try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            };
            try {
                executor.execute(blocking); executor.execute(blocking);
                if (!entered.await(2, TimeUnit.SECONDS)) throw new AssertionError("Workers did not start");
                executor.execute(() -> {}); executor.execute(() -> {});
                try { executor.execute(() -> {}); throw new AssertionError("Full queue accepted another task"); }
                catch (RejectedExecutionException expected) { }
                if (executor.getPoolSize() > 2 || executor.getQueue().size() != 2) throw new AssertionError("Capacity bound exceeded");
            } finally { release.countDown(); }
        }
    }

    private static final class Exchange extends HttpExchange {
        final Headers request = new Headers();
        final Headers response = new Headers();
        final ByteArrayOutputStream output = new ByteArrayOutputStream();
        int status;
        Exchange() { request.set("x-internal-token", "synthetic-token"); }
        @Override public Headers getRequestHeaders() { return request; }
        @Override public Headers getResponseHeaders() { return response; }
        @Override public URI getRequestURI() { return URI.create("/internal/version"); }
        @Override public String getRequestMethod() { return "GET"; }
        @Override public HttpContext getHttpContext() { return null; }
        @Override public void close() { }
        @Override public InputStream getRequestBody() { return new ByteArrayInputStream(new byte[0]); }
        @Override public OutputStream getResponseBody() { return output; }
        @Override public void sendResponseHeaders(int code, long length) { status = code; }
        @Override public InetSocketAddress getRemoteAddress() { return new InetSocketAddress("127.0.0.1", 1); }
        @Override public int getResponseCode() { return status; }
        @Override public InetSocketAddress getLocalAddress() { return new InetSocketAddress("127.0.0.1", 2); }
        @Override public String getProtocol() { return "HTTP/1.1"; }
        @Override public Object getAttribute(String name) { return null; }
        @Override public void setAttribute(String name, Object value) { }
        @Override public void setStreams(InputStream input, OutputStream output) { }
        @Override public HttpPrincipal getPrincipal() { return null; }
    }
}
