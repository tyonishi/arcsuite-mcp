package biz.capricornus.arcsuite.mcp.adapter;

import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;

/** Deterministic response/subscription tests; no malformed network traffic. */
final class RequestBoundaryTest {
    static void run() throws Exception {
        boundedBody();
        acquisitionDeadline();
        parserDeadlineAndCapacity();
        parsingChecks();
        capacityConfiguration();
    }

    private static void boundedBody() {
        var body = new BoundedHttpResponse.Body(4, new RequestDeadline(Duration.ofSeconds(10)));
        var subscription = new Subscription();
        body.onSubscribe(subscription);
        body.onNext(List.of(ByteBuffer.wrap(new byte[]{1, 2}), ByteBuffer.wrap(new byte[]{3, 4})));
        if (body.getBody().toCompletableFuture().isDone()) throw new AssertionError("Headers/data are not EOF");
        body.onComplete();
        if (!java.util.Arrays.equals(body.getBody().toCompletableFuture().join(), new byte[]{1, 2, 3, 4})) throw new AssertionError("Exact byte limit changed");
        body.onError(new IllegalStateException("late"));
        if (subscription.cancelled) throw new AssertionError("Successful EOF cancelled");

        var oversized = new BoundedHttpResponse.Body(3, new RequestDeadline(Duration.ofSeconds(10)));
        var overSubscription = new Subscription();
        oversized.onSubscribe(overSubscription);
        var untouched = ByteBuffer.wrap(new byte[]{1, 2, 3, 4});
        oversized.onNext(List.of(untouched));
        if (!overSubscription.cancelled || untouched.position() != 0) throw new AssertionError("Limit must precede copying");
        expectFuture(oversized.getBody().toCompletableFuture(), "ARCSUITE_LIMIT_EXCEEDED");
        oversized.onComplete();

        var cancelled = new BoundedHttpResponse.Body(4, new RequestDeadline(Duration.ofSeconds(10)));
        cancelled.fail(RequestDeadline.timeout(null));
        var late = new Subscription();
        cancelled.onSubscribe(late);
        if (!late.cancelled || late.requested) throw new AssertionError("Late subscription must be cancelled");
        cancelled.onNext(List.of(ByteBuffer.wrap(new byte[]{1})));
        expectFuture(cancelled.getBody().toCompletableFuture(), "ARCSUITE_TIMEOUT");
    }

    private static void acquisitionDeadline() {
        var request = HttpRequest.newBuilder(URI.create("https://arcsuite.example.invalid/soap")).build();
        var stalled = new FakeClient(false, -1);
        expect(() -> BoundedHttpResponse.send(stalled, request, 4, new RequestDeadline(Duration.ofMillis(30))), "ARCSUITE_TIMEOUT");
        if (!stalled.subscription.cancelled || !stalled.response.isDone()) throw new AssertionError("Stalled acquisition retained work");

        var declared = new FakeClient(true, 5);
        expect(() -> BoundedHttpResponse.send(declared, request, 4, new RequestDeadline(Duration.ofSeconds(1))), "ARCSUITE_LIMIT_EXCEEDED");
        if (!declared.subscription.cancelled) throw new AssertionError("Declared oversize not cancelled");

        var normal = new FakeClient(true, 1);
        var response = BoundedHttpResponse.send(normal, request, 4, new RequestDeadline(Duration.ofSeconds(1)));
        if (response.body().length != 1) throw new AssertionError("Normal acquisition failed after timeout");

        Thread.currentThread().interrupt();
        try {
            expect(() -> BoundedHttpResponse.send(new FakeClient(false, -1), request, 4,
                    new RequestDeadline(Duration.ofSeconds(1))), "ARCSUITE_UPSTREAM_ERROR");
            if (!Thread.currentThread().isInterrupted()) throw new AssertionError("Interrupt was cleared");
        } finally { Thread.interrupted(); }
    }

