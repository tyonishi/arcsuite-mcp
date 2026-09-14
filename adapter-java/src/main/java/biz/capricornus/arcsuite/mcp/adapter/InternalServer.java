package biz.capricornus.arcsuite.mcp.adapter;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;

final class InternalServer implements AutoCloseable {
    private static final int MAX_REQUEST_BYTES = 2_000_000;
    private final AdapterConfig config;
    private final AdapterService service;
    private final HttpServer server;

    InternalServer(AdapterConfig config,AdapterService service) {
        this.config=config;this.service=service;
        try {server=HttpServer.create(new InetSocketAddress(config.bindHost(),config.port()),64);}
        catch(IOException e){throw new IllegalStateException("Cannot bind adapter HTTP server",e);}
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/internal/healthz",ex->dispatch(ex,false,()->Map.of("ok",true)));
        server.createContext("/internal/version",ex->dispatch(ex,true,service::version));
        server.createContext("/internal/session/login",ex->dispatch(ex,true,()->service.login(body(ex))));
        server.createContext("/internal/session/logout",ex->dispatch(ex,true,()->service.logout(body(ex))));
        server.createContext("/internal/session/info",ex->dispatch(ex,true,()->service.sessionInfo(body(ex))));
        server.createContext("/internal/schema/validate",ex->dispatch(ex,true,()->service.validate(body(ex))));
        server.createContext("/internal/repository/search",ex->dispatch(ex,true,()->service.search(body(ex))));
        server.createContext("/internal/repository/search-ids",ex->dispatch(ex,true,()->service.searchIds(body(ex))));
        server.createContext("/internal/repository/list",ex->dispatch(ex,true,()->service.list(body(ex))));
        server.createContext("/internal/repository/list-ids",ex->dispatch(ex,true,()->service.listIds(body(ex))));
        server.createContext("/internal/repository/get",ex->dispatch(ex,true,()->service.get(body(ex))));
        server.createContext("/internal/repository/get-many",ex->dispatch(ex,true,()->service.getMany(body(ex))));
        server.createContext("/internal/repository/hard-references",ex->dispatch(ex,true,()->service.hardReferences(body(ex))));
        server.createContext("/internal/repository/validate-integrity",ex->dispatch(ex,true,()->service.validateIntegrity(body(ex))));
        server.createContext("/internal/repository/certificate-evidence",ex->dispatch(ex,true,()->service.certificateEvidence(body(ex))));
        server.createContext("/internal/repository/revisions",ex->dispatch(ex,true,()->service.revisions(body(ex))));
        server.createContext("/internal/repository/content",ex->dispatch(ex,true,()->service.content(body(ex))));
    }

    void start(){server.start();System.out.println("ArcSuite SOAP adapter listening on "+config.bindHost()+":"+config.port());}
    @Override public void close(){server.stop(1);}

    private void dispatch(HttpExchange ex,boolean auth,Handler handler)throws IOException {
        try {
            if(auth && !constantTimeEquals(config.internalToken(),ex.getRequestHeaders().getFirst("x-internal-token"))) {send(ex,401,Map.of("code","UNAUTHORIZED","message","Unauthorized","retryable",false));return;}
            String method=ex.getRequestMethod();if(!method.equals("GET")&&!method.equals("POST")){send(ex,405,Map.of("code","METHOD_NOT_ALLOWED","message","Method not allowed","retryable",false));return;}
            Object result=handler.run();send(ex,200,result);
        } catch(AdapterException e) {LinkedHashMap<String,Object> m=new LinkedHashMap<>();m.put("code",e.code);m.put("message",e.code);m.put("retryable",e.retryable);if(e.upstreamCode!=null)m.put("upstreamCode",e.upstreamCode);send(ex,status(e),m);}
        catch(IllegalArgumentException e){send(ex,400,Map.of("code","ARCSUITE_INVALID_ARGUMENT","message","Invalid request","retryable",false));}
        catch(Exception e){send(ex,502,Map.of("code","ARCSUITE_UPSTREAM_ERROR","message","Adapter internal error","retryable",false));}
        finally{ex.close();}
    }

    private static int status(AdapterException e){return switch(e.code){case "ARCSUITE_INVALID_ARGUMENT"->400;case "ARCSUITE_FORBIDDEN"->403;case "ARCSUITE_NOT_AVAILABLE"->404;case "ARCSUITE_LIMIT_EXCEEDED"->413;case "ARCSUITE_TIMEOUT"->504;default->502;};}
    private static void send(HttpExchange ex,int status,Object value)throws IOException{byte[] b=Json.stringify(value).getBytes(StandardCharsets.UTF_8);ex.getResponseHeaders().set("content-type","application/json; charset=utf-8");ex.getResponseHeaders().set("cache-control","no-store");ex.sendResponseHeaders(status,b.length);ex.getResponseBody().write(b);}
    private static Map<String,Object> body(HttpExchange ex){try(InputStream input=ex.getRequestBody()){byte[] b=readBounded(input,MAX_REQUEST_BYTES);if(b.length==0)return Map.of();return Json.object(Json.parse(new String(b,StandardCharsets.UTF_8)));}catch(IOException e){throw new IllegalArgumentException("body read failed",e);}}
    static byte[] readBounded(InputStream input,int max)throws IOException{
        ByteArrayOutputStream out=new ByteArrayOutputStream(Math.min(max,64*1024));
        byte[] buffer=new byte[8192];int n;int total=0;
        while((n=input.read(buffer))!=-1){
            if(n>max-total)throw new IllegalArgumentException("request too large");
            out.write(buffer,0,n);total+=n;
        }
        return out.toByteArray();
    }
    private static boolean constantTimeEquals(String a,String b){if(a==null||b==null)return false;byte[] x=a.getBytes(StandardCharsets.UTF_8),y=b.getBytes(StandardCharsets.UTF_8);int diff=x.length^y.length;for(int i=0;i<Math.max(x.length,y.length);i++)diff|=(i<x.length?x[i]:0)^(i<y.length?y[i]:0);return diff==0;}
    @FunctionalInterface interface Handler{Object run();}
}
