package biz.capricornus.arcsuite.mcp.adapter;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;

/** ArcSuite session cache. Read operations retry exactly once only after session expiry. */
final class SessionManager implements AutoCloseable {
    private final AdapterConfig config;
    private final ArcSuiteSoapClient soap;
    private final Map<String,Session> sessions = new ConcurrentHashMap<>();

    SessionManager(AdapterConfig config, ArcSuiteSoapClient soap) { this.config=config; this.soap=soap; }

    record Session(String id,String userDn,String requestVersion,long createdAt,long lastUsedAt,Semaphore semaphore) {
        Session touch(){return new Session(id,userDn,requestVersion,createdAt,System.currentTimeMillis(),semaphore);}
    }

    synchronized Session get(String clientProfileId) {
        Session s=sessions.get(clientProfileId); long now=System.currentTimeMillis();
        if(s==null || now-s.lastUsedAt()>config.sessionIdleTtlSeconds()*1000L || now-s.createdAt()>config.sessionMaxAgeSeconds()*1000L) {
            if(s!=null) safeLogout(s);
            s=login(); sessions.put(clientProfileId,s);
        } else { s=s.touch(); sessions.put(clientProfileId,s); }
        return s;
    }

    synchronized void forceLogin(String clientProfileId) { Session old=sessions.remove(clientProfileId); if(old!=null)safeLogout(old); sessions.put(clientProfileId,login()); }
    synchronized void logout(String clientProfileId) { Session s=sessions.remove(clientProfileId); if(s!=null)safeLogout(s); }

    <T> T read(String clientProfileId, SessionCall<T> call) {
        boolean retried=false;
        while(true) {
            Session s=get(clientProfileId); boolean acquired=false;
            try {
                s.semaphore().acquire(); acquired=true;
                return call.run(s.id());
            } catch(InterruptedException e){Thread.currentThread().interrupt();throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Interrupted waiting for ArcSuite session",false,null,e);}
            catch(AdapterException e){
                if(!retried && "ARCSUITE_SESSION_EXPIRED".equals(e.code)) { retried=true; synchronized(this){sessions.remove(clientProfileId);} continue; }
                throw e;
            } finally { if(acquired)s.semaphore().release(); }
        }
    }

    private Session login() {
        ArcSuiteSoapClient.LoginInfo info=soap.getLoginInfo();
        if(info.sessionId()==null||info.challenge()==null||info.publicKeyModulus()==null||info.publicKeyExponent()==null) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","ArcSuite getLoginInfo returned incomplete data");
        String credential=Crypto.encryptCredential(info.challenge(),config.password(),info.publicKeyModulus(),info.publicKeyExponent());
        String version=info.curVersion()==null||info.curVersion().isBlank()?config.requestVersion():info.curVersion();
        String userDn=soap.login(config.username(),credential,info.sessionId(),version);
        long now=System.currentTimeMillis();
        return new Session(info.sessionId(),userDn,version,now,now,new Semaphore(config.perSessionConcurrency(),true));
    }

    private void safeLogout(Session s){try{soap.logout(s.id());}catch(Exception ignored){}}
    @Override public synchronized void close(){for(Session s:sessions.values())safeLogout(s);sessions.clear();}
    @FunctionalInterface interface SessionCall<T>{T run(String sessionId);}
}
