package biz.capricornus.arcsuite.mcp.adapter;

import java.io.ByteArrayOutputStream;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Bounds bytes before copying and waits for EOF within the original request budget. */
final class BoundedHttpResponse {
    private BoundedHttpResponse() {}

    static HttpResponse<byte[]> send(HttpClient client, HttpRequest request, long maxBytes, RequestDeadline deadline) {
        Body body = new Body(maxBytes, deadline);
        CompletableFuture<HttpResponse<byte[]>> exchange = null;
        boolean completed = false;
        try {
            deadline.check();
            exchange = client.sendAsync(request, info -> {
                if (info.headers().firstValueAsLong("content-length").orElse(-1L) > maxBytes) {
                    body.fail(limit());
                }
                return body;
            });
            HttpResponse<byte[]> response = exchange.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
            deadline.check();
            completed = true;
            return response;
        } catch (TimeoutException e) {
            throw RequestDeadline.timeout(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite transport interrupted", false, null, e);
        } catch (java.util.concurrent.CancellationException e) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite transport cancelled", false, null, e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            while (cause instanceof java.util.concurrent.CompletionException && cause.getCause() != null) cause = cause.getCause();
            if (cause instanceof AdapterException mapped) throw mapped;
            if (cause instanceof HttpTimeoutException) throw RequestDeadline.timeout(cause);
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite transport failure", false, null, cause);
        } finally {
            if (!completed) {
                body.fail(new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response cancelled"));
                if (exchange != null) exchange.cancel(true);
            }
        }
    }

    private static AdapterException limit() {
        return new AdapterException("ARCSUITE_LIMIT_EXCEEDED", "SOAP/MTOM response exceeds configured maximum size");
    }

    static final class Body implements HttpResponse.BodySubscriber<byte[]> {
        private final long maxBytes;
        private final RequestDeadline deadline;
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private final ByteArrayOutputStream output;
        private Flow.Subscription subscription;
        private long received;
        private boolean terminal;

        Body(long maxBytes, RequestDeadline deadline) {
            if (maxBytes < 0 || maxBytes > Integer.MAX_VALUE) throw new IllegalArgumentException("Invalid response byte limit");
            this.maxBytes = maxBytes;
            this.deadline = deadline;
            this.output = new ByteArrayOutputStream((int) Math.min(maxBytes, 64 * 1024));
        }

        @Override public CompletionStage<byte[]> getBody() { return result; }

        @Override public synchronized void onSubscribe(Flow.Subscription next) {
            if (terminal || subscription != null) { next.cancel(); return; }
            subscription = next;
            next.request(Long.MAX_VALUE);
        }

        @Override public synchronized void onNext(List<ByteBuffer> buffers) {
            if (terminal) return;
            try {
                deadline.check();
                long batch = 0;
                for (ByteBuffer buffer : buffers) {
                    if (buffer.remaining() > maxBytes - received - batch) throw limit();
                    batch += buffer.remaining();
                }
                byte[] chunk = new byte[8192];
                for (ByteBuffer buffer : buffers) {
                    while (buffer.hasRemaining()) {
                        deadline.check();
                        int size = Math.min(buffer.remaining(), chunk.length);
                        buffer.get(chunk, 0, size);
                        output.write(chunk, 0, size);
                    }
                }
                received += batch;
            } catch (RuntimeException e) { fail(e); }
        }

        @Override public synchronized void onComplete() {
            if (terminal) return;
            try {
                deadline.check();
                byte[] bytes = output.toByteArray();
                deadline.check();
                terminal = true;
                output.reset();
                result.complete(bytes);
            } catch (RuntimeException e) { fail(e); }
        }

        @Override public void onError(Throwable error) { fail(error); }

        synchronized void fail(Throwable error) {
            if (terminal) return;
            terminal = true;
            output.reset();
            result.completeExceptionally(error);
            if (subscription != null) subscription.cancel();
        }
    }
}
