package biz.capricornus.arcsuite.mcp.adapter;

import org.w3c.dom.Document;
import org.w3c.dom.Element;

import javax.xml.XMLConstants;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.*;

/**
 * Minimal ArcSuite 4.0 SOAP 1.1 client for the read-only operation allowlist.
 * Contract authority: the operator's licensed ArcSuite Web Service Interface
 * Reference Guide and WSDL. Vendor material is intentionally not packaged.
 * No admin/privilege/mutation operation is implemented here by design.
 */
final class ArcSuiteSoapClient {
    static final String BASE_NS = "http://www.fujifilm.com/fb/2021/04/arcsuite/ws";
    static final String TYPES_NS = "http://www.fujifilm.com/fb/2021/04/arcsuite/ws/types";
    static final String SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
    static final String XSI_NS = XMLConstants.W3C_XML_SCHEMA_INSTANCE_NS_URI;
    static final String ENCRYPTED_PASSWORD_URI = BASE_NS + "#EncryptedPassword";
    static final Set<String> READ_ONLY_OPERATIONS = Set.of(
            "getVersionInfo", "getLoginInfo", "login", "logout", "getSessionInfo",
            "getAttributeSchema", "getAttributeSchemas", "getRepositoryObject",
            "getRepositoryObjects", "getRepositoryObjectByRevisionNumber",
            "getRepositoryObjectPath", "getRepositoryObjectPaths", "getRepositoryObjectContent",
            "getRepositoryObjectContentWithOptions", "listRepositoryObjects", "listRepositoryObjectIds",
            "searchRepositoryObjects", "searchRepositoryObjectIds", "listRepositoryObjectRevisions", "listRepositoryServices",
            "getCabinetInformation", "getCabinetInformations", "getRepositoryObjectClassDefinitions"
    );

    private final AdapterConfig config;
    private final HttpClient http;

