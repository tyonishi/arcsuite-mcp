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
    Object hardReferences(Map<String,Object> body){
        Map<String,Object> request=prepareHardReferenceRequest(body);
        String p=String.valueOf(request.get("clientProfileId"));
        return sessions.read(p,sid->soap.hardReferences(request,sid));
    }
    Object validateIntegrity(Map<String,Object> body){
        Map<String,Object> request=prepareIntegrityRequest(body);
        String p=String.valueOf(request.get("clientProfileId"));
        return sessions.read(p,sid->soap.validateIntegrity(request,sid));
    }
    Object certificateEvidence(Map<String,Object> body){
        Map<String,Object> request=prepareEvidenceRequest(body);
        String p=String.valueOf(request.get("clientProfileId"));
        return sessions.read(p,sid->soap.certificateEvidence(request,sid));
    }
    Object getMany(Map<String,Object> body){
        String p=profile(body);
        Map<String,Object> request=prepareGetManyRequest(body);
        Map<String,Object> result=sessions.read(p,sid->soap.getMany(request,sid));
        validateGetManyAccounting(request,result);
        return result;
    }

    static Map<String,Object> prepareHardReferenceRequest(Map<String,Object> body){
        if(!body.keySet().equals(Set.of("clientProfileId","id","maxResults")))throw new IllegalArgumentException("Unexpected Hard Reference request fields");
        String p=profile(body);
        Object rawId=body.get("id");
        if(!(rawId instanceof String id))throw new IllegalArgumentException("id is required");
        id=ArcSuiteSoapClient.requiredRepositoryObjectId(id,"id");
        int maxResults=ArcSuiteSoapClient.hardReferenceMaxResults(body.get("maxResults"));
        return Map.of("clientProfileId",p,"id",id,"maxResults",maxResults);
    }
    static Map<String,Object> prepareIntegrityRequest(Map<String,Object> body){
        if(!body.keySet().equals(Set.of("clientProfileId","id")))throw new IllegalArgumentException("Unexpected integrity request fields");
        String p=profile(body);
        Object rawId=body.get("id");
        if(!(rawId instanceof String id))throw new IllegalArgumentException("id is required");
        id=ArcSuiteSoapClient.requiredRepositoryObjectId(id,"id");
        return Map.of("clientProfileId",p,"id",id);
    }
    static Map<String,Object> prepareEvidenceRequest(Map<String,Object> body){
        if(!body.keySet().equals(Set.of("clientProfileId","id")))throw new IllegalArgumentException("Unexpected evidence request fields");
        String p=profile(body);
        Object rawId=body.get("id");
        if(!(rawId instanceof String id))throw new IllegalArgumentException("id is required");
        id=ArcSuiteSoapClient.requiredRepositoryObjectId(id,"id");
        return Map.of("clientProfileId",p,"id",id);
    }
    Object revisions(Map<String,Object> body){return sessions.read(profile(body),sid->soap.revisions(body,sid));}
    Object content(Map<String,Object> body){
        Map<String,Object> request=prepareContentRequest(body);
        String p=String.valueOf(request.get("clientProfileId"));
        return sessions.read(p,sid->soap.content(request,sid));
    }

    static Map<String,Object> prepareContentRequest(Map<String,Object> body){
        Set<String> required=Set.of("clientProfileId","requestedId","effectiveId","revisionNumber","contentWireId","contentLabel","options","traceId");
        Set<String> allowed=new HashSet<>(required);
        if(!body.keySet().containsAll(required) || body.keySet().stream().anyMatch(key->!allowed.contains(key)))throw new IllegalArgumentException("Unexpected content request fields");
        String p=profile(body);
        Object rawRequested=body.get("requestedId");
        Object rawEffective=body.get("effectiveId");
        if(!(rawRequested instanceof String requestedId)||!(rawEffective instanceof String effectiveId))throw new IllegalArgumentException("content identities are required");
        requestedId=ArcSuiteSoapClient.requiredRepositoryObjectId(requestedId,"requestedId");
        effectiveId=ArcSuiteSoapClient.requiredRepositoryObjectId(effectiveId,"effectiveId");
        int revisionNumber=ArcSuiteSoapClient.revisionNumber(body.get("revisionNumber"));
        Object rawWire=body.get("contentWireId");
        if(!(rawWire instanceof String contentWireId))throw new IllegalArgumentException("contentWireId is required");
        contentWireId=ArcSuiteSoapClient.requiredRepositoryObjectId(contentWireId,"contentWireId");
        if(!ArcSuiteSoapClient.revisionWireId(effectiveId,revisionNumber).equals(contentWireId))throw new IllegalArgumentException("contentWireId does not match effectiveId and revisionNumber");
        Map<String,Object> label=map(body.get("contentLabel"));
        if(!label.keySet().equals(Set.of("ns","name")))throw new IllegalArgumentException("contentLabel must be a physical label");
        requiredText(label,"ns");
        requiredText(label,"name");
        Object rawOptions=body.get("options");
        if(!(rawOptions instanceof List<?> rawOptionList)
                || rawOptionList.stream().anyMatch(option -> !(option instanceof String))) {
            throw new IllegalArgumentException("Unsupported content option");
        }
        List<String> options=new ArrayList<>();
        for(Object option:rawOptionList) options.add((String)option);
        if(options.stream().anyMatch(option->!option.equals("errorOnOfflineContent"))) throw new IllegalArgumentException("Unsupported content option");
        String traceId=requiredText(body,"traceId");
        LinkedHashMap<String,Object> request=new LinkedHashMap<>();
        request.put("clientProfileId",p);
        request.put("requestedId",requestedId);
        request.put("effectiveId",effectiveId);
        request.put("revisionNumber",revisionNumber);
        request.put("contentWireId",contentWireId);
        request.put("contentLabel",Map.of("ns",label.get("ns"),"name",label.get("name")));
        request.put("options",List.copyOf(options));
        request.put("traceId",traceId);
        return request;
    }

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

    @SuppressWarnings("unchecked") private static Map<String,Object> map(Object value){if(!(value instanceof Map<?,?> map))throw new IllegalArgumentException("contentLabel is required");return (Map<String,Object>)map;}
    private static String requiredText(Map<String,Object> map,String key){Object value=map.get(key);if(!(value instanceof String text)||text.isBlank())throw new IllegalArgumentException(key+" is required");return text;}
}
