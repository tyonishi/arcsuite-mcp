package biz.capricornus.arcsuite.mcp.adapter;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
    Object getMany(Map<String,Object> body){
        String p=profile(body);
        Map<String,Object> request=prepareGetManyRequest(body);
        Map<String,Object> result=sessions.read(p,sid->soap.getMany(request,sid));
        validateGetManyAccounting(request,result);
        return result;
    }
    Object revisions(Map<String,Object> body){return sessions.read(profile(body),sid->soap.revisions(body,sid));}
    Object content(Map<String,Object> body){return sessions.read(profile(body),sid->soap.content(body,sid));}

    // v1.1 paging snapshots are keyed by the exact object IDs returned by the
    // ID-only ArcSuite operations. ResolveRef must therefore be false for the
    // follow-up batch fetch; callers can still resolve a reference through the
    // existing single-object/content paths. This keeps result identity stable.
    static Map<String,Object> prepareGetManyRequest(Map<String,Object> body){
        LinkedHashMap<String,Object> request=new LinkedHashMap<>(body);
        request.put("resolveRef",false);
        return request;
    }

    private static void validateGetManyAccounting(Map<String,Object> request,Map<String,Object> result){
        List<String> ids=stringList(request.get("ids"));
        if(ids.isEmpty())throw new IllegalArgumentException("ids required");
        if(new HashSet<>(ids).size()!=ids.size())throw new IllegalArgumentException("duplicate ids are not allowed");
        boolean[] accounted=new boolean[ids.size()];

        for(Map<String,Object> object:mapList(result.get("objects"))){
            Object rawId=object.get("id");
            if(!(rawId instanceof String id))throw upstreamAccounting();
            int index=ids.indexOf(id);
            if(index<0||accounted[index])throw upstreamAccounting();
            accounted[index]=true;
        }
        Set<Integer> failureIndexes=new HashSet<>();
        for(Map<String,Object> failure:mapList(result.get("failures"))){
            Object rawIndex=failure.get("index");
            if(!(rawIndex instanceof Number number))throw upstreamAccounting();
            int index=number.intValue();
            if(index<0||index>=ids.size()||!failureIndexes.add(index)||accounted[index])throw upstreamAccounting();
            accounted[index]=true;
        }
        for(boolean value:accounted)if(!value)throw upstreamAccounting();
    }

    private static AdapterException upstreamAccounting(){return new AdapterException("ARCSUITE_UPSTREAM_ERROR","Batch response accounting mismatch");}

    private static List<String> stringList(Object value){
        if(!(value instanceof List<?> list))return List.of();
        List<String> out=new ArrayList<>();
        for(Object item:list)if(item instanceof String text)out.add(text);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String,Object>> mapList(Object value){
        if(!(value instanceof List<?> list))return List.of();
        List<Map<String,Object>> out=new ArrayList<>();
        for(Object item:list)if(item instanceof Map<?,?> map)out.add((Map<String,Object>)map);
        return out;
    }

    private static String profile(Map<String,Object> body){Object p=body.get("clientProfileId");if(p==null||String.valueOf(p).isBlank())throw new IllegalArgumentException("clientProfileId required");return String.valueOf(p);}
}
