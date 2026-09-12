package biz.capricornus.arcsuite.mcp.adapter;

public final class Main {
    public static void main(String[] args) throws Exception {
        AdapterConfig config=AdapterConfig.fromEnv();
        ArcSuiteSoapClient soap=new ArcSuiteSoapClient(config);
        SessionManager sessions=new SessionManager(config,soap);
        AdapterService service=new AdapterService(soap,sessions);
        InternalServer server=new InternalServer(config,service);
        Runtime.getRuntime().addShutdownHook(new Thread(()->{try{server.close();sessions.close();}catch(Exception ignored){}}));
        server.start();
        Thread.currentThread().join();
    }
}
