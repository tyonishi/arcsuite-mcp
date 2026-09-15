package biz.capricornus.arcsuite.mcp.adapter;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

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
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
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
    static final String XOP_NS = "http://www.w3.org/2004/08/xop/include";
    static final String XSI_NS = XMLConstants.W3C_XML_SCHEMA_INSTANCE_NS_URI;
    static final String OBJECT_CLASS_NS = "rep";
    private static final Map<String,String> SEMANTIC_OBJECT_CLASSES = Map.of(
            "rep:system:cabinet", "cabinet",
            "rep:system:drawer", "drawer",
            "rep:system:folder", "folder",
            "rep:system:document", "document",
            "rep:system:externalDocument", "externalDocument",
            "rep:system:dynamicExternalDocument", "dynamicExternalDocument",
            "rep:system:reference", "reference",
            "rep:system:hardReference", "hardReference"
    );
    static final String ENCRYPTED_PASSWORD_URI = BASE_NS + "#EncryptedPassword";
    private static final Set<String> SEARCH_BINARY_OPERATORS = Set.of("EQUAL", "LIKE", "GREATER_EQUAL", "LESS_EQUAL");
    private static final Set<String> SEARCH_TEXT_MODES = Set.of("NONE", "STEMMING", "THESAURUS");
    static final int HARD_REFERENCE_MAX_CANDIDATES = 1000;
    static final int MAX_INTEGRITY_CERTIFICATES = 64;
    static final int MAX_CERTIFICATE_EVIDENCE_ENTRIES = 64;
    static final int MIN_REVISION_NUMBER = 1;
    static final int MAX_REVISION_NUMBER = Integer.MAX_VALUE;
    static final Set<String> READ_ONLY_OPERATIONS = Set.of(
            "getVersionInfo", "getLoginInfo", "login", "logout", "getSessionInfo",
            "getAttributeSchema", "getAttributeSchemas", "getRepositoryObject",
            "getRepositoryObjects", "getRepositoryObjectByRevisionNumber",
            "getRepositoryObjectPath", "getRepositoryObjectPaths", "getRepositoryObjectContent",
            "getRepositoryObjectContentWithOptions", "listRepositoryObjects", "listRepositoryObjectIds",
            "searchRepositoryObjects", "searchRepositoryObjectIds", "listRepositoryObjectRevisions", "listRepositoryObjectHardReferences", "listRepositoryServices",
            "getCabinetInformation", "getCabinetInformations", "getRepositoryObjectClassDefinitions",
            "validateCertificate", "getCertificateEvidence"
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
        Element result = requiredOperationResult(r.document(), "getVersionInfoResponse");
        return new VersionInfo(value(result, "minVersion"), value(result, "curVersion"));
    }

    LoginInfo getLoginInfo() {
        SoapResponse r = invoke("getLoginInfo", "", null, false);
        Element result = requiredOperationResult(r.document(), "getLoginInfoResponse");
        return new LoginInfo(value(result,"sessionId"), value(result,"challenge"), value(result,"publicKeyModulus"), value(result,"publicKeyExponent"), value(result,"minVersion"), value(result,"curVersion"));
    }

    String login(String userId, String encryptedCredential, String sessionId, String requestVersion) {
        String body = el("userId", userId) + el("credentialType", ENCRYPTED_PASSWORD_URI) + el("credential", encryptedCredential)
                + keyed("requestVersion", requestVersion)
                + keyed("attachmentType", "mtom")
                + keyed("locale", config.locale());
        SoapResponse r = invoke("login", body, sessionId, true);
        return requiredOperationResult(r.document(), "loginResponse").getTextContent();
    }

    void logout(String sessionId) { invoke("logout", "", sessionId, true); }

    Map<String,Object> getSessionInfo(String sessionId) {
        SoapResponse r = invoke("getSessionInfo", "", sessionId, true);
        Element result = requiredOperationResult(r.document(), "getSessionInfoResponse");
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
        Element ret=requiredOperationReturn(r.document(), "searchRepositoryObjectsResponse", "searchRepositoryObjectsReturn");
        return parseRepositoryObjects(ret);
    }

    List<String> searchIds(Map<String,Object> req, String sessionId) {
        SoapResponse r=invoke("searchRepositoryObjectIds",searchBody(req,false),sessionId,true);
        return parseOperationIdArray(r.document(), "searchRepositoryObjectIds");
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
        Element ret=requiredOperationReturn(r.document(), "listRepositoryObjectsResponse", "listRepositoryObjectsReturn");
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
        return parseOperationIdArray(r.document(), "listRepositoryObjectIds");
    }

    Map<String,Object> get(Map<String,Object> req, String sessionId) {
        String id=requiredString(req,"id");
        Object rev=req.get("revisionNumber");
        String op;
        String returnName;
        boolean resolveRef = rev == null && bool(req,"resolveRef",false);
        StringBuilder b=new StringBuilder();
        b.append(el("id",id));
        if (rev != null) {
            op="getRepositoryObjectByRevisionNumber";
            returnName="getRepositoryDocumentByRevisionNubmerReturn";
            b.append(el("revisionNumber",String.valueOf(revisionNumber(rev))));
        } else {
            op="getRepositoryObject";
            returnName="getRepositoryObjectReturn";
            b.append(el("resolveRef",String.valueOf(resolveRef)));
        }
        b.append(attrIds(req.get("attrIds"))).append(options(req.get("options")));
        SoapResponse r=invoke(op,b.toString(),sessionId,true);
        Element ret=requiredOperationReturn(r.document(), op+"Response", returnName);
        Map<String,Object> out=parseRepositoryObject(ret);
        Object rawEffectiveId=out.get("id");
        if(!(rawEffectiveId instanceof String effectiveId)||!isRepositoryObjectId(effectiveId)) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Repository object identity was missing or malformed");
        }
        if (rev != null) {
            int requestedRevision = revisionNumber(rev);
            if (!revisionMetadataIdentityMatches(id, effectiveId, requestedRevision)
                    || !revisionAttributeMatchesIfPresent(out, requestedRevision)) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Revision object identity did not match the requested base identity");
            }
            out.put("effectiveId", id);
            out.put("revisionNumber", requestedRevision);
        } else if(!resolveRef&&!id.equals(effectiveId)) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Repository object identity did not match the request");
        }
        if(bool(req,"includePath",false)) {
            String pathBody=el("id",rev == null ? effectiveId : id)+attrIds(List.of(Map.of("ns","rep","name","system:name")))+options(List.of());
            SoapResponse pr=invoke("getRepositoryObjectPath",pathBody,sessionId,true);
            Element pv=requiredOperationReturn(pr.document(), "getRepositoryObjectPathResponse", "getRepositoryObjectPathReturn");
            applyPath(out,pv);
        }
        return out;
    }

    Map<String,Object> getMany(Map<String,Object> req, String sessionId) {
        String body=getRepositoryObjectsBody(req);
        SoapResponse r=invoke("getRepositoryObjects",body,sessionId,true);
        Element ret=requiredOperationReturn(r.document(), "getRepositoryObjectsResponse", "getRepositoryObjectsReturn");
        List<Element> fields=elementChildren(ret);
        if(fields.size()!=2||!types(fields.get(0),"results")||!types(fields.get(1),"failures")) throw responseShapeFailure();
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        out.put("objects",parseRepositoryObjects(fields.get(0)));
        out.put("failures",parseFailures(fields.get(1)));
        return out;
    }

    Map<String,Object> hardReferences(Map<String,Object> req, String sessionId) {
        String targetId=requiredRepositoryObjectId(requiredString(req,"id"),"id");
        int maxResults=hardReferenceMaxResults(req.get("maxResults"));
        SoapResponse r=invoke("listRepositoryObjectHardReferences",hardReferencesBody(req),sessionId,true);
        Element ret=requiredOperationReturn(r.document(), "listRepositoryObjectHardReferencesResponse", "listRepositoryObjectHardReferencesReturn");
        return Map.of("ids",parseHardReferenceIds(ret,targetId,maxResults));
    }

    Map<String,Object> validateIntegrity(Map<String,Object> req, String sessionId) {
        String targetId = requiredRepositoryObjectId(requiredString(req, "id"), "id");
        SoapResponse response = invoke("validateCertificate", validateCertificateBody(targetId), sessionId, true);
        return parseIntegrityValidation(response.document());
    }

    Map<String,Object> certificateEvidence(Map<String,Object> req, String sessionId) {
        String targetId = requiredRepositoryObjectId(requiredString(req, "id"), "id");
        SoapResponse response = invoke("getCertificateEvidence", certificateEvidenceBody(targetId), sessionId, true);
        return parseCertificateEvidence(response.document());
    }

    static String validateCertificateBody(String targetId) {
        return idsElement(List.of(requiredRepositoryObjectId(targetId, "id")));
    }

    static String certificateEvidenceBody(String targetId) {
        return el("id", requiredRepositoryObjectId(targetId, "id"));
    }

    static Map<String,Object> parseIntegrityValidation(Document document) {
        Element response = requiredOperationReturn(document, "validateCertificateResponse", "validateCertificateReturn");
        List<Element> containers = typesChildren(response, "results");
        List<Element> failuresContainers = typesChildren(response, "failures");
        if (containers.size() != 1 || failuresContainers.size() != 1) throw integrityShapeFailure();
        List<Element> responseChildren = elementChildren(response);
        if (responseChildren.size() != 2 || responseChildren.get(0) != containers.get(0)
                || responseChildren.get(1) != failuresContainers.get(0)) throw integrityShapeFailure();

        List<Element> resultEntries = boundedNamedChildren(containers.get(0), "results", 2, "ARCSUITE_UPSTREAM_ERROR");
        List<Element> failureEntries = boundedNamedChildren(failuresContainers.get(0), "failure", 2, "ARCSUITE_UPSTREAM_ERROR");
        if (resultEntries.size() > 1 || failureEntries.size() > 1) throw integrityShapeFailure();

        boolean hasResult = resultEntries.size() == 1;
        boolean hasFailure = failureEntries.size() == 1;
        if (hasResult == hasFailure) throw integrityShapeFailure();

        LinkedHashMap<String,Object> out = new LinkedHashMap<>();
        if (hasFailure) {
            Element failure = failureEntries.get(0);
            Element indexElement = requiredSingleChild(failure, "index");
            Element exception = requiredSingleChild(failure, "exception");
            List<Element> failureChildren = elementChildren(failure);
            if (failureChildren.size() != 2 || failureChildren.get(0) != indexElement || failureChildren.get(1) != exception) {
                throw integrityShapeFailure();
            }
            int index = parseIntegrityInteger(indexElement.getTextContent());
            if (index != 0) throw integrityShapeFailure();
            out.put("certificates", List.of());
            out.put("failure", "per_id");
            return out;
        }

        out.put("certificates", parseIntegrityElements(resultEntries.get(0)));
        out.put("failure", null);
        return out;
    }

    static Map<String,Object> parseCertificateEvidence(Document document) {
        Element response = requiredOperationReturn(document, "getCertificateEvidenceResponse", "getCertificateEvidenceReturn");
        List<Integer> ids = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (Element evidence : boundedNamedChildren(response, "certEvidence", MAX_CERTIFICATE_EVIDENCE_ENTRIES, "ARCSUITE_LIMIT_EXCEEDED")) {
            Element certIdElement = requiredSingleChild(evidence, "certId");
            Element attributesElement = requiredSingleChild(evidence, "certAttributes");
            List<Element> evidenceChildren = elementChildren(evidence);
            if (evidenceChildren.size() != 2 || evidenceChildren.get(0) != certIdElement
                    || evidenceChildren.get(1) != attributesElement) throw integrityShapeFailure();
            int certId = parseIntegrityInteger(certIdElement.getTextContent());
            if (!seen.add(certId)) throw integrityShapeFailure();
            ids.add(certId);
        }
        return Map.of("certIds", List.copyOf(ids));
    }

    private static List<Map<String,Object>> parseIntegrityElements(Element resultEntry) {
        Element elementsContainer = requiredSingleChild(resultEntry, "certValidElements");
        List<Element> recordChildren = elementChildren(resultEntry);
        if (recordChildren.size() != 1 || recordChildren.get(0) != elementsContainer) throw integrityShapeFailure();

        List<Element> validationElements = boundedNamedChildren(
                elementsContainer, "results", MAX_INTEGRITY_CERTIFICATES, "ARCSUITE_LIMIT_EXCEEDED");
        List<Map<String,Object>> certificates = new ArrayList<>(validationElements.size());
        for (Element element : validationElements) {
            List<Element> elementFields = elementChildren(element);
            String type = XmlUtil.qualifiedType(element, TYPES_NS);
            List<String> fieldOrder = integrityFieldOrder(type, elementFields);
            if (fieldOrder == null) throw integrityShapeFailure();
            Element certIdElement = elementFields.get(0);
            Element resultElement = elementFields.get(1);
            Element exceptionElement = null;
            for (int i = 0; i < fieldOrder.size(); i++) {
                if ("exception".equals(fieldOrder.get(i))) exceptionElement = elementFields.get(i);
            }
            int certId = parseIntegrityInteger(certIdElement.getTextContent());
            boolean result = parseBooleanLexical(resultElement.getTextContent().trim());
            LinkedHashMap<String,Object> certificate = new LinkedHashMap<>();
            certificate.put("certId", certId);
            certificate.put("result", result);
            certificate.put("exceptionPresent", exceptionElement != null);
            certificates.add(certificate);
        }
        return List.copyOf(certificates);
    }

    private static List<String> integrityFieldOrder(String type, List<Element> actual) {
        List<List<String>> candidates = switch (type) {
            case "XAdESValidateResult" -> List.of(
                    List.of("certId", "result", "signer"),
                    List.of("certId", "result", "signer", "timestampDate"),
                    List.of("certId", "result", "exception", "signer"),
                    List.of("certId", "result", "exception", "signer", "timestampDate"));
            case "PAdESValidateResult", "DocumentTimestampValidateResult" -> List.of(
                    List.of("certId", "result", "timestampDate"),
                    List.of("certId", "result", "exception", "timestampDate"));
            default -> List.of();
        };
        for (List<String> candidate : candidates) {
            if (candidate.size() != actual.size()) continue;
            boolean matches = true;
            for (int i = 0; i < candidate.size(); i++) {
                if (!types(actual.get(i), candidate.get(i))) {
                    matches = false;
                    break;
                }
            }
            if (matches) return candidate;
        }
        return null;
    }

    private static Element requiredOperationReturn(Document document, String responseName, String returnName) {
        if (document == null || document.getDocumentElement() == null
                || !XmlUtil.is(document.getDocumentElement(), SOAP_NS, "Envelope")) throw integrityShapeFailure();
        Element body = XmlUtil.child(document.getDocumentElement(), SOAP_NS, "Body");
        if (body == null) throw integrityShapeFailure();
        List<Element> bodyChildren = elementChildren(body);
        if (bodyChildren.size() != 1 || !XmlUtil.is(bodyChildren.get(0), TYPES_NS, responseName)) throw integrityShapeFailure();
        Element operationResponse = bodyChildren.get(0);
        Element result = XmlUtil.child(operationResponse, TYPES_NS, returnName);
        if (result == null) throw integrityShapeFailure();
        List<Element> responseChildren = elementChildren(operationResponse);
        if (responseChildren.size() != 1 || responseChildren.get(0) != result) throw integrityShapeFailure();
        return result;
    }

    private static Element optionalOperationReturn(Document document, String responseName, String returnName) {
        if (document == null || document.getDocumentElement() == null
                || !XmlUtil.is(document.getDocumentElement(), SOAP_NS, "Envelope")) throw integrityShapeFailure();
        Element body = XmlUtil.child(document.getDocumentElement(), SOAP_NS, "Body");
        if (body == null) throw integrityShapeFailure();
        List<Element> bodyChildren = elementChildren(body);
        if (bodyChildren.size() != 1 || !XmlUtil.is(bodyChildren.get(0), TYPES_NS, responseName)) throw integrityShapeFailure();
        Element operationResponse = bodyChildren.get(0);
        List<Element> responseChildren = elementChildren(operationResponse);
        if (responseChildren.isEmpty()) return null;
        if (responseChildren.size() != 1 || !XmlUtil.is(responseChildren.get(0), TYPES_NS, returnName)) throw integrityShapeFailure();
        return responseChildren.get(0);
    }

    private static Element requiredSingleChild(Element parent, String name) {
        Element found = null;
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element child) || !XmlUtil.is(child, TYPES_NS, name)) continue;
            if (found != null) throw integrityShapeFailure();
            found = child;
        }
        if (found == null) throw integrityShapeFailure();
        return found;
    }

    private static List<Element> elementChildren(Element parent) {
        List<Element> children = new ArrayList<>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element child) children.add(child);
        }
        return children;
    }

    private static boolean types(Element element, String localName) { return XmlUtil.is(element, TYPES_NS, localName); }
    private static List<Element> typesChildren(Element parent, String localName) { return XmlUtil.children(parent, TYPES_NS, localName); }
    private static Element typesChild(Element parent, String localName) { return XmlUtil.child(parent, TYPES_NS, localName); }

    private static List<Element> boundedNamedChildren(Element parent, String name, int max, String overflowCode) {
        List<Element> children = new ArrayList<>(Math.min(max, 16));
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element child)) continue;
            if (!types(child, name)) throw integrityShapeFailure();
            if (children.size() == max) {
                throw new AdapterException(overflowCode, overflowCode.equals("ARCSUITE_LIMIT_EXCEEDED")
                        ? "Integrity result exceeds configured maximum" : "Integrity response accounting mismatch");
            }
            children.add(child);
        }
        return children;
    }

    private static int parseIntegrityInteger(String raw) {
        try { return Integer.parseInt(raw.trim()); }
        catch (Exception e) { throw integrityShapeFailure(); }
    }

    private static AdapterException integrityShapeFailure() {
        return new AdapterException("ARCSUITE_UPSTREAM_ERROR", "Integrity response shape or accounting mismatch");
    }

    static String hardReferencesBody(Map<String,Object> req) {
        String targetId=requiredRepositoryObjectId(requiredString(req,"id"),"id");
        hardReferenceMaxResults(req.get("maxResults"));
        return el("id",targetId)+attrIds(List.of())+options(List.of("referenceId"));
    }

    static int hardReferenceMaxResults(Object raw) {
        if(!(raw instanceof Number number))throw new IllegalArgumentException("maxResults is required");
        double value=number.doubleValue();
        if(!Double.isFinite(value)||value!=Math.rint(value)||value<1||value>HARD_REFERENCE_MAX_CANDIDATES) {
            throw new IllegalArgumentException("maxResults is outside the repository safety bound");
        }
        return (int)value;
    }

    static String requiredRepositoryObjectId(String value,String label) {
        if(!isRepositoryObjectId(value))throw new IllegalArgumentException(label+" must be a repository object ID");
        return value;
    }

    private static boolean isRepositoryObjectId(String value) {
        return value!=null&&value.length()>=5&&value.length()<=2048&&value.matches("rep:[^\\s\\p{Cntrl}]+");
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
        Element ret=requiredOperationReturn(r.document(), "listRepositoryObjectRevisionsResponse", "listRepositoryObjectRevisionsReturn");
        return parseRepositoryObjects(ret);
    }

    Map<String,Object> content(Map<String,Object> req,String sessionId) {
        String requestId=requiredRepositoryObjectId(requiredString(req,"requestedId"),"requestedId");
        String effectiveId=requiredRepositoryObjectId(requiredString(req,"effectiveId"),"effectiveId");
        int revision=revisionNumber(req.get("revisionNumber"));
        String wireId=requiredRepositoryObjectId(requiredString(req,"contentWireId"),"contentWireId");
        if(!revisionWireId(effectiveId, revision).equals(wireId)) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Revision content identity did not match the proven effective identity");
        }
        Map<String,Object> getReq=new LinkedHashMap<>();
        getReq.put("id",effectiveId); getReq.put("revisionNumber",revision); getReq.put("resolveRef",false); getReq.put("includePath",false);
        getReq.put("attrIds",List.of(Map.of("ns","rep","name","system:revisionnumber"))); getReq.put("options",List.of());
        Map<String,Object> revisionObj=get(getReq,sessionId);
        Object rid=revisionObj.get("id");
        if(!(rid instanceof String s)||!revisionMetadataIdentityMatches(effectiveId,s,revision)
                || !revisionAttributeMatches(revisionObj, revision)) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Revision content identity did not match the proven effective identity");
        }
        Map<String,Object> requestedLabel=map(req.get("contentLabel"));
        SoapResponse r=invoke("getRepositoryObjectContentWithOptions",contentRequestBody(req,wireId),sessionId,true);
        Element c=optionalOperationReturn(r.document(), "getRepositoryObjectContentWithOptionsResponse", "getRepositoryObjectContentWithOptionsReturn");
        if(c==null) throw new AdapterException("ARCSUITE_NOT_AVAILABLE","Content not available");
        Map<String,Object> returnedLabel=parseContentLabel(c);
        assertContentLabelMatches(requestedLabel,returnedLabel);
        String fileName=value(c,"fileName"); if(fileName==null||fileName.isBlank())fileName="document.bin";
        String contentType=value(c,"contentType"); if(contentType==null||contentType.isBlank())contentType="application/octet-stream";
        byte[] bytes=resolveData(typesChild(c,"data"),r.attachments());
        if(bytes.length>config.maxContentBytes()) throw new AdapterException("ARCSUITE_LIMIT_EXCEEDED","Content exceeds configured maximum size");
        String traceId=requiredString(req,"traceId").replaceAll("[^A-Za-z0-9._-]","_");
        String safeName=fileName.replaceAll("[\\\\/\\r\\n\\0]","_");
        Path path=config.sharedTempDir().resolve(traceId+"-"+UUID.randomUUID()+"-"+safeName).normalize();
        if(!path.startsWith(config.sharedTempDir())) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Unsafe temp path");
        try { Files.write(path,bytes,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE); }
        catch(IOException e){ throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Failed to materialize content",false,null,e); }
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        out.put("id",requestId); out.put("effectiveId",effectiveId); out.put("wireId",wireId); out.put("revisionNumber",revision); out.put("label",returnedLabel);
        out.put("fileName",fileName); out.put("contentType",contentType); out.put("sizeBytes",bytes.length); out.put("filePath",path.toString());
        return out;
    }

    static String revisionWireId(String baseId, int revision) {
        requiredRepositoryObjectId(baseId, "effectiveId");
        if (revision < MIN_REVISION_NUMBER || revision > MAX_REVISION_NUMBER) throw new IllegalArgumentException("revisionNumber is outside the licensed xsd:int public range");
        return baseId + ":" + revision;
    }

    private static boolean revisionMetadataIdentityMatches(String baseId, String returnedId, int revision) {
        if (!isRepositoryObjectId(returnedId)) return false;
        return baseId.equals(returnedId) || revisionWireId(baseId, revision).equals(returnedId);
    }

    private static boolean revisionAttributeMatchesIfPresent(Map<String,Object> object, int revision) {
        Object rawAttributes=object.get("attributes");
        if (!(rawAttributes instanceof Map<?,?> attributes)) return false;
        if (!attributes.containsKey("rep:system:revisionnumber")) return true;
        return revisionAttributeMatches(object, revision);
    }

    private static boolean revisionAttributeMatches(Map<String,Object> object, int revision) {
        Object rawAttributes=object.get("attributes");
        if (!(rawAttributes instanceof Map<?,?> attributes)) return false;
        Object rawValue=attributes.get("rep:system:revisionnumber");
        if (!(rawValue instanceof Map<?,?> value)) return false;
        Object rawType=value.get("type");
        Object rawRevision=value.get("value");
        return ("int".equals(rawType) || "long".equals(rawType))
                && rawRevision instanceof Number number
                && number.longValue() == revision
                && Double.isFinite(number.doubleValue());
    }

    static String contentRequestBody(Map<String,Object> req,String id) {
        Map<String,Object> label=map(req.get("contentLabel"));
        String ns=requiredString(label,"ns");
        String name=requiredString(label,"name");
        List<String> requestedOptions=strings(req.get("options"));
        for(String option:requestedOptions) {
            if(!Set.of("errorOnOfflineContent").contains(option)) throw new IllegalArgumentException("Unsupported content option");
        }
        return el("id",id)
                +"<t:contentLabels><t:i18nString ns=\""+XmlUtil.esc(ns)+"\" name=\""+XmlUtil.esc(name)+"\"/></t:contentLabels>"
                +options(requestedOptions);
    }

    static Map<String,Object> parseContentLabel(Element content) {
        Element label=typesChild(content,"label");
        if(label==null) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Content response did not include a label");
        String ns=label.getAttribute("ns");
        String name=label.getAttribute("name");
        if(ns==null||ns.isBlank()||name==null||name.isBlank()) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Content response label was incomplete");
        return Map.of("ns",ns,"name",name);
    }

    static void assertContentLabelMatches(Map<String,Object> requested,Map<String,Object> returned) {
        String requestedNs=requiredString(requested,"ns");
        String requestedName=requiredString(requested,"name");
        String returnedNs=requiredString(returned,"ns");
        String returnedName=requiredString(returned,"name");
        if(!requestedNs.equals(returnedNs)||!requestedName.equals(returnedName)) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Returned content label did not match the request");
        }
    }

    Map<String,Object> validateSchema(Map<String,Object> req,String sessionId) {
        LinkedHashMap<String,Object> out=new LinkedHashMap<>(); List<String> errors=new ArrayList<>();
        VersionInfo vi=getVersionInfo(); out.put("version",Map.of("minVersion",nvl(vi.minVersion()),"curVersion",nvl(vi.curVersion())));
        String cabinetId=requiredString(req,"cabinetId");
        try {
            SoapResponse cr=invoke("getCabinetInformation",el("cabinetId",cabinetId),sessionId,true);
            Element ci=requiredOperationReturn(cr.document(), "getCabinetInformationResponse", "getCabinetInformationReturn");
            LinkedHashMap<String,Object> cm=new LinkedHashMap<>(); cm.put("id",value(ci,"id")); cm.put("label",value(ci,"label"));
            String recycle=value(ci,"hasRecycleBin"); if(recycle!=null)cm.put("hasRecycleBin",Boolean.parseBoolean(recycle)); out.put("cabinet",cm);
        } catch(AdapterException e){ errors.add("cabinet:"+e.code); out.put("cabinet",Map.of("id",cabinetId)); }
        List<Map<String,Object>> requested=maps(req.get("attributes"));
        List<Map<String,Object>> attrs=new ArrayList<>();
        if(!requested.isEmpty()) {
            StringBuilder b=new StringBuilder("<t:attrIds>"); for(Map<String,Object> a:requested)b.append(attrId(map(a.get("attrId")))); b.append("</t:attrIds>");
            try {
                SoapResponse ar=invoke("getAttributeSchemas",b.toString(),sessionId,true);
                Element ret=requiredOperationResult(ar.document(), "getAttributeSchemasResponse");
                Element results=ret==null?null:typesChild(ret,"results");
                if(results!=null) for(Element schema:typesChildren(results,"attributeSchema")) attrs.add(parseAttributeSchema(schema));
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

    static String searchBody(Map<String,Object> req, boolean includeAttrs) {
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
        String textSearchMode = string(req,"textSearchMode","NONE");
        if (!SEARCH_TEXT_MODES.contains(textSearchMode)) throw new IllegalArgumentException("Unsupported text search mode: " + textSearchMode);
        b.append(el("textSearchMode", textSearchMode));
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
        long declared = response.headers().firstValueAsLong("content-length").orElse(-1L);
        if (declared > maxEnvelopeBytes) {
            try { response.body().close(); } catch (IOException ignored) {}
            throw new AdapterException("ARCSUITE_LIMIT_EXCEEDED", "SOAP/MTOM response exceeds configured maximum size");
        }
        byte[] responseBody = readAndClose(response.body(), maxEnvelopeBytes);
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

    static byte[] readAndClose(InputStream input, long maxBytes) {
        try (InputStream body = input) {
            return readBounded(body, maxBytes);
        } catch (IOException e) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response could not be read", false, null, e);
        }
    }

    private AdapterException parseFault(Document doc,int httpStatus) {
        Element fault=XmlUtil.firstDesc(doc.getDocumentElement(), SOAP_NS, "Fault"); if(fault==null)return null;
        // SOAP 1.1 Fault children are unqualified in the ArcSuite wire shape;
        // only the Fault wrapper itself is in the SOAP namespace.
        Element faultCodeElement=XmlUtil.child(fault, null, "faultcode");
        Element faultStringElement=XmlUtil.child(fault, null, "faultstring");
        Element detail=XmlUtil.child(fault, null, "detail");
        String faultCode=faultCodeElement==null?null:faultCodeElement.getTextContent();
        String faultString=faultStringElement==null?null:faultStringElement.getTextContent();
        String code=findArcSuiteCode(faultString);
        if(code==null)code=findArcSuiteCode(faultCode);
        if(code==null&&detail!=null)code=findArcSuiteCode(detail.getTextContent());
        if(code==null)code=findArcSuiteCode(fault.getTextContent());
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

    private static Element requiredOperationResult(Document document, String responseName) {
        if (document == null || document.getDocumentElement() == null
                || !XmlUtil.is(document.getDocumentElement(), SOAP_NS, "Envelope")) throw integrityShapeFailure();
        Element body = XmlUtil.child(document.getDocumentElement(), SOAP_NS, "Body");
        if (body == null) throw integrityShapeFailure();
        List<Element> bodyChildren = elementChildren(body);
        if (bodyChildren.size() != 1 || !XmlUtil.is(bodyChildren.get(0), TYPES_NS, responseName)) throw integrityShapeFailure();
        Element operationResponse = bodyChildren.get(0);
        Element result = XmlUtil.child(operationResponse, TYPES_NS, "result");
        List<Element> responseChildren = elementChildren(operationResponse);
        if (result == null || responseChildren.size() != 1 || responseChildren.get(0) != result) throw integrityShapeFailure();
        return result;
    }
    private static String value(Element e,String name){ return e==null?null:XmlUtil.childText(e,TYPES_NS,name); }
    private static String nvl(String s){return s==null?"":s;}

    private static String keyed(String key,String value){return "<t:preferences key=\""+XmlUtil.esc(key)+"\">"+XmlUtil.esc(value)+"</t:preferences>";}
    private static String el(String name,String value){return "<t:"+name+">"+XmlUtil.esc(value)+"</t:"+name+">";}
    private static String idsElement(List<String> values){StringBuilder b=new StringBuilder("<t:ids>");for(String value:values)b.append(el("id",value));return b.append("</t:ids>").toString();}
    private static String attrId(Map<String,Object> id){String ns=string(id,"ns","");String name=requiredString(id,"name"); return "<t:attributeId"+(ns.isBlank()?"":" ns=\""+XmlUtil.esc(ns)+"\"")+" name=\""+XmlUtil.esc(name)+"\"/>";}
    private static String attrIds(Object o){List<Map<String,Object>> ids=maps(o);if(ids.isEmpty())return "<t:attrIds/>";StringBuilder b=new StringBuilder("<t:attrIds>");for(Map<String,Object> id:ids)b.append(attrId(id));return b.append("</t:attrIds>").toString();}
    private static String options(Object o){StringBuilder b=new StringBuilder();for(String x:strings(o))b.append(el("options",x));return b.toString();}
    private static String sortCondition(Object o){List<Map<String,Object>> order=maps(o);if(order.isEmpty())return "";StringBuilder b=new StringBuilder("<t:order>");for(Map<String,Object>x:order){b.append("<t:sortItem isDescending=\"").append(bool(x,"descending",false)).append("\">").append(attrId(map(x.get("attrId")))).append("</t:sortItem>");}return b.append("</t:order>").toString();}

    static String attributeConditions(String elementName,List<Map<String,Object>> cs){ if(cs.size()==1)return singleCondition(elementName,cs.get(0)); StringBuilder b=new StringBuilder("<t:").append(elementName).append(" xsi:type=\"t:AndCondition\">"); for(Map<String,Object> c:cs)b.append(singleCondition("attributeSearchCondition",c)); return b.append("</t:").append(elementName).append('>').toString(); }
    private static String singleCondition(String elementName,Map<String,Object> c){Map<String,Object> aid=map(c.get("attrId"));Map<String,Object> val=map(c.get("value"));
        String operator=requiredString(c,"operator");
        if(!SEARCH_BINARY_OPERATORS.contains(operator))throw new IllegalArgumentException("Unsupported binary search operator: "+operator);
        return "<t:"+elementName+" xsi:type=\"t:BinaryOperatorCondition\" mode=\"ONEVAL\" operator=\""+XmlUtil.esc(operator)+"\">"+attrId(aid)+attributeValueBody(val)+"</t:"+elementName+">"; }
    static String attributeValueBody(Map<String,Object> val){
        String type=string(val,"type","string");
        String xsi;
        String child;
        String lexical;
        switch(type){
            case "string" -> { xsi="StringValue"; child="string"; lexical=requiredValueType(val,"value",String.class); }
            case "boolean" -> { xsi="BooleanValue"; child="boolean"; lexical=booleanLexical(val.get("value")); }
            case "int" -> { xsi="IntValue"; child="int"; lexical=String.valueOf(exactInt(val.get("value"))); }
            case "long" -> { xsi="LongValue"; child="long"; lexical=String.valueOf(exactLong(val.get("value"))); }
            case "double" -> { xsi="DoubleValue"; child="double"; lexical=doubleLexical(val.get("value")); }
            case "date" -> { xsi="DateValue"; child="date"; lexical=dateLexical(val.get("value")); }
            case "datetime" -> { xsi="DateTimeValue"; child="dateTime"; lexical=dateTimeLexical(val.get("value")); }
            case "i18n" -> {
                xsi="I18nStringValue";
                String ns=requiredValueType(val,"ns",String.class);
                String name=requiredValueType(val,"name",String.class);
                return "<t:attributeValue xsi:type=\"t:I18nStringValue\"><t:i18nString ns=\""+XmlUtil.esc(ns)+"\" name=\""+XmlUtil.esc(name)+"\"/></t:attributeValue>";
            }
            default -> throw new IllegalArgumentException("Unsupported attribute value type: "+type);
        }
        return "<t:attributeValue xsi:type=\"t:"+xsi+"\">"+el(child,lexical)+"</t:attributeValue>";
    }
    private static String textCondition(Map<String,Object> text){StringBuilder b=new StringBuilder("<t:textCondition xsi:type=\"t:TextCondition\"><t:wordList operator=\"").append(XmlUtil.esc(string(text,"operator","AND"))).append("\">");for(String w:strings(text.get("words")))b.append(el("word",w));return b.append("</t:wordList></t:textCondition>").toString();}

    private static List<String> parseOperationIdArray(Document document, String operation) {
        Element returnValue = requiredOperationReturn(document, operation + "Response", operation + "Return");
        assertNoUnexpectedText(returnValue);
        List<String> values = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Element child : elementChildren(returnValue)) {
            if (!types(child, "id") || !elementChildren(child).isEmpty()) throw responseShapeFailure();
            String raw = child.getTextContent();
            if (raw == null || raw.isBlank()) throw responseShapeFailure();
            String id = raw.trim();
            if (!isRepositoryObjectId(id) || !seen.add(id)) throw responseShapeFailure();
            values.add(id);
        }
        return List.copyOf(values);
    }

    private static void assertNoUnexpectedText(Element element) {
        for (Node node = element.getFirstChild(); node != null; node = node.getNextSibling()) {
            if ((node.getNodeType() == Node.TEXT_NODE || node.getNodeType() == Node.CDATA_SECTION_NODE)
                    && !node.getNodeValue().isBlank()) throw responseShapeFailure();
        }
    }

    private static AdapterException responseShapeFailure() {
        return new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite response shape or accounting mismatch");
    }

    private static List<Map<String,Object>> parseRepositoryObjects(Element container) {
        if (container == null) throw responseShapeFailure();
        assertNoUnexpectedText(container);
        List<Map<String,Object>> out = new ArrayList<>();
        for (Element child : elementChildren(container)) {
            if (!types(child, "repositoryObject")) throw responseShapeFailure();
            out.add(parseRepositoryObject(child));
        }
        return List.copyOf(out);
    }

    static List<String> parseHardReferenceIds(Element container,String targetId,int maxResults) {
        if(container==null||!TYPES_NS.equals(container.getNamespaceURI())||!isRepositoryObjectId(targetId)||maxResults<1||maxResults>HARD_REFERENCE_MAX_CANDIDATES) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference response shape was invalid");
        }
        assertNoUnexpectedText(container);
        List<Element> objects=typesChildren(container,"repositoryObject");
        for(Node node=container.getFirstChild();node!=null;node=node.getNextSibling()) {
            if(node instanceof Element element&&!types(element,"repositoryObject")) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference response shape was invalid");
            }
        }
        if(objects.size()>maxResults)throw new AdapterException("ARCSUITE_LIMIT_EXCEEDED","Hard Reference result exceeds configured maximum");
        List<String> ids=new ArrayList<>(objects.size());
        Set<String> seen=new HashSet<>();
        for(Element object:objects) {
            Map<String,Object> parsed = parseRepositoryObject(object);
            String objectId = String.valueOf(parsed.get("id"));
            List<Element> referenceIds=typesChildren(object,"referenceId");
            if(referenceIds.size()!=1) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference response identity was incomplete");
            }
            if(!isRepositoryObjectId(objectId)||!seen.add(objectId)) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference response identity was invalid");
            }
            Element referenceId = referenceIds.get(0);
            List<Element> referenceFields = elementChildren(referenceId);
            if (referenceFields.size() < 1 || referenceFields.size() > 2
                    || !types(referenceFields.get(0), "id")
                    || (referenceFields.size() == 2 && !types(referenceFields.get(1), "editionKey"))) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference target shape was invalid");
            }
            List<Element> targetIds=typesChildren(referenceId,"id");
            if(targetIds.size()!=1)throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference target identity was missing");
            if (referenceFields.size() == 2) validateAttributes(referenceFields.get(1));
            // ReferenceId.id identifies the target repository object. editionKey is separate metadata and stays internal.
            String returnedTargetId=targetIds.get(0).getTextContent().trim();
            if(!isRepositoryObjectId(returnedTargetId)||!targetId.equals(returnedTargetId)) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Hard Reference target identity did not match");
            }
            ids.add(objectId);
        }
        return List.copyOf(ids);
    }

    static Map<String,Object> parseRepositoryObject(Element e) {
        if (e == null || !(types(e, "repositoryObject")
                || types(e, "getRepositoryObjectReturn")
                || types(e, "getRepositoryDocumentByRevisionNubmerReturn"))) throw responseShapeFailure();
        assertNoUnexpectedText(e);
        List<Element> fields = elementChildren(e);
        if (fields.size() < 3 || !types(fields.get(0), "id")
                || !types(fields.get(1), "objectClass")
                || !types(fields.get(2), "attributes")) throw responseShapeFailure();
        List<String> optionalOrder = List.of("acl", "defaultAcl", "effectivePrivileges", "referenceId", "disusedLocationId");
        int lastOptional = -1;
        Set<String> seenOptional = new HashSet<>();
        for (int i = 3; i < fields.size(); i++) {
            Element field = fields.get(i);
            int position = optionalOrder.indexOf(field.getLocalName());
            if (!TYPES_NS.equals(field.getNamespaceURI()) || position < 0 || position <= lastOptional || !seenOptional.add(field.getLocalName())) {
                throw responseShapeFailure();
            }
            lastOptional = position;
        }
        String id = fields.get(0).getTextContent();
        if (id == null || id.isBlank() || !isRepositoryObjectId(id.trim())) throw responseShapeFailure();
        Element objectClass = fields.get(1);
        String objectClassNs = objectClass.getAttribute("ns");
        String objectClassName = objectClass.getAttribute("name");
        if (objectClassNs == null || objectClassNs.isBlank() || !OBJECT_CLASS_NS.equals(objectClassNs)
                || objectClassName == null || objectClassName.isBlank()) throw responseShapeFailure();
        String semanticObjectClass = SEMANTIC_OBJECT_CLASSES.getOrDefault(objectClassNs + ":" + objectClassName, "unknown");
        Element attributes = fields.get(2);
        LinkedHashMap<String,Object> out = new LinkedHashMap<>();
        out.put("id", id.trim());
        out.put("objectClass", semanticObjectClass);
        out.put("nativeObjectClass", Map.of("ns", objectClassNs, "name", objectClassName));
        out.put("attributes", parseAttributes(attributes));
        return out;
    }

    private static Map<String,Object> parseAttributes(Element attributes) {
        if (attributes == null) throw responseShapeFailure();
        assertNoUnexpectedText(attributes);
        LinkedHashMap<String,Object> out = new LinkedHashMap<>();
        for (Element attribute : elementChildren(attributes)) {
            if (!types(attribute, "attribute")) throw responseShapeFailure();
            List<Element> values = elementChildren(attribute);
            if (values.size() > 1 || (values.size() == 1 && !types(values.get(0), "attributeValue"))) throw responseShapeFailure();
            String ns = attribute.getAttribute("ns");
            String name = attribute.getAttribute("name");
            if (name == null || name.isBlank()) throw responseShapeFailure();
            if (!values.isEmpty()) out.put((ns == null ? "" : ns) + ":" + name, parseAttributeValue(values.get(0)));
        }
        return out;
    }

    private static void validateAttributes(Element attributes) {
        parseAttributes(attributes);
    }
    private static Object parseAttributeValue(Element av){String t=XmlUtil.qualifiedType(av,TYPES_NS);LinkedHashMap<String,Object> o=new LinkedHashMap<>();
        try { switch(t){case "StringValue"-> {o.put("type","string");o.put("value",value(av,"string"));} case "IntValue"->{o.put("type","int");o.put("value",Integer.parseInt(value(av,"int")));} case "LongValue"->{long n=Long.parseLong(value(av,"long"));if(n<-9007199254740991L||n>9007199254740991L)throw new IllegalArgumentException("unsafe long");o.put("type","long");o.put("value",n);} case "DoubleValue"->{double n=Double.parseDouble(value(av,"double"));if(!Double.isFinite(n))throw new IllegalArgumentException("non-finite double");o.put("type","double");o.put("value",n);} case "BooleanValue"->{o.put("type","boolean");o.put("value",parseBooleanLexical(value(av,"boolean")));} case "DateTimeValue"->{o.put("type","datetime");o.put("value",value(av,"dateTime"));} case "DateValue"->{o.put("type","date");o.put("value",value(av,"date"));} case "IdValue"->{o.put("type","id");o.put("value",value(av,"id"));} case "I18nStringValue"->{Element i=typesChild(av,"i18nString");o.put("type","i18n"); if(i!=null){o.put("ns",i.getAttribute("ns"));o.put("name",i.getAttribute("name"));String l=i18nLabel(i);if(l!=null)o.put("label",l);}} case "I18nStringValues"->{o.put("type","i18n[]");List<Object> vs=new ArrayList<>();for(Element i:typesChildren(av,"i18nStrings")){LinkedHashMap<String,Object>x=new LinkedHashMap<>();x.put("ns",i.getAttribute("ns"));x.put("name",i.getAttribute("name"));String l=i18nLabel(i);if(l!=null)x.put("label",l);vs.add(x);}o.put("values",vs);} case "RmsObjectValueRmsObject"->{o.put("type","rmsObject");Element r=XmlUtil.firstDesc(av,TYPES_NS,"rmsObject");if(r!=null){String dn=value(r,"dn");if(dn!=null)o.put("dn",dn);Element oc=typesChild(r,"objectClass");String l=oc==null?null:i18nLabel(oc);if(l!=null)o.put("label",l);}} default->{o.put("type","unknown");o.put("rawType",t.isBlank()?"unknown":t);String text=av.getTextContent();if(text!=null&&!text.isBlank())o.put("value",text.trim());} } }
        catch(Exception ex){o.clear();o.put("type","unknown");o.put("rawType",t.isBlank()?"unknown":t);}return o;}
    private static String i18nLabel(Element i){for(Element l:typesChildren(i,"label")){String lang=l.getAttribute("lang");if("ja".equalsIgnoreCase(lang))return l.getTextContent();}Element l=typesChild(i,"label");return l==null?null:l.getTextContent();}

    private static List<Map<String,Object>> parseFailures(Element container){
        if (container == null) throw responseShapeFailure();
        assertNoUnexpectedText(container);
        List<Map<String,Object>> out=new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (Element failure : elementChildren(container)) {
            if (!types(failure, "failure")) throw responseShapeFailure();
            List<Element> fields = elementChildren(failure);
            if (fields.size() != 2 || !types(fields.get(0), "index") || !types(fields.get(1), "exception")) throw responseShapeFailure();
            int index;
            try { index = Integer.parseInt(fields.get(0).getTextContent().trim()); }
            catch (Exception ignored) { throw responseShapeFailure(); }
            if (!seen.add(index)) throw responseShapeFailure();
            String upstream = findArcSuiteCode(fields.get(1).getTextContent());
            LinkedHashMap<String,Object> item=new LinkedHashMap<>();
            item.put("index", index);
            item.put("code", stableCode(upstream));
            if (upstream != null) item.put("upstreamCode", upstream);
            out.add(item);
        }
        return List.copyOf(out);
    }

    @SuppressWarnings("unchecked") private static void applyPath(Map<String,Object> out,Element p){
        assertNoUnexpectedText(p);
        List<Element> fields=elementChildren(p);
        if(fields.size()!=2||!types(fields.get(0),"objects")||!types(fields.get(1),"fullPath")) throw responseShapeFailure();
        List<Object> path=new ArrayList<>();
        for(Map<String,Object> parsed:parseRepositoryObjects(fields.get(0))){
            Map<String,Object> attrs=(Map<String,Object>)parsed.get("attributes");
            Object nv=attrs.get("rep:system:name");
            String name=null;
            if(nv instanceof Map<?,?> vm&&vm.get("value")!=null)name=String.valueOf(vm.get("value"));
            LinkedHashMap<String,Object>x=new LinkedHashMap<>();
            x.put("id",parsed.get("id"));
            if(name!=null)x.put("name",name);
            x.put("objectClass",parsed.get("objectClass"));
            x.put("nativeObjectClass",parsed.get("nativeObjectClass"));
            path.add(x);
        }
        out.put("pathObjects",path);
        out.put("fullPath",parseBooleanLexical(fields.get(1).getTextContent().trim()));
    }
    static Map<String,Object> parseAttributeSchema(Element s){
        LinkedHashMap<String,Object> o=new LinkedHashMap<>();
        for(String k:List.of("ns","name","dataType","nativeDataType","pattern")){String v=value(s,k);if(v!=null)o.put(k,v);}
        for(String k:List.of("multiValued","required","enumerated","modifiable","searchable","sortable","minInclusive","maxInclusive")){String v=value(s,k);if(v!=null)o.put(k,parseBooleanLexical(v));}
        for(String k:List.of("minLength","maxLength","minCount","maxCount")){String v=value(s,k);if(v!=null)o.put(k,parseInteger(v,k));}
        for(String k:List.of("minIntegralValue","maxIntegralValue")){String v=value(s,k);if(v!=null)o.put(k,parseLongLexical(v,k));}
        for(String k:List.of("minFloatingValue","maxFloatingValue")){String v=value(s,k);if(v!=null)o.put(k,parseDouble(v,k));}
        Element labels=typesChild(s,"enumLabels");
        if(labels!=null){List<Object> values=new ArrayList<>();for(Element i:typesChildren(labels,"i18nString")){LinkedHashMap<String,Object>x=new LinkedHashMap<>();String ns=i.getAttribute("ns"),name=i.getAttribute("name");if(ns!=null&&!ns.isBlank())x.put("ns",ns);if(name==null||name.isBlank())throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","AttributeSchema enumLabels contains an unnamed value");x.put("name",name);String label=i18nLabel(i);if(label!=null)x.put("label",label);values.add(x);}o.put("enumLabels",values);}
        return o;
    }
    private static String requiredValueType(Map<String,Object> value,String key,Class<?> type){
        Object raw=value.get(key);
        if(!type.isInstance(raw))throw new IllegalArgumentException(key+" must be "+type.getSimpleName());
        String text=String.valueOf(raw);
        if(text.isBlank())throw new IllegalArgumentException(key+" is required");
        return text;
    }
    private static int exactInt(Object raw){
        long value=exactLong(raw);
        if(value<Integer.MIN_VALUE||value>Integer.MAX_VALUE)throw new IllegalArgumentException("int value is out of range");
        return (int)value;
    }

    static int revisionNumber(Object raw) {
        long value = exactLong(raw);
        if (value < MIN_REVISION_NUMBER || value > MAX_REVISION_NUMBER) {
            throw new IllegalArgumentException("revisionNumber is outside the licensed xsd:int public range");
        }
        return Math.toIntExact(value);
    }

    private static long exactLong(Object raw){
        if(raw instanceof Byte||raw instanceof Short||raw instanceof Integer||raw instanceof Long)return ((Number)raw).longValue();
        if(raw instanceof java.math.BigInteger integer){try{return integer.longValueExact();}catch(ArithmeticException ignored){}}
        if(raw instanceof java.math.BigDecimal decimal){try{return decimal.toBigIntegerExact().longValueExact();}catch(ArithmeticException ignored){}}
        throw new IllegalArgumentException("integer value is required");
    }
    private static String booleanLexical(Object raw){
        if(!(raw instanceof Boolean value))throw new IllegalArgumentException("boolean value is required");
        return value?"true":"false";
    }
    private static String doubleLexical(Object raw){
        if(!(raw instanceof Number number))throw new IllegalArgumentException("double value is required");
        double value=number.doubleValue();
        if(!Double.isFinite(value))throw new IllegalArgumentException("double value must be finite");
        return Double.toString(value);
    }
    private static String dateLexical(Object raw){
        if(!(raw instanceof String value)||value.isBlank())throw new IllegalArgumentException("date value is required");
        try{LocalDate.parse(value);return value;}catch(DateTimeParseException e){throw new IllegalArgumentException("date value must be ISO date",e);}
    }
    private static String dateTimeLexical(Object raw){
        if(!(raw instanceof String value)||value.isBlank())throw new IllegalArgumentException("datetime value is required");
        var match = java.util.regex.Pattern.compile(
                "^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(Z|[+-](\\d{2}):(\\d{2}))$"
        ).matcher(value);
        if(!match.matches()
                || "-00:00".equals(match.group(5))
                || Integer.parseInt(match.group(2)) > 23
                || Integer.parseInt(match.group(3)) > 59
                || Integer.parseInt(match.group(4)) > 59
                || (match.group(6) != null
                    && (Integer.parseInt(match.group(6)) > 23
                        || Integer.parseInt(match.group(7)) > 59))) {
            throw new IllegalArgumentException("datetime value must be RFC3339");
        }
        try{LocalDate.parse(match.group(1));return value;}catch(DateTimeParseException e){throw new IllegalArgumentException("datetime value must be RFC3339",e);}
    }
    private static boolean parseBooleanLexical(String raw){
        if("true".equals(raw)||"1".equals(raw))return true;
        if("false".equals(raw)||"0".equals(raw))return false;
        throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Invalid boolean in ArcSuite response");
    }
    private static int parseInteger(String raw,String field){try{return Integer.parseInt(raw);}catch(NumberFormatException e){throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Invalid AttributeSchema "+field);}}
    private static String parseLongLexical(String raw,String field){try{Long.parseLong(raw);return raw;}catch(NumberFormatException e){throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Invalid AttributeSchema "+field);}}
    private static double parseDouble(String raw,String field){try{double d=Double.parseDouble(raw);if(!Double.isFinite(d))throw new NumberFormatException();return d;}catch(NumberFormatException e){throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Invalid AttributeSchema "+field);}}
    private static byte[] resolveData(Element data,Map<String,byte[]> attachments){if(data==null)return new byte[0];Element include=XmlUtil.firstDesc(data,XOP_NS,"Include");if(include!=null){String href=include.getAttribute("href");String cid=MtomParser.normalizeCid(href);byte[] a=attachments.get(cid);if(a==null)throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","MTOM attachment referenced but missing");return a;}String text=data.getTextContent();if(text==null||text.isBlank())return new byte[0];try{return Base64.getMimeDecoder().decode(text);}catch(IllegalArgumentException e){throw new AdapterException("ARCSUITE_UPSTREAM_ERROR","Invalid base64 content",false,null,e);}}

    @SuppressWarnings("unchecked") private static Map<String,Object> map(Object o){ if(!(o instanceof Map<?,?>m))throw new IllegalArgumentException("object required");return (Map<String,Object>)m; }
    @SuppressWarnings("unchecked") private static Map<String,Object> mapOrNull(Object o){ return o instanceof Map<?,?>m?(Map<String,Object>)m:null; }
    @SuppressWarnings("unchecked") private static List<Map<String,Object>> maps(Object o){ if(!(o instanceof List<?>l))return List.of();List<Map<String,Object>>r=new ArrayList<>();for(Object x:l)if(x instanceof Map<?,?>m)r.add((Map<String,Object>)m);return r; }
    private static List<String> strings(Object o){ if(!(o instanceof List<?>l))return List.of();List<String>r=new ArrayList<>();for(Object x:l)if(x!=null)r.add(String.valueOf(x));return r; }
    private static String requiredString(Map<String,Object>m,String k){Object v=m.get(k);if(v==null||String.valueOf(v).isBlank())throw new IllegalArgumentException(k+" is required");return String.valueOf(v);}
    private static String string(Map<String,Object>m,String k,String d){Object v=m.get(k);return v==null?d:String.valueOf(v);}
    private static int integer(Map<String,Object>m,String k,int d){Object v=m.get(k);return v instanceof Number n?n.intValue():v==null?d:Integer.parseInt(String.valueOf(v));}
    private static boolean bool(Map<String,Object>m,String k,boolean d){Object v=m.get(k);return v instanceof Boolean b?b:v==null?d:Boolean.parseBoolean(String.valueOf(v));}
}
