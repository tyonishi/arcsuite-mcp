package biz.capricornus.arcsuite.mcp.adapter;

import java.util.Map;

final class AdapterService {
    private final ArcSuiteSoapClient soap;
    private final SessionManager sessions;
    AdapterService(ArcSuiteSoapClient soap,SessionManager sessions){this.soap=soap;this.sessions=sessions;}

    Object version(){var v=soap.getVersionInfo();return Map.of("minVersion",v.minVersion()==null?"":v.minVersion(),"curVersion",v.curVersion()==null?"":v.curVersion());}
    Object login(Map<String,Object> body){String p=profile(body);sessions.forceLogin(p);return Map.of("ok",true);}
    Object logout(Map<String,Object> body){sessions.logout(profile(body));return Map.of("ok",true);}
    Object sessionInfo(Map<String,Object> body){return sessions.read(profile(body),soap::getSessionInfo);}
    Object validate(Map<String,Object> body){return sessions.read(profile(body),sid->soap.validateSchema(body,sid));}
    Object search(Map<String,Object> body){return sessions.read(profile(body),sid->soap.search(body,sid));}
    Object searchIds(Map<String,Object> body){return sessions.read(profile(body),sid->soap.searchIds(body,sid));}
    Object list(Map<String,Object> body){return sessions.read(profile(body),sid->soap.list(body,sid));}
    Object listIds(Map<String,Object> body){return sessions.read(profile(body),sid->soap.listIds(body,sid));}
    Object get(Map<String,Object> body){return sessions.read(profile(body),sid->soap.get(body,sid));}
    Object getMany(Map<String,Object> body){return sessions.read(profile(body),sid->soap.getMany(body,sid));}
    Object revisions(Map<String,Object> body){return sessions.read(profile(body),sid->soap.revisions(body,sid));}
    Object content(Map<String,Object> body){return sessions.read(profile(body),sid->soap.content(body,sid));}

    private static String profile(Map<String,Object> body){Object p=body.get("clientProfileId");if(p==null||String.valueOf(p).isBlank())throw new IllegalArgumentException("clientProfileId required");return String.valueOf(p);}
}