    ArcSuiteSoapClient(AdapterConfig config) {
        this.config = config;
        this.http = HttpClient.newBuilder()
                .connectTimeout(config.connectTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    record LoginInfo(String sessionId, String challenge, String publicKeyModulus, String publicKeyExponent, String minVersion, String curVersion) {}
    record VersionInfo(String minVersion, String curVersion) {}
    record SoapResponse(Document document, Map<String,byte[]> attachments) {}

    VersionInfo getVersionInfo() {
        SoapResponse r = invoke("getVersionInfo", "", null, false);
        Element result = findResponseValue(r.document(), "result", "getVersionInfoReturn");
        if (result == null) result = XmlUtil.firstDesc(r.document().getDocumentElement(), "VersionInfo");
        return new VersionInfo(value(result, "minVersion"), value(result, "curVersion"));
    }

    LoginInfo getLoginInfo() {
        SoapResponse r = invoke("getLoginInfo", "", null, false);
        Element result = findResponseValue(r.document(), "result", "getLoginInfoReturn");
        return new LoginInfo(value(result,"sessionId"), value(result,"challenge"), value(result,"publicKeyModulus"), value(result,"publicKeyExponent"), value(result,"minVersion"), value(result,"curVersion"));
    }

    String login(String userId, String encryptedCredential, String sessionId, String requestVersion) {
        String body = el("userId", userId) + el("credentialType", ENCRYPTED_PASSWORD_URI) + el("credential", encryptedCredential)
                + keyed("requestVersion", requestVersion)
                + keyed("attachmentType", "mtom")
                + keyed("locale", config.locale());
        SoapResponse r = invoke("login", body, sessionId, true);
        Element result = findResponseValue(r.document(), "result", "loginReturn");
        return result == null ? null : result.getTextContent();
    }

    void logout(String sessionId) { invoke("logout", "", sessionId, true); }

    Map<String,Object> getSessionInfo(String sessionId) {
        SoapResponse r = invoke("getSessionInfo", "", sessionId, true);
        Element result = findResponseValue(r.document(), "result", "getSessionInfoReturn");
        LinkedHashMap<String,Object> out = new LinkedHashMap<>();
        if (result != null) {
            for (String k : List.of("userId","userDn","loginTime","locale","timezone","attachmentType")) {
                String v=value(result,k); if(v!=null) out.put(k,v);
            }
        }
        return out;
    }

    List<Map<String,Object>> search(Map<String,Object> req, String sessionId) {
        SoapResponse r=invoke("searchRepositoryObjects",searchBody(req,true),sessionId,true);
        Element ret=findResponseValue(r.document(),"searchRepositoryObjectsReturn","result");
        return parseRepositoryObjects(ret);
    }

    List<String> searchIds(Map<String,Object> req, String sessionId) {
        SoapResponse r=invoke("searchRepositoryObjectIds",searchBody(req,false),sessionId,true);
        Element ret=findResponseValue(r.document(),"searchRepositoryObjectIdsReturn","result");
        return parseStringArray(ret);
    }

    List<Map<String,Object>> list(Map<String,Object> req, String sessionId) {
        StringBuilder b=new StringBuilder();
        b.append(el("id", requiredString(req,"locationId")));
        b.append(el("latestOnly", String.valueOf(bool(req,"latestOnly",true))));
        b.append(sortCondition(req.get("order")));
        b.append(el("limit",String.valueOf(integer(req,"limit",20))));
        b.append(attrIds(req.get("attrIds")));
        b.append(options(req.get("options")));
        SoapResponse r=invoke("listRepositoryObjects",b.toString(),sessionId,true);
        Element ret=findResponseValue(r.document(),"listRepositoryObjectsReturn","result");
        return parseRepositoryObjects(ret);
    }

    List<String> listIds(Map<String,Object> req, String sessionId) {
        StringBuilder b=new StringBuilder();
        b.append(el("id", requiredString(req,"locationId")));
        b.append(el("latestOnly", String.valueOf(bool(req,"latestOnly",true))));
        b.append(sortCondition(req.get("order")));
        b.append(el("limit",String.valueOf(integer(req,"limit",20))));
        b.append(options(req.get("options")));
        SoapResponse r=invoke("listRepositoryObjectIds",b.toString(),sessionId,true);
        Element ret=findResponseValue(r.document(),"listRepositoryObjectIdsReturn","result");
        return parseStringArray(ret);
    }

    Map<String,Object> get(Map<String,Object> req, String sessionId) {
        String id=requiredString(req,"id");
        Object rev=req.get("revisionNumber");
        String op;
        StringBuilder b=new StringBuilder();
        b.append(el("id",id));
        if (rev instanceof Number n) {
            op="getRepositoryObjectByRevisionNumber";
            b.append(el("revisionNumber",String.valueOf(n.intValue())));
        } else {
            op="getRepositoryObject";
            b.append(el("resolveRef",String.valueOf(bool(req,"resolveRef",false))));
        }
        b.append(attrIds(req.get("attrIds"))).append(options(req.get("options")));
        SoapResponse r=invoke(op,b.toString(),sessionId,true);
        Element ret=findResponseValue(r.document(),op+"Return","result");
        if(ret==null) throw new AdapterException("ARCSUITE_NOT_AVAILABLE","Repository object not available");
        Map<String,Object> out=parseRepositoryObject(ret);
        if(bool(req,"includePath",false)) {
            String pathBody=el("id",id)+attrIds(List.of(Map.of("ns","rep","name","system:name")))+options(List.of());
            SoapResponse pr=invoke("getRepositoryObjectPath",pathBody,sessionId,true);
            Element pv=findResponseValue(pr.document(),"getRepositoryObjectPathReturn","result");
            if(pv!=null) applyPath(out,pv);
        }
        return out;
    }

    Map<String,Object> getMany(Map<String,Object> req, String sessionId) {
        String body=getRepositoryObjectsBody(req);
        SoapResponse r=invoke("getRepositoryObjects",body,sessionId,true);
        Element ret=findResponseValue(r.document(),"getRepositoryObjectsReturn","result");
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        out.put("objects",parseRepositoryObjects(ret));
        out.put("failures",parseFailures(ret));
        return out;
    }

    static String getRepositoryObjectsBody(Map<String,Object> req) {
        List<String> ids=strings(req.get("ids"));
        if(ids.isEmpty()) throw new IllegalArgumentException("ids are required");
        StringBuilder b=new StringBuilder();
        b.append(idsElement(ids));
        b.append(el("resolveRef",String.valueOf(bool(req,"resolveRef",false))));
        b.append(attrIds(req.get("attrIds")));
        b.append(options(req.get("options")));
        return b.toString();
    }

    List<Map<String,Object>> revisions(Map<String,Object> req,String sessionId) {
        String body=el("id",requiredString(req,"id"))+attrIds(req.get("attrIds"))+options(req.get("options"));
        SoapResponse r=invoke("listRepositoryObjectRevisions",body,sessionId,true);
        Element ret=findResponseValue(r.document(),"listRepositoryObjectRevisionsReturn","result");
        return parseRepositoryObjects(ret);
    }

    Map<String,Object> content(Map<String,Object> req,String sessionId) {
        String id=requiredString(req,"id");
        Number revision=req.get("revisionNumber") instanceof Number n?n:null;
        if(revision!=null) {
            Map<String,Object> getReq=new LinkedHashMap<>();
            getReq.put("id",id); getReq.put("revisionNumber",revision.longValue()); getReq.put("resolveRef",false); getReq.put("includePath",false);
            getReq.put("attrIds",List.of()); getReq.put("options",List.of());
            Map<String,Object> revisionObj=get(getReq,sessionId);
            Object rid=revisionObj.get("id"); if(rid instanceof String s && !s.isBlank()) id=s;
        }
        Map<String,Object> label=map(req.get("contentLabel"));
        StringBuilder b=new StringBuilder();
        b.append(el("id",id));
        b.append("<t:contentLabels><t:i18nString ns=\"").append(XmlUtil.esc(string(label,"ns","rep"))).append("\" name=\"")
                .append(XmlUtil.esc(string(label,"name","system:primary"))).append("\"/></t:contentLabels>");
        b.append(options(req.get("options")));
        SoapResponse r=invoke("getRepositoryObjectContentWithOptions",b.toString(),sessionId,true);
        Element c=findResponseValue(r.document(),"getRepositoryObjectContentWithOptionsReturn","result");
        if(c==null) throw new AdapterException("ARCSUITE_NOT_AVAILABLE","Content not available");
        String fileName=value(c,"fileName"); if(fileName==null||fileName.isBlank())fileName="document.bin";
        String contentType=value(c,"contentType"); if(contentType==null||contentType.isBlank())contentType="application/octet-stream";
        Element labelEl=XmlUtil.child(c,"label"); String labelName=labelEl==null?"system:primary":labelEl.getAttribute("name");
        byte[] bytes=resolveData(XmlUtil.child(c,"data"),r.attachments());
        if(bytes.length>config.maxContentBytes()) throw new AdapterException("ARCSUITE_LIMIT_EXCEEDED","Content exceeds configured maximum size");
        String traceId=requiredString(req,"traceId").replaceAll("[^A-Za-z0-9._-]","_");
        String safeName=fileName.replaceAll("[\\\\/\\r\\n\\0]","_");
        Path path=config.sharedTempDir().resolve(traceId+"-"+UUID.randomUUID()+"-"+safeName).normalize();
        if(!path.startsWith(config.sharedTempDir())) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Unsafe temp path");
        try { Files.write(path,bytes,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE); }
        catch(IOException e){ throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Failed to materialize content",false,null,e); }
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        out.put("id",requiredString(req,"id")); if(revision!=null)out.put("revisionNumber",revision.longValue()); out.put("label",labelName);
        out.put("fileName",fileName); out.put("contentType",contentType); out.put("sizeBytes",bytes.length); out.put("filePath",path.toString());
        return out;
    }

    Map<String,Object> validateSchema(Map<String,Object> req,String sessionId) {
        LinkedHashMap<String,Object> out=new LinkedHashMap<>(); List<String> errors=new ArrayList<>();
        VersionInfo vi=getVersionInfo(); out.put("version",Map.of("minVersion",nvl(vi.minVersion()),"curVersion",nvl(vi.curVersion())));
        String cabinetId=requiredString(req,"cabinetId");
        try {
            SoapResponse cr=invoke("getCabinetInformation",el("cabinetId",cabinetId),sessionId,true);
            Element ci=findResponseValue(cr.document(),"getCabinetInformationReturn","result");
            LinkedHashMap<String,Object> cm=new LinkedHashMap<>(); cm.put("id",value(ci,"id")); cm.put("label",value(ci,"label"));
            String recycle=value(ci,"hasRecycleBin"); if(recycle!=null)cm.put("hasRecycleBin",Boolean.parseBoolean(recycle)); out.put("cabinet",cm);
        } catch(AdapterException e){ errors.add("cabinet:"+e.code); out.put("cabinet",Map.of("id",cabinetId)); }
        List<Map<String,Object>> requested=maps(req.get("attributes"));
        List<Map<String,Object>> attrs=new ArrayList<>();
        if(!requested.isEmpty()) {
            StringBuilder b=new StringBuilder("<t:attrIds>"); for(Map<String,Object> a:requested)b.append(attrId(map(a.get("attrId")))); b.append("</t:attrIds>");
            try {
                SoapResponse ar=invoke("getAttributeSchemas",b.toString(),sessionId,true);
                Element ret=findResponseValue(ar.document(),"result","getAttributeSchemasReturn");
                Element results=ret==null?null:XmlUtil.child(ret,"results");
                if(results!=null) for(Element schema:XmlUtil.children(results,"attributeSchema")) attrs.add(parseAttributeSchema(schema));
            } catch(AdapterException e){ errors.add("attributes:"+e.code); }
        }
        Map<String,Map<String,Object>> byKey=new HashMap<>(); for(Map<String,Object> a:attrs)byKey.put(a.get("ns")+":"+a.get("name"),a);
        for(Map<String,Object> r:requested){ Map<String,Object> aid=map(r.get("attrId")); String key=string(aid,"ns","")+":"+requiredString(aid,"name"); Map<String,Object> a=byKey.get(key);
            if(a==null){errors.add("missing_attribute:"+key);continue;}
            if(bool(r,"requireSearchable",false)&&!Boolean.TRUE.equals(a.get("searchable")))errors.add("not_searchable:"+key);
            if(bool(r,"requireSortable",false)&&!Boolean.TRUE.equals(a.get("sortable")))errors.add("not_sortable:"+key);
        }
        out.put("attributes",attrs); out.put("errors",errors); out.put("ok",errors.isEmpty()); return out;
    }

    private String searchBody(Map<String,Object> req, boolean includeAttrs) {
        StringBuilder b = new StringBuilder();
        List<Map<String,Object>> conditions = maps(req.get("attributeConditions"));
        if (!conditions.isEmpty()) b.append(attributeConditions("attrCondition", conditions));
        Map<String,Object> text = mapOrNull(req.get("text"));
        if (text != null && !strings(text.get("words")).isEmpty()) b.append(textCondition(text));
        b.append(el("mode", string(req,"mode","AND")));
        b.append("<t:option>");
        List<String> regionIds = strings(req.get("searchRegionIds"));
        if (!regionIds.isEmpty()) {
            b.append("<t:searchRegion>");
            for (String id:regionIds) b.append(el("id",id));
            b.append(el("depth", String.valueOf(integer(req,"depth",0))));
            b.append("</t:searchRegion>");
        }
        b.append(el("textSearchMode", string(req,"textSearchMode","NONE")));
        b.append("</t:option>");
        b.append(sortCondition(req.get("order")));
        b.append(el("limit", String.valueOf(integer(req,"limit",20))));
        if(includeAttrs) b.append(attrIds(req.get("attrIds")));
        b.append(options(req.get("options")));
        return b.toString();
    }

    private SoapResponse invoke(String operation,String innerXml,String sessionId,boolean sessionAware) {
        if (!READ_ONLY_OPERATIONS.contains(operation)) throw new AdapterException("ARCSUITE_FORBIDDEN", "SOAP operation is not in the read-only allowlist");
        String header="";
        if(sessionId!=null&&!sessionId.isBlank()) {
            header="<soap:Header><t:Session locale=\""+XmlUtil.esc(config.locale())+"\" attachmentType=\"mtom\" requestVersion=\""+XmlUtil.esc(config.requestVersion())+"\" administratorMode=\"false\">"+XmlUtil.esc(sessionId)+"</t:Session></soap:Header>";
        }
        String xml="<?xml version=\"1.0\" encoding=\"UTF-8\"?>"+
                "<soap:Envelope xmlns:soap=\""+SOAP_NS+"\" xmlns:t=\""+TYPES_NS+"\" xmlns:xsi=\""+XSI_NS+"\">"+header+
                "<soap:Body><t:"+operation+">"+innerXml+"</t:"+operation+"></soap:Body></soap:Envelope>";
        HttpRequest request=HttpRequest.newBuilder(URI.create(config.endpoint()))
                .timeout(config.requestTimeout()).header("Content-Type","text/xml; charset=utf-8").header("SOAPAction","\"\"")
                .header("Accept","multipart/related, application/xop+xml, text/xml, application/soap+xml")
                .POST(HttpRequest.BodyPublishers.ofString(xml,StandardCharsets.UTF_8)).build();
        HttpResponse<InputStream> response;
        try { response=http.send(request,HttpResponse.BodyHandlers.ofInputStream()); }
        catch(java.net.http.HttpTimeoutException e){throw new AdapterException("ARCSUITE_TIMEOUT","ArcSuite request timed out",true,null,e);}
        catch(IOException|InterruptedException e){ if(e instanceof InterruptedException)Thread.currentThread().interrupt(); throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","ArcSuite transport failure",false,null,e); }
        long maxEnvelopeBytes = Math.addExact(config.maxContentBytes(), 16L * 1024 * 1024);
        byte[] responseBody;
        try (InputStream body = response.body()) {
            long declared = response.headers().firstValueAsLong("content-length").orElse(-1L);
            if (declared > maxEnvelopeBytes) throw new AdapterException("ARCSUITE_LIMIT_EXCEEDED", "SOAP/MTOM response exceeds configured maximum size");
            responseBody = readBounded(body, maxEnvelopeBytes);
        } catch (IOException e) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response could not be read", false, null, e);
        }
        String ct=response.headers().firstValue("content-type").orElse("text/xml");
        MtomMessage mtom=MtomParser.parse(ct,responseBody); Document doc=XmlUtil.parse(mtom.rootXml());
        AdapterException fault=parseFault(doc,response.statusCode()); if(fault!=null)throw fault;
        if(response.statusCode()<200||response.statusCode()>=300)throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","ArcSuite HTTP status "+response.statusCode(),response.statusCode()>=500,null);
        return new SoapResponse(doc,mtom.attachments());
    }

    static byte[] readBounded(InputStream input, long maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(maxBytes, 64 * 1024));
        byte[] buffer = new byte[8192];
        long total = 0;
        int n;
        while ((n = input.read(buffer)) != -1) {
            total += n;
            if (total > maxBytes) throw new AdapterException("ARCSUITE_LIMIT_EXCEEDED", "SOAP/MTOM response exceeds configured maximum size");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    private AdapterException parseFault(Document doc,int httpStatus) {
        Element fault=XmlUtil.firstDesc(doc.getDocumentElement(),"Fault"); if(fault==null)return null;
        String faultString=value(fault,"faultstring"); if(faultString==null)faultString=fault.getTextContent();
        String code=findArcSuiteCode(faultString); Element detail=XmlUtil.child(fault,"detail"); if(code==null&&detail!=null)code=findArcSuiteCode(detail.getTextContent());
        String stable=stableCode(code); boolean retry="ARCSUITE_SESSION_EXPIRED".equals(stable);
        return new AdapterException(stable,stable,retry,code);
    }

    private static String stableCode(String code) {
        if(code==null)return "ARCSUITE_UPSTREAM_ERROR";
        if(code.contains("08302001")||code.contains("08303101"))return "ARCSUITE_SESSION_EXPIRED";
        if(code.contains("08305028"))return "ARCSUITE_NOT_AVAILABLE";
        if(code.contains("08305005")||code.contains("08305010")||code.contains("08305016")||code.contains("08305017")||code.contains("08305018")||code.contains("08302005"))return "ARCSUITE_INVALID_ARGUMENT";
        if(code.contains("08303102")||code.contains("08303202"))return "ARCSUITE_FORBIDDEN";
        return "ARCSUITE_UPSTREAM_ERROR";
    }

    private static String findArcSuiteCode(String s){ if(s==null)return null; java.util.regex.Matcher m=java.util.regex.Pattern.compile("(?:ARCSUITE_WS|DREP_[A-Z]+|RMS_WEBSVC|COLLABO|AWF_[A-Z]+)-?[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?").matcher(s); return m.find()?m.group():null; }

    private static Element findResponseValue(Document doc,String...names){ Element root=doc.getDocumentElement(); for(String n:names){Element e=XmlUtil.firstDesc(root,n);if(e!=null)return e;} return null; }
    private static String value(Element e,String name){ return e==null?null:XmlUtil.childText(e,name); }
    private static String nvl(String s){return s==null?"":s;}

    private static String keyed(String key,String value){return "<t:preferences key=\""+XmlUtil.esc(key)+"\">"+XmlUtil.esc(value)+"</t:preferences>";}
    private static String el(String name,String value){return "<t:"+name+">"+XmlUtil.esc(value)+"</t:"+name+">";}
    private static String idsElement(List<String> values){StringBuilder b=new StringBuilder("<t:ids>");for(String value:values)b.append(el("id",value));return b.append("</t:ids>").toString();}
    private static String attrId(Map<String,Object> id){String ns=string(id,"ns","");String name=requiredString(id,"name"); return "<t:attributeId"+(ns.isBlank()?"":" ns=\""+XmlUtil.esc(ns)+"\"")+" name=\""+XmlUtil.esc(name)+"\"/>";}
    private static String attrIds(Object o){List<Map<String,Object>> ids=maps(o);if(ids.isEmpty())return "<t:attrIds/>";StringBuilder b=new StringBuilder("<t:attrIds>");for(Map<String,Object> id:ids)b.append(attrId(id));return b.append("</t:attrIds>").toString();}
    private static String options(Object o){StringBuilder b=new StringBuilder();for(String x:strings(o))b.append(el("options",x));return b.toString();}
    private static String sortCondition(Object o){List<Map<String,Object>> order=maps(o);if(order.isEmpty())return "";StringBuilder b=new StringBuilder("<t:order>");for(Map<String,Object>x:order){b.append("<t:sortItem isDescending=\"").append(bool(x,"descending",false)).append("\">").append(attrId(map(x.get("attrId")))).append("</t:sortItem>");}return b.append("</t:order>").toString();}

    private static String attributeConditions(String elementName,List<Map<String,Object>> cs){ if(cs.size()==1)return singleCondition(elementName,cs.get(0)); StringBuilder b=new StringBuilder("<t:").append(elementName).append(" xsi:type=\"t:AndCondition\">"); for(Map<String,Object> c:cs)b.append(singleCondition("attributeSearchCondition",c)); return b.append("</t:").append(elementName).append('>').toString(); }
    private static String singleCondition(String elementName,Map<String,Object> c){Map<String,Object> aid=map(c.get("attrId"));Map<String,Object> val=map(c.get("value"));String type=string(val,"type","string");String child="datetime".equals(type)?"dateTime":"string";String xsi="datetime".equals(type)?"DateTimeValue":"StringValue";
        return "<t:"+elementName+" xsi:type=\"t:BinaryOperatorCondition\" operator=\""+XmlUtil.esc(requiredString(c,"operator"))+"\">"+attrId(aid)+"<t:attributeValue xsi:type=\"t:"+xsi+"\">"+el(child,requiredString(val,"value"))+"</t:attributeValue></t:"+elementName+">"; }
    private static String textCondition(Map<String,Object> text){StringBuilder b=new StringBuilder("<t:textCondition xsi:type=\"t:TextCondition\"><t:wordList operator=\"").append(XmlUtil.esc(string(text,"operator","AND"))).append("\">");for(String w:strings(text.get("words")))b.append(el("word",w));return b.append("</t:wordList></t:textCondition>").toString();}

    private static List<String> parseStringArray(Element container){
        if(container==null)return List.of();
        LinkedHashSet<String> values=new LinkedHashSet<>();
        for(String name:List.of("string","item","ids","id"))for(Element e:XmlUtil.descendants(container,name)){String text=e.getTextContent();if(text!=null&&!text.isBlank()&&text.trim().startsWith("rep:"))values.add(text.trim());}
        String direct=container.getTextContent();if(values.isEmpty()&&direct!=null&&direct.trim().startsWith("rep:"))values.add(direct.trim());
        return new ArrayList<>(values);
    }

    private static List<Map<String,Object>> parseRepositoryObjects(Element container){ List<Map<String,Object>> out=new ArrayList<>(); if(container==null)return out; List<Element> els=XmlUtil.descendants(container,"repositoryObject"); if(els.isEmpty()&&"repositoryObject".equals(container.getLocalName()))els=List.of(container); for(Element e:els)out.add(parseRepositoryObject(e)); return out; }
    private static Map<String,Object> parseRepositoryObject(Element e){LinkedHashMap<String,Object> out=new LinkedHashMap<>();String id=value(e,"id");if(id==null&&"repositoryObject".equals(e.getLocalName()))id=XmlUtil.childText(e,"id");out.put("id",id==null?"":id);
        Element oc=XmlUtil.child(e,"objectClass");String ocName=oc==null?"":oc.getAttribute("name");out.put("objectClass",ocName==null||ocName.isBlank()?"unknown":ocName);
        LinkedHashMap<String,Object> attrs=new LinkedHashMap<>();Element aroot=XmlUtil.child(e,"attributes");if(aroot!=null){for(Element a:XmlUtil.children(aroot,"attribute")){String ns=a.getAttribute("ns"),name=a.getAttribute("name");Element av=XmlUtil.child(a,"attributeValue");if(av!=null)attrs.put(ns+":"+name,parseAttributeValue(av));}}out.put("attributes",attrs);return out;}
    private static Object parseAttributeValue(Element av){String t=XmlUtil.localType(av);LinkedHashMap<String,Object> o=new LinkedHashMap<>();
        try { switch(t){case "StringValue"-> {o.put("type","string");o.put("value",value(av,"string"));} case "IntValue"->{o.put("type","int");o.put("value",Integer.parseInt(value(av,"int")));} case "LongValue"->{o.put("type","long");o.put("value",Long.parseLong(value(av,"long")));} case "DoubleValue"->{o.put("type","double");o.put("value",Double.parseDouble(value(av,"double")));} case "BooleanValue"->{o.put("type","boolean");o.put("value",Boolean.parseBoolean(value(av,"boolean")));} case "DateTimeValue"->{o.put("type","datetime");o.put("value",value(av,"dateTime"));} case "IdValue"->{o.put("type","id");o.put("value",value(av,"id"));} case "I18nStringValue"->{Element i=XmlUtil.child(av,"i18nString");o.put("type","i18n"); if(i!=null){o.put("ns",i.getAttribute("ns"));o.put("name",i.getAttribute("name"));String l=i18nLabel(i);if(l!=null)o.put("label",l);}} case "I18nStringValues"->{o.put("type","i18n[]");List<Object> vs=new ArrayList<>();for(Element i:XmlUtil.children(av,"i18nStrings")){LinkedHashMap<String,Object>x=new LinkedHashMap<>();x.put("ns",i.getAttribute("ns"));x.put("name",i.getAttribute("name"));String l=i18nLabel(i);if(l!=null)x.put("label",l);vs.add(x);}o.put("values",vs);} case "RmsObjectValueRmsObject"->{o.put("type","rmsObject");Element r=XmlUtil.firstDesc(av,"rmsObject");if(r!=null){String dn=value(r,"dn");if(dn!=null)o.put("dn",dn);Element oc=XmlUtil.child(r,"objectClass");String l=oc==null?null:i18nLabel(oc);if(l!=null)o.put("label",l);}} default->{o.put("type","unknown");o.put("rawType",t.isBlank()?"unknown":t);String text=av.getTextContent();if(text!=null&&!text.isBlank())o.put("value",text.trim());} } }
        catch(Exception ex){o.clear();o.put("type","unknown");o.put("rawType",t.isBlank()?"unknown":t);}return o;}
    private static String i18nLabel(Element i){for(Element l:XmlUtil.children(i,"label")){String lang=l.getAttribute("lang");if("ja".equalsIgnoreCase(lang))return l.getTextContent();}Element l=XmlUtil.child(i,"label");return l==null?null:l.getTextContent();}

    private static List<Map<String,Object>> parseFailures(Element container){
        List<Map<String,Object>> out=new ArrayList<>();if(container==null)return out;
        for(Element failure:XmlUtil.descendants(container,"failure")){
            LinkedHashMap<String,Object> item=new LinkedHashMap<>();String index=value(failure,"index");
            try{item.put("index",Integer.parseInt(index));}catch(Exception ignored){continue;}
            Element exception=XmlUtil.child(failure,"exception");String upstream=exception==null?findArcSuiteCode(failure.getTextContent()):findArcSuiteCode(exception.getTextContent());
            item.put("code",stableCode(upstream));if(upstream!=null)item.put("upstreamCode",upstream);out.add(item);
        }
        return out;
    }

    @SuppressWarnings("unchecked") private static void applyPath(Map<String,Object> out,Element p){Element objs=XmlUtil.child(p,"objects");List<Object> path=new ArrayList<>();if(objs!=null)for(Element ro:XmlUtil.children(objs,"repositoryObject")){Map<String,Object> parsed=parseRepositoryObject(ro);Map<String,Object> attrs=(Map<String,Object>)parsed.get("attributes");Object nv=attrs.get("rep:system:name");String name=null;if(nv instanceof Map<?,?> vm&&vm.get("value")!=null)name=String.valueOf(vm.get("value"));LinkedHashMap<String,Object>x=new LinkedHashMap<>();x.put("id",parsed.get("id"));if(name!=null)x.put("name",name);x.put("objectClass",parsed.get("objectClass"));path.add(x);}out.put("pathObjects",path);String f=value(p,"fullPath");if(f!=null)out.put("fullPath",Boolean.parseBoolean(f));}
    private static Map<String,Object> parseAttributeSchema(Element s){LinkedHashMap<String,Object> o=new LinkedHashMap<>();for(String k:List.of("ns","name","dataType")){String v=value(s,k);if(v!=null)o.put(k,v);}for(String k:List.of("searchable","sortable","modifiable")){String v=value(s,k);if(v!=null)o.put(k,Boolean.parseBoolean(v));}return o;}
    private static byte[] resolveData(Element data,Map<String,byte[]> attachments){if(data==null)return new byte[0];Element include=XmlUtil.firstDesc(data,"Include");if(include!=null){String href=include.getAttribute("href");String cid=MtomParser.normalizeCid(href);byte[] a=attachments.get(cid);if(a==null)throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","MTOM attachment referenced but missing");return a;}String text=data.getTextContent();if(text==null||text.isBlank())return new byte[0];try{return Base64.getMimeDecoder().decode(text);}catch(IllegalArgumentException e){throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Invalid base64 content",false,null,e);}}

    @SuppressWarnings("unchecked") private static Map<String,Object> map(Object o){ if(!(o instanceof Map<?,?>m))throw new IllegalArgumentException("object required");return (Map<String,Object>)m; }
    @SuppressWarnings("unchecked") private static Map<String,Object> mapOrNull(Object o){ return o instanceof Map<?,?>m?(Map<String,Object>)m:null; }
    @SuppressWarnings("unchecked") private static List<Map<String,Object>> maps(Object o){ if(!(o instanceof List<?>l))return List.of();List<Map<String,Object>>r=new ArrayList<>();for(Object x:l)if(x instanceof Map<?,?>m)r.add((Map<String,Object>)m);return r; }
    private static List<String> strings(Object o){ if(!(o instanceof List<?>l))return List.of();List<String>r=new ArrayList<>();for(Object x:l)if(x!=null)r.add(String.valueOf(x));return r; }
    private static String requiredString(Map<String,Object>m,String k){Object v=m.get(k);if(v==null||String.valueOf(v).isBlank())throw new IllegalArgumentException(k+" is required");return String.valueOf(v);}
    private static String string(Map<String,Object>m,String k,String d){Object v=m.get(k);return v==null?d:String.valueOf(v);}
    private static int integer(Map<String,Object>m,String k,int d){Object v=m.get(k);return v instanceof Number n?n.intValue():v==null?d:Integer.parseInt(String.valueOf(v));}
    private static boolean bool(Map<String,Object>m,String k,boolean d){Object v=m.get(k);return v instanceof Boolean b?b:v==null?d:Boolean.parseBoolean(String.valueOf(v));}
}
