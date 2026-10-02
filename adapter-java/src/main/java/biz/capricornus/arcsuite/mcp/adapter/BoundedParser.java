package biz.capricornus.arcsuite.mcp.adapter;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Admission includes running and scheduled work, with no additional response backlog. */
final class BoundedParser implements AutoCloseable {
    private final ThreadPoolExecutor executor;
    private final Semaphore admission;
    private final java.util.concurrent.ConcurrentHashMap<FutureTask<?>, CompletableFuture<?>> tasks = new java.util.concurrent.ConcurrentHashMap<>();

    BoundedParser(int workers) {
        admission = new Semaphore(workers);
        executor = new ThreadPoolExecutor(workers, workers, 30, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(workers), task -> {
                    Thread thread = new Thread(task, "arcsuite-response-parser");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
        executor.allowCoreThreadTimeOut(true);
    }

    <T> T parse(RequestDeadline deadline, Callable<T> operation) {
        deadline.check();
        if (!admission.tryAcquire()) throw busy(null);
        FutureTask<T> work = new FutureTask<>(() -> {
            deadline.check();
            T value = operation.call();
            deadline.check();
            return value;
        });
        CompletableFuture<T> result = new CompletableFuture<>();
        tasks.put(work, result);
        boolean submitted = false;
        boolean completed = false;
        try {
            executor.execute(() -> {
                // Future cancellation does not release capacity while the callable is still executing.
                try { work.run(); }
                finally { admission.release(); }
                try { result.complete(work.get()); }
                catch (ExecutionException e) { result.completeExceptionally(e.getCause()); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); result.completeExceptionally(e); }
                catch (java.util.concurrent.CancellationException e) { result.completeExceptionally(e); }
                finally { tasks.remove(work); }
            });
            submitted = true;
            T value = result.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
            deadline.check();
            completed = true;
            return value;
        } catch (RejectedExecutionException e) {
            throw busy(e);
        } catch (TimeoutException e) {
            throw RequestDeadline.timeout(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response parsing interrupted", false, null, e);
        } catch (java.util.concurrent.CancellationException e) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response parsing cancelled", false, null, e);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof AdapterException mapped) throw mapped;
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response parsing failed", false, null, e.getCause());
        } finally {
            if (!completed) work.cancel(true);
            if (!submitted) { admission.release(); tasks.remove(work); }
        }
    }

    private static AdapterException busy(Throwable cause) {
        return new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response parser is busy", true, null, cause);
    }

    int activeCount() { return executor.getActiveCount(); }

    @Override public void close() {
        executor.shutdownNow();
        tasks.forEach((work, result) -> {
            work.cancel(true);
            result.completeExceptionally(new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response parser stopped"));
        });
        tasks.clear();
        try { executor.awaitTermination(1, TimeUnit.SECONDS); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