    private static void parserDeadlineAndCapacity() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch exited = new CountDownLatch(1);
        try (var parser = new BoundedParser(1)) {
            try {
                expect(() -> parser.parse(new RequestDeadline(Duration.ofMillis(500)), () -> {
                    entered.countDown();
                    try {
                        while (release.getCount() != 0) {
                            try { release.await(); } catch (InterruptedException ignored) { /* Model an uncooperative library. */ }
                        }
                        return "late result";
                    } finally { exited.countDown(); }
                }), "ARCSUITE_TIMEOUT");
                if (entered.getCount() != 0 || parser.activeCount() != 1) throw new AssertionError("Cancelled parser capacity was released early");
                expect(() -> parser.parse(new RequestDeadline(Duration.ofSeconds(1)), () -> "not admitted"), "ARCSUITE_UPSTREAM_ERROR");
            } finally { release.countDown(); }
            if (!exited.await(2, TimeUnit.SECONDS)) throw new AssertionError("Parser did not exit");
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (parser.activeCount() != 0 && System.nanoTime() < until) Thread.yield();
            if (!"recovered".equals(parser.parse(new RequestDeadline(Duration.ofSeconds(1)), () -> "recovered"))) throw new AssertionError("Parser did not recover after cancellation");
        }
        try (var parser = new BoundedParser(1)) {
            for (int i = 0; i < 100; i++) {
                if (!"ok".equals(parser.parse(new RequestDeadline(Duration.ofSeconds(1)), () -> "ok"))) throw new AssertionError("Sequential parser handoff failed");
            }
            expect(() -> parser.parse(new RequestDeadline(Duration.ofSeconds(1)), () -> { throw RequestDeadline.timeout(null); }), "ARCSUITE_TIMEOUT");
        }
    }

    private static void parsingChecks() {
        AtomicLong clock = new AtomicLong();
        var deadline = new RequestDeadline(Duration.ofNanos(10), clock::get);
        clock.set(10);
        expect(() -> XmlUtil.parse("<root/>".getBytes(java.nio.charset.StandardCharsets.UTF_8), deadline), "ARCSUITE_TIMEOUT");
        expect(() -> MtomParser.parse("text/xml", new byte[0], deadline), "ARCSUITE_TIMEOUT");
        AtomicLong advancing = new AtomicLong();
        var duringRead = new RequestDeadline(Duration.ofNanos(3), advancing::getAndIncrement);
        expect(() -> XmlUtil.parse("<root/>".getBytes(java.nio.charset.StandardCharsets.UTF_8), duringRead), "ARCSUITE_TIMEOUT");
        expect(() -> XmlUtil.parse(new byte[]{0}, new RequestDeadline(Duration.ofSeconds(1))), "ARCSUITE_UPSTREAM_ERROR");
    }

    private static void capacityConfiguration() {
        AdapterLimits defaults = AdapterLimits.defaults();
        if (defaults.activeRequests() >= defaults.httpWorkers()) throw new AssertionError("No dispatch reserve");
        try { new AdapterLimits(4, 16, 4, 2); throw new AssertionError("Unbounded admission accepted"); }
        catch (IllegalArgumentException expected) { }
    }

    private static void expect(Runnable operation, String code) {
        try { operation.run(); throw new AssertionError("Expected " + code); }
        catch (AdapterException e) { if (!code.equals(e.code)) throw new AssertionError("Expected " + code + ", got " + e.code, e); }
    }

    private static void expectFuture(CompletableFuture<?> future, String code) {
        try { future.join(); throw new AssertionError("Expected " + code); }
        catch (java.util.concurrent.CompletionException e) {
            if (!(e.getCause() instanceof AdapterException mapped) || !code.equals(mapped.code)) throw new AssertionError(e);
        }
    }

    private static final class Subscription implements Flow.Subscription {
        boolean cancelled;
        boolean requested;
        @Override public void request(long count) { requested = true; }
        @Override public void cancel() { cancelled = true; }
    }

    private static final class FakeClient extends HttpClient {
        final Subscription subscription = new Subscription();
        final boolean complete;
        final long declared;
        CompletableFuture<?> response;
        FakeClient(boolean complete, long declared) { this.complete = complete; this.declared = declared; }
        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> handler) {
            HttpHeaders headers = HttpHeaders.of(declared < 0 ? Map.of() : Map.of("content-length", List.of(Long.toString(declared))), (a, b) -> true);
            HttpResponse.BodySubscriber<T> body = handler.apply(new HttpResponse.ResponseInfo() {
                public int statusCode() { return 200; }
                public HttpHeaders headers() { return headers; }
                public Version version() { return Version.HTTP_1_1; }
            });
            CompletableFuture<HttpResponse<T>> future = body.getBody().toCompletableFuture().thenApply(value -> new HttpResponse<T>() {
                public int statusCode() { return 200; }
                public HttpRequest request() { return request; }
                public Optional<HttpResponse<T>> previousResponse() { return Optional.empty(); }
                public HttpHeaders headers() { return headers; }
                public T body() { return value; }
                public Optional<SSLSession> sslSession() { return Optional.empty(); }
                public URI uri() { return request.uri(); }
                public Version version() { return Version.HTTP_1_1; }
            });
            response = future;
            body.onSubscribe(subscription);
            if (complete) { body.onNext(List.of(ByteBuffer.wrap(new byte[]{1}))); body.onComplete(); }
            return future;
        }
        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest r, HttpResponse.BodyHandler<T> h, HttpResponse.PushPromiseHandler<T> p) { return sendAsync(r, h); }
        @Override public <T> HttpResponse<T> send(HttpRequest r, HttpResponse.BodyHandler<T> h) { throw new UnsupportedOperationException(); }
        @Override public Optional<CookieHandler> cookieHandler() { return Optional.empty(); }
        @Override public Optional<Duration> connectTimeout() { return Optional.empty(); }
        @Override public Redirect followRedirects() { return Redirect.NEVER; }
        @Override public Optional<ProxySelector> proxy() { return Optional.empty(); }
        @Override public SSLContext sslContext() { throw new UnsupportedOperationException(); }
        @Override public SSLParameters sslParameters() { return new SSLParameters(); }
        @Override public Optional<Authenticator> authenticator() { return Optional.empty(); }
        @Override public Version version() { return Version.HTTP_1_1; }
        @Override public Optional<Executor> executor() { return Optional.empty(); }
    }
}
