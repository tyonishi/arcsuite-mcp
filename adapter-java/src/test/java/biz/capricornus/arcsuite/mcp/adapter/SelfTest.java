package biz.capricornus.arcsuite.mcp.adapter;

import com.sun.net.httpserver.HttpServer;
import javax.crypto.Cipher;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SelfTest {
    public static void main(String[] args) throws Exception {
        jsonRoundTrip();
        cryptoRoundTrip();
        mtomDecode();
        soapRequestShapes();
        hardReferenceContractShapes();
        documentIntegrityContractShapes();
        contentLabelWireShapes();
        typedAttributeValueShapes();
        attributeSchemaMetadataParsing();
        responseIdParsing();
        xmlXxeBlocked();
        boundedStreams();
        System.out.println("Java adapter self-test: PASS");
    }

    static void jsonRoundTrip() {
        Object v = Json.parse("{\"a\":1,\"b\":[true,\"x\"]}");
        String out = Json.stringify(v);
        if (!out.contains("\"a\":1")) throw new AssertionError(out);
    }

    static void cryptoRoundTrip() throws Exception {
        var generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        var pair = generator.generateKeyPair();
        var pub = (RSAPublicKey) pair.getPublic();
        byte[] modulus = unsigned(pub.getModulus().toByteArray());
        byte[] exponent = unsigned(pub.getPublicExponent().toByteArray());
        String encrypted = Crypto.encryptCredential("challenge", "password", Base64.getEncoder().encodeToString(modulus), Base64.getEncoder().encodeToString(exponent));
        var cipher = Crypto.credentialCipher(Cipher.DECRYPT_MODE, pair.getPrivate());
        String plain = new String(cipher.doFinal(Base64.getDecoder().decode(encrypted)), StandardCharsets.UTF_8);
        if (!"challengepassword".equals(plain)) throw new AssertionError(plain);
    }

    static void mtomDecode() {
        String boundary="test-boundary";
        String body="--"+boundary+"\r\nContent-Type: application/xop+xml; charset=UTF-8; type=\"text/xml\"\r\nContent-ID: <root>\r\n\r\n<Envelope><data><xop:Include xmlns:xop=\"http://www.w3.org/2004/08/xop/include\" href=\"cid:bin\"/></data></Envelope>\r\n"+
                "--"+boundary+"\r\nContent-Type: application/octet-stream\r\nContent-ID: <bin>\r\n\r\nABC123\r\n--"+boundary+"--\r\n";
        MtomMessage m=MtomParser.parse("multipart/related; boundary=\""+boundary+"\"",body.getBytes(StandardCharsets.ISO_8859_1));
        if(!"ABC123".equals(new String(m.attachments().get("bin"),StandardCharsets.ISO_8859_1))) throw new AssertionError();
    }

    static void soapRequestShapes() {
        Map<String,Object> incoming = Map.of(
                "ids", List.of("rep:example:one", "rep:example:two"),
                "resolveRef", true,
                "attrIds", List.of(Map.of("ns", "rep", "name", "system:name")),
                "options", List.of("referenceId")
        );
        Map<String,Object> request = AdapterService.prepareGetManyRequest(incoming);
        if (!Boolean.FALSE.equals(request.get("resolveRef"))) throw new AssertionError("batch request must preserve requested object identity");
        String body = ArcSuiteSoapClient.getRepositoryObjectsBody(request);
        String expected = "<t:ids><t:id>rep:example:one</t:id><t:id>rep:example:two</t:id></t:ids>"
                + "<t:resolveRef>false</t:resolveRef>"
                + "<t:attrIds><t:attributeId ns=\"rep\" name=\"system:name\"/></t:attrIds>"
                + "<t:options>referenceId</t:options>";
        if (!expected.equals(body)) throw new AssertionError("Unexpected getRepositoryObjects body: " + body);
        if (body.contains("<t:string>")) throw new AssertionError("Ids wire type must use <id>, not <string>");

        try {
            ArcSuiteSoapClient.getRepositoryObjectsBody(Map.of("ids", List.of()));
            throw new AssertionError("empty ids must be rejected");
        } catch (IllegalArgumentException expectedFailure) {}
    }

    static void hardReferenceContractShapes() throws Exception {
        hardReferenceRequestAndSoapEnvelopeShape();
        hardReferenceResponseParsing();
        hardReferenceIdentityFailures();
        hardReferenceOverflowFailsClosed();
        hardReferenceServiceBounds();
    }

    static void documentIntegrityContractShapes() throws Exception {
        integrityRequestBuilders();
        integritySoapRequestWrappers();
        integrityValidationResponseParsing();
        evidenceResponseParsingAndSanitization();
        integrityOperationAndServiceBounds();
    }

    static void integrityRequestBuilders() {
        String id = "rep:example:document-001";
        String validateBody = ArcSuiteSoapClient.validateCertificateBody(id);
        if (!"<t:ids><t:id>rep:example:document-001</t:id></t:ids>".equals(validateBody)) {
            throw new AssertionError("validateCertificate must encode one target as ids/id: " + validateBody);
        }
        String escapedBody = ArcSuiteSoapClient.validateCertificateBody("rep:example:doc&<001>");
        if (!"<t:ids><t:id>rep:example:doc&amp;&lt;001&gt;</t:id></t:ids>".equals(escapedBody)) {
            throw new AssertionError("validateCertificate ID was not XML escaped: " + escapedBody);
        }
        String evidenceBody = ArcSuiteSoapClient.certificateEvidenceBody(id);
        if (!"<t:id>rep:example:document-001</t:id>".equals(evidenceBody)) {
            throw new AssertionError("getCertificateEvidence must encode the target as one id: " + evidenceBody);
        }

        Map<String, Object> validationRequest = AdapterService.prepareIntegrityRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", id));
        if (!validationRequest.equals(Map.of("clientProfileId", "synthetic-client", "id", id))) {
            throw new AssertionError("Unexpected private integrity request: " + validationRequest);
        }
        Map<String, Object> evidenceRequest = AdapterService.prepareEvidenceRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", id));
        if (!evidenceRequest.equals(Map.of("clientProfileId", "synthetic-client", "id", id))) {
            throw new AssertionError("Unexpected private evidence request: " + evidenceRequest);
        }
        expectIllegalArgument(() -> AdapterService.prepareIntegrityRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", id, "ids", List.of(id))));
        expectIllegalArgument(() -> AdapterService.prepareEvidenceRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", id, "certAttribute", "private")));
    }

    static void integritySoapRequestWrappers() throws Exception {
        String targetId = "rep:example:document-001";
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var requests = new StringBuilder();
        server.createContext("/", exchange -> {
            String request = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            requests.append(request).append("\n---REQUEST---\n");
            String response;
            if (request.contains("<t:validateCertificate>")) {
                response = "<t:validateCertificateResponse><t:validateCertificateReturn>"
                        + "<t:results><t:results><t:certValidElements/></t:results></t:results><t:failures/>"
                        + "</t:validateCertificateReturn></t:validateCertificateResponse>";
            } else if (request.contains("<t:getCertificateEvidence>")) {
                response = "<t:getCertificateEvidenceResponse><t:getCertificateEvidenceReturn/>"
                        + "</t:getCertificateEvidenceResponse>";
            } else {
                response = "<t:unexpectedResponse/>";
            }
            byte[] body = ("<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\""
                    + ArcSuiteSoapClient.TYPES_NS + "\" xmlns:xsi=\"" + ArcSuiteSoapClient.XSI_NS + "\"><soap:Body>"
                    + response + "</soap:Body></soap:Envelope>").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            var config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/", "synthetic-user", "synthetic-password",
                    "synthetic-internal-token", 18080, "127.0.0.1", Duration.ofSeconds(2), Duration.ofSeconds(2),
                    1500, 1700, 4, "ja", "4.0.0.0", Path.of(System.getProperty("java.io.tmpdir")), 1024 * 1024);
            var client = new ArcSuiteSoapClient(config);
            Map<String, Object> validation = client.validateIntegrity(Map.of("id", targetId), "synthetic-session");
            if (!List.of().equals(validation.get("certificates")) || validation.get("failure") != null) {
                throw new AssertionError("Empty validation elements were not preserved: " + validation);
            }
            Map<String, Object> evidence = client.certificateEvidence(Map.of("id", targetId), "synthetic-session");
            if (!List.of().equals(evidence.get("certIds"))) throw new AssertionError("Empty evidence response was not preserved: " + evidence);

            String captured = requests.toString();
            String validateWrapper = "<t:validateCertificate><t:ids><t:id>rep:example:document-001</t:id></t:ids></t:validateCertificate>";
            String evidenceWrapper = "<t:getCertificateEvidence><t:id>rep:example:document-001</t:id></t:getCertificateEvidence>";
            if (!captured.contains(validateWrapper)) throw new AssertionError("Unexpected validation SOAP wrapper: " + captured);
            if (!captured.contains(evidenceWrapper)) throw new AssertionError("Unexpected evidence SOAP wrapper: " + captured);
            if (captured.contains("<t:calculateCertificateEvidence>") || captured.contains("<t:attachTimestamp")) {
                throw new AssertionError("Integrity reads dispatched a prohibited evidence/timestamp operation");
            }
            if (!captured.contains("administratorMode=\"false\"")) throw new AssertionError("Administrator mode was not disabled");
        } finally {
            server.stop(0);
        }
    }

    static void integrityValidationResponseParsing() {
        String success = validationResponse(
                "<t:results><t:certValidElements>"
                        + "<t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:result>true</t:result><t:signer>synthetic signer</t:signer></t:results>"
                        + "<t:results xsi:type=\"t:PAdESValidateResult\"><t:certId>18</t:certId><t:result>false</t:result>"
                        + "<t:exception><t:code>ARCSUITE_WS-08305101</t:code><t:message>synthetic private exception</t:message></t:exception>"
                        + "<t:timestampDate>2026-09-13T00:00:00Z</t:timestampDate></t:results>"
                        + "</t:certValidElements></t:results>",
                "");
        Map<String, Object> parsed = ArcSuiteSoapClient.parseIntegrityValidation(XmlUtil.parse(success));
        Object rawCertificates = parsed.get("certificates");
        if (!(rawCertificates instanceof List<?> certificates) || certificates.size() != 2) {
            throw new AssertionError("Expected two validation elements: " + parsed);
        }
        Map<?, ?> first = (Map<?, ?>) certificates.get(0);
        Map<?, ?> second = (Map<?, ?>) certificates.get(1);
        if (!Integer.valueOf(17).equals(first.get("certId")) || !Boolean.TRUE.equals(first.get("result"))
                || !Boolean.FALSE.equals(first.get("exceptionPresent"))) throw new AssertionError("Unexpected first certificate result: " + first);
        if (!Integer.valueOf(18).equals(second.get("certId")) || !Boolean.FALSE.equals(second.get("result"))
                || !Boolean.TRUE.equals(second.get("exceptionPresent"))) throw new AssertionError("Unexpected second certificate result: " + second);
        String sanitized = Json.stringify(parsed);
        if (sanitized.contains("synthetic private exception") || sanitized.contains("ARCSUITE_WS-08305101")
                || sanitized.contains("synthetic signer") || sanitized.contains("timestampDate")) {
            throw new AssertionError("Raw exception or provider-specific validation detail crossed the adapter boundary: " + sanitized);
        }

        Map<String, Object> noElements = ArcSuiteSoapClient.parseIntegrityValidation(XmlUtil.parse(
                validationResponse("<t:results><t:certValidElements/></t:results>", "")));
        if (!List.of().equals(noElements.get("certificates")) || noElements.get("failure") != null) {
            throw new AssertionError("Zero validation elements must remain a successful structured result: " + noElements);
        }

        Map<String, Object> perIdFailure = ArcSuiteSoapClient.parseIntegrityValidation(XmlUtil.parse(validationResponse(
                "", "<t:failure><t:index>0</t:index><t:exception><t:message>synthetic private failure</t:message></t:exception></t:failure>")));
        if (!List.of().equals(perIdFailure.get("certificates")) || !"per_id".equals(perIdFailure.get("failure"))) {
            throw new AssertionError("Failure at the single requested input index must be classified internally: " + perIdFailure);
        }
        if (Json.stringify(perIdFailure).contains("synthetic private failure")) throw new AssertionError("Failure details were exposed");

        assertIntegrityResponseFailure(validationResponse("", ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements/></t:results><t:results><t:certValidElements/></t:results>", ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse("<t:results><t:certValidElements/></t:results>",
                "<t:failure><t:index>0</t:index><t:exception/></t:failure>"), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse("", "<t:failure><t:index>1</t:index><t:exception/></t:failure>"), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse("", "<t:failure><t:index>bad</t:index><t:exception/></t:failure>"), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse("", "<t:failure><t:index>0</t:index></t:failure>"), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results><t:result>true</t:result><t:certId>17</t:certId></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure("<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS
                + "\"><soap:Body><unexpectedResponse/></soap:Body></soap:Envelope>", "ARCSUITE_UPSTREAM_ERROR");

        StringBuilder tooMany = new StringBuilder("<t:results><t:certValidElements>");
        for (int i = 0; i < 65; i++) tooMany.append("<t:results><t:certId>").append(i + 1)
                .append("</t:certId><t:result>true</t:result></t:results>");
        tooMany.append("</t:certValidElements></t:results>");
        assertIntegrityResponseFailure(validationResponse(tooMany.toString(), ""), "ARCSUITE_LIMIT_EXCEEDED");
    }

    static void evidenceResponseParsingAndSanitization() {
        String xml = "<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\""
                + ArcSuiteSoapClient.TYPES_NS + "\"><soap:Body><t:getCertificateEvidenceResponse>"
                + "<t:getCertificateEvidenceReturn>"
                + "<t:certEvidence><t:certId>17</t:certId><t:certAttributes><t:certAttribute>"
                + "<t:attribute ns=\"secret\" name=\"certificate-material\"><t:value>synthetic private certAttribute</t:value></t:attribute>"
                + "</t:certAttribute></t:certAttributes></t:certEvidence>"
                + "<t:certEvidence><t:certId>18</t:certId><t:certAttributes/></t:certEvidence>"
                + "</t:getCertificateEvidenceReturn></t:getCertificateEvidenceResponse></soap:Body></soap:Envelope>";
        Map<String, Object> parsed = ArcSuiteSoapClient.parseCertificateEvidence(XmlUtil.parse(xml));
        if (!List.of(17, 18).equals(parsed.get("certIds"))) throw new AssertionError("Evidence IDs were not parsed in order: " + parsed);
        String sanitized = Json.stringify(parsed);
        if (sanitized.contains("certAttribute") || sanitized.contains("certificate-material") || sanitized.contains("synthetic private")) {
            throw new AssertionError("certAttribute crossed the adapter JSON boundary: " + sanitized);
        }

        Map<String, Object> empty = ArcSuiteSoapClient.parseCertificateEvidence(XmlUtil.parse(
                "<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\"" + ArcSuiteSoapClient.TYPES_NS
                        + "\"><soap:Body><t:getCertificateEvidenceResponse><t:getCertificateEvidenceReturn/></t:getCertificateEvidenceResponse></soap:Body></soap:Envelope>"));
        if (!List.of().equals(empty.get("certIds"))) throw new AssertionError("Empty evidence must be preserved: " + empty);

        assertEvidenceResponseFailure(evidenceResponse("<t:certEvidence><t:certId>17</t:certId></t:certEvidence>"), "ARCSUITE_UPSTREAM_ERROR");
        assertEvidenceResponseFailure(evidenceResponse("<t:certEvidence><t:certId>bad</t:certId><t:certAttributes/></t:certEvidence>"), "ARCSUITE_UPSTREAM_ERROR");
        assertEvidenceResponseFailure(evidenceResponse("<t:certEvidence><t:certId>17</t:certId><t:certAttributes/></t:certEvidence>"
                + "<t:certEvidence><t:certId>17</t:certId><t:certAttributes/></t:certEvidence>"), "ARCSUITE_UPSTREAM_ERROR");

        StringBuilder overflow = new StringBuilder();
        for (int i = 0; i < 65; i++) overflow.append("<t:certEvidence><t:certId>").append(i + 1).append("</t:certId><t:certAttributes/></t:certEvidence>");
        assertEvidenceResponseFailure(evidenceResponse(overflow.toString()), "ARCSUITE_LIMIT_EXCEEDED");
    }

    static void integrityOperationAndServiceBounds() {
        if (!ArcSuiteSoapClient.READ_ONLY_OPERATIONS.contains("validateCertificate")
                || !ArcSuiteSoapClient.READ_ONLY_OPERATIONS.contains("getCertificateEvidence")) {
            throw new AssertionError("Both verified integrity reads must be allowlisted");
        }
        for (String forbidden : List.of("calculateCertificateEvidence", "attachTimestamp", "attachTimestampWithOptions")) {
            if (ArcSuiteSoapClient.READ_ONLY_OPERATIONS.contains(forbidden)) throw new AssertionError("Prohibited operation allowlisted: " + forbidden);
        }
        if (ArcSuiteSoapClient.READ_ONLY_OPERATIONS.size() != 26) {
            throw new AssertionError("Expected 26 TypeScript/Java read-only operations, got " + ArcSuiteSoapClient.READ_ONLY_OPERATIONS.size());
        }
    }

    private static String validationResponse(String resultEntries, String failureEntries) {
        return "<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\"" + ArcSuiteSoapClient.TYPES_NS
                + "\" xmlns:xsi=\"" + ArcSuiteSoapClient.XSI_NS + "\"><soap:Body><t:validateCertificateResponse>"
                + "<t:validateCertificateReturn><t:results>" + resultEntries + "</t:results><t:failures>" + failureEntries
                + "</t:failures></t:validateCertificateReturn></t:validateCertificateResponse></soap:Body></soap:Envelope>";
    }

    private static String evidenceResponse(String evidenceEntries) {
        return "<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\"" + ArcSuiteSoapClient.TYPES_NS
                + "\"><soap:Body><t:getCertificateEvidenceResponse><t:getCertificateEvidenceReturn>" + evidenceEntries
                + "</t:getCertificateEvidenceReturn></t:getCertificateEvidenceResponse></soap:Body></soap:Envelope>";
    }

    private static void assertIntegrityResponseFailure(String xml, String expectedCode) {
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseIntegrityValidation(XmlUtil.parse(xml)), expectedCode);
    }

    private static void assertEvidenceResponseFailure(String xml, String expectedCode) {
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseCertificateEvidence(XmlUtil.parse(xml)), expectedCode);
    }

    static void hardReferenceRequestAndSoapEnvelopeShape() throws Exception {
        Map<String, Object> request = Map.of("id", "rep:example:target", "maxResults", 4);
        String body = ArcSuiteSoapClient.hardReferencesBody(request);
        String expected = "<t:id>rep:example:target</t:id>"
                + "<t:attrIds/>"
                + "<t:options>referenceId</t:options>";
        if (!expected.equals(body)) throw new AssertionError("Unexpected Hard Reference request body: " + body);
        if (body.contains("<t:limit>") || body.contains("acl") || body.contains("defaultAcl")
                || body.contains("effectivePrivileges") || body.contains("rmsObjectDnOnly")) {
            throw new AssertionError("Hard Reference request included a limit or forbidden retrieval option");
        }
        if (!ArcSuiteSoapClient.READ_ONLY_OPERATIONS.contains("listRepositoryObjectHardReferences")) {
            throw new AssertionError("Hard Reference operation is not in the read-only allowlist");
        }

        assertHardReferenceSoapEnvelope(request);
    }

    static void assertHardReferenceSoapEnvelope(Map<String, Object> request) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var requestEnvelope = new StringBuilder();
        server.createContext("/", exchange -> {
            requestEnvelope.append(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] response = ("<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\""
                    + ArcSuiteSoapClient.TYPES_NS + "\"><soap:Body><t:listRepositoryObjectHardReferencesResponse>"
                    + "<t:listRepositoryObjectHardReferencesReturn/></t:listRepositoryObjectHardReferencesResponse>"
                    + "</soap:Body></soap:Envelope>").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try {
            var config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/", "synthetic-user", "synthetic-password",
                    "synthetic-internal-token", 18080, "127.0.0.1", Duration.ofSeconds(2), Duration.ofSeconds(2),
                    1500, 1700, 4, "ja", "4.0.0.0", Path.of(System.getProperty("java.io.tmpdir")), 1024 * 1024);
            var result = new ArcSuiteSoapClient(config).hardReferences(request, "synthetic-session");
            if (!List.of().equals(result.get("ids"))) throw new AssertionError("Empty Hard Reference response was not preserved");
            String operationWrapper = "<t:listRepositoryObjectHardReferences><t:id>rep:example:target</t:id>"
                    + "<t:attrIds/><t:options>referenceId</t:options></t:listRepositoryObjectHardReferences>";
            if (!requestEnvelope.toString().contains(operationWrapper)) {
                throw new AssertionError("Unexpected Hard Reference SOAP operation wrapper: " + requestEnvelope);
            }
            if (!requestEnvelope.toString().contains("administratorMode=\"false\"")) {
                throw new AssertionError("ArcSuite administrator mode was not explicitly disabled");
            }
        } finally {
            server.stop(0);
        }
    }

    static void hardReferenceServiceBounds() {
        Map<String,Object> prepared = AdapterService.prepareHardReferenceRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", "rep:example:target", "maxResults", 4));
        if (!Integer.valueOf(4).equals(prepared.get("maxResults"))) throw new AssertionError("Internal candidate bound was not retained");
        expectIllegalArgument(() -> AdapterService.prepareHardReferenceRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", "rep:example:target", "maxResults", 4, "options", List.of("referenceId"))));
        expectIllegalArgument(() -> AdapterService.prepareHardReferenceRequest(Map.of(
                "clientProfileId", "synthetic-client", "id", "rep:example:target", "maxResults", 1001)));
        expectIllegalArgument(() -> ArcSuiteSoapClient.hardReferencesBody(Map.of(
                "id", "rep:example:target", "maxResults", 1001)));
    }

    static void hardReferenceResponseParsing() {
        String responseXml = "<listRepositoryObjectHardReferencesResponse xmlns=\"urn:synthetic\">"
                + "<listRepositoryObjectHardReferencesReturn>"
                + "<repositoryObject><id>rep:example:hardref-001</id><objectClass name=\"reference\"/>"
                + "<referenceId><id>rep:example:target</id><editionKey><attribute ns=\"rep\" name=\"edition\"/></editionKey></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-002</id><objectClass name=\"reference\"/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "</listRepositoryObjectHardReferencesReturn></listRepositoryObjectHardReferencesResponse>";
        var document = XmlUtil.parse(responseXml);
        var returned = XmlUtil.firstDesc(document.getDocumentElement(), "listRepositoryObjectHardReferencesReturn");
        List<String> ids = ArcSuiteSoapClient.parseHardReferenceIds(returned, "rep:example:target", 2);
        if (!List.of("rep:example:hardref-001", "rep:example:hardref-002").equals(ids)) {
            throw new AssertionError("Hard Reference RepositoryObject IDs were not parsed in order: " + ids);
        }
    }

    static void hardReferenceIdentityFailures() {
        assertHardReferenceParseFailure("<return><repositoryObject><id>rep:example:hardref-001</id>"
                + "<referenceId><id>rep:example:other</id></referenceId></repositoryObject></return>", 2, "ARCSUITE_UPSTREAM_ERROR");
        assertHardReferenceParseFailure("<return><repositoryObject><id>rep:example:hardref-001</id></repositoryObject></return>",
                2, "ARCSUITE_UPSTREAM_ERROR");
        assertHardReferenceParseFailure("<return><repositoryObject><id>not-a-repository-id</id>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject></return>", 2, "ARCSUITE_UPSTREAM_ERROR");

        String duplicateXml = "<return><repositoryObject><id>rep:example:hardref-001</id>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-001</id>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject></return>";
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseHardReferenceIds(
                XmlUtil.parse(duplicateXml).getDocumentElement(),
                "rep:example:target", 2), "ARCSUITE_UPSTREAM_ERROR");
    }

    static void hardReferenceOverflowFailsClosed() {
        String overflowXml = "<return><repositoryObject><id>rep:example:hardref-001</id>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-002</id>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-003</id>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject></return>";
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseHardReferenceIds(
                XmlUtil.parse(overflowXml).getDocumentElement(),
                "rep:example:target", 2), "ARCSUITE_LIMIT_EXCEEDED");
    }

    static void assertHardReferenceParseFailure(String xml, int maxResults, String expectedCode) {
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseHardReferenceIds(
                XmlUtil.parse(xml).getDocumentElement(), "rep:example:target", maxResults), expectedCode);
    }

    static void expectAdapterFailure(Runnable operation, String expectedCode) {
        try {
            operation.run();
            throw new AssertionError("Expected adapter failure " + expectedCode);
        } catch (AdapterException failure) {
            if (!expectedCode.equals(failure.code)) throw failure;
        }
    }

    static void expectIllegalArgument(Runnable operation) {
        try {
            operation.run();
            throw new AssertionError("Expected invalid internal Hard Reference request");
        } catch (IllegalArgumentException expectedFailure) {}
    }

    static void contentLabelWireShapes() {
        Map<String, Object> request = Map.of(
                "id", "rep:example:document",
                "contentLabel", Map.of("ns", "rep", "name", "user:EXAMPLE_PREVIEW"),
                "options", List.of("resolveRef", "errorOnOfflineContent")
        );
        String body = ArcSuiteSoapClient.contentRequestBody(request, "rep:example:document");
        String expected = "<t:id>rep:example:document</t:id>"
                + "<t:contentLabels><t:i18nString ns=\"rep\" name=\"user:EXAMPLE_PREVIEW\"/></t:contentLabels>"
                + "<t:options>resolveRef</t:options><t:options>errorOnOfflineContent</t:options>";
        if (!expected.equals(body)) throw new AssertionError("Unexpected content-label request body: " + body);
        if (body.contains("<t:label>") || body.contains("<t:string>")) throw new AssertionError("Unexpected content-label wire shape");
        try {
            ArcSuiteSoapClient.contentRequestBody(Map.of(
                    "id", "rep:example:document",
                    "contentLabel", Map.of("ns", "rep", "name", "user:EXAMPLE_PREVIEW"),
                    "options", List.of("unexpected-option")
            ), "rep:example:document");
            throw new AssertionError("content options must be server-controlled");
        } catch (IllegalArgumentException expectedFailure) {}

        var content = XmlUtil.parse("<content xmlns=\"urn:synthetic\"><label ns=\"rep\" name=\"user:EXAMPLE_PREVIEW\"/></content>").getDocumentElement();
        if (!Map.of("ns", "rep", "name", "user:EXAMPLE_PREVIEW").equals(ArcSuiteSoapClient.parseContentLabel(content))) {
            throw new AssertionError("Content.label was not parsed as an exact I18nString");
        }
        try {
            ArcSuiteSoapClient.assertContentLabelMatches(
                    Map.of("ns", "rep", "name", "user:EXAMPLE_PREVIEW"),
                    Map.of("ns", "other", "name", "user:EXAMPLE_PREVIEW"));
            throw new AssertionError("namespace mismatch must fail closed");
        } catch (AdapterException expectedFailure) {
            if (!"ARCSUITE_UPSTREAM_ERROR".equals(expectedFailure.code)) throw expectedFailure;
        }

        String objectXml = "<repositoryObject xmlns=\"urn:synthetic\">"
                + "<id>rep:example:document</id><objectClass name=\"document\"/>"
                + "<attributes><attribute ns=\"rep\" name=\"system:contentlabellist\">"
                + "<attributeValue xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"I18nStringValues\">"
                + "<i18nStrings ns=\"rep\" name=\"system:primary\"/>"
                + "<i18nStrings ns=\"rep\" name=\"user:EXAMPLE_PREVIEW\"/>"
                + "</attributeValue></attribute></attributes></repositoryObject>";
        Map<String, Object> parsed = ArcSuiteSoapClient.parseRepositoryObject(XmlUtil.parse(objectXml).getDocumentElement());
        Object values = ((Map<?, ?>) parsed.get("attributes")).get("rep:system:contentlabellist");
        if (!(values instanceof Map<?, ?> valueMap) || !"i18n[]".equals(valueMap.get("type"))
                || !(valueMap.get("values") instanceof List<?> list) || list.size() != 2
                || !Map.of("ns", "rep", "name", "user:EXAMPLE_PREVIEW").equals(list.get(1))) {
            throw new AssertionError("content label list was not parsed with namespace and name");
        }
    }

    static void typedAttributeValueShapes() {
        Map<String, Map<String, Object>> values = new LinkedHashMap<>();
        values.put("string", Map.of("type", "string", "value", "a&<b"));
        values.put("boolean", Map.of("type", "boolean", "value", true));
        values.put("int", Map.of("type", "int", "value", -7));
        values.put("long", Map.of("type", "long", "value", 9223372036854775807L));
        values.put("double", Map.of("type", "double", "value", 1.25d));
        values.put("date", Map.of("type", "date", "value", "2026-01-02"));
        values.put("datetime", Map.of("type", "datetime", "value", "2026-01-02T03:04:05Z"));
        values.put("i18n", Map.of("type", "i18n", "ns", "rep", "name", "ACTIVE"));

        Map<String, String> expected = Map.of(
                "string", "<t:attributeValue xsi:type=\"t:StringValue\"><t:string>a&amp;&lt;b</t:string></t:attributeValue>",
                "boolean", "<t:attributeValue xsi:type=\"t:BooleanValue\"><t:boolean>true</t:boolean></t:attributeValue>",
                "int", "<t:attributeValue xsi:type=\"t:IntValue\"><t:int>-7</t:int></t:attributeValue>",
                "long", "<t:attributeValue xsi:type=\"t:LongValue\"><t:long>9223372036854775807</t:long></t:attributeValue>",
                "double", "<t:attributeValue xsi:type=\"t:DoubleValue\"><t:double>1.25</t:double></t:attributeValue>",
                "date", "<t:attributeValue xsi:type=\"t:DateValue\"><t:date>2026-01-02</t:date></t:attributeValue>",
                "datetime", "<t:attributeValue xsi:type=\"t:DateTimeValue\"><t:dateTime>2026-01-02T03:04:05Z</t:dateTime></t:attributeValue>",
                "i18n", "<t:attributeValue xsi:type=\"t:I18nStringValue\"><t:i18nString ns=\"rep\" name=\"ACTIVE\"/></t:attributeValue>"
        );
        for (Map.Entry<String, Map<String, Object>> entry : values.entrySet()) {
            String actual;
            try {
                actual = ArcSuiteSoapClient.attributeValueBody(entry.getValue());
            } catch (IllegalArgumentException error) {
                throw new AssertionError("Missing wire serializer for " + entry.getKey(), error);
            }
            if (!expected.get(entry.getKey()).equals(actual)) throw new AssertionError(entry.getKey() + ": " + actual);
        }
        String extendedDateTime = ArcSuiteSoapClient.attributeValueBody(Map.of(
                "type", "datetime", "value", "2026-01-02T03:04:05+23:00"));
        if (!"<t:attributeValue xsi:type=\"t:DateTimeValue\"><t:dateTime>2026-01-02T03:04:05+23:00</t:dateTime></t:attributeValue>".equals(extendedDateTime)) {
            throw new AssertionError("Unexpected extended datetime: " + extendedDateTime);
        }

        String condition = ArcSuiteSoapClient.attributeConditions("attrCondition", List.of(Map.of(
                "attrId", Map.of("ns", "rep", "name", "system:approved"),
                "operator", "EQUAL",
                "value", values.get("boolean")
        )));
        String expectedCondition = "<t:attrCondition xsi:type=\"t:BinaryOperatorCondition\" mode=\"ONEVAL\" operator=\"EQUAL\">"
                + "<t:attributeId ns=\"rep\" name=\"system:approved\"/>"
                + expected.get("boolean")
                + "</t:attrCondition>";
        if (!expectedCondition.equals(condition)) throw new AssertionError("Unexpected BinaryOperatorCondition: " + condition);
        for (String operator : List.of("LIKE", "GREATER_EQUAL", "LESS_EQUAL")) {
            String wire = ArcSuiteSoapClient.attributeConditions("attrCondition", List.of(Map.of(
                    "attrId", Map.of("ns", "rep", "name", "system:page_count"),
                    "operator", operator,
                    "value", values.get("int")
            )));
            if (!wire.contains("operator=\"" + operator + "\"") || !wire.contains("mode=\"ONEVAL\"")) {
                throw new AssertionError("Unexpected BinaryOperatorCondition operator: " + wire);
            }
        }
        try {
            ArcSuiteSoapClient.attributeConditions("attrCondition", List.of(Map.of(
                    "attrId", Map.of("ns", "rep", "name", "system:page_count"),
                    "operator", "NOT_EQUAL",
                    "value", values.get("int")
            )));
            throw new AssertionError("Unsupported binary operator must be rejected");
        } catch (IllegalArgumentException expectedFailure) {}

        String search = ArcSuiteSoapClient.searchBody(Map.of(
                "text", Map.of("words", List.of("alpha"), "operator", "AND"),
                "mode", "AND",
                "searchRegionIds", List.of("rep:example:cabinet"),
                "depth", 0,
                "textSearchMode", "THESAURUS",
                "order", List.of(),
                "limit", 5,
                "options", List.of()
        ), false);
        String expectedSearch = "<t:textCondition xsi:type=\"t:TextCondition\"><t:wordList operator=\"AND\"><t:word>alpha</t:word></t:wordList></t:textCondition>"
                + "<t:mode>AND</t:mode><t:option><t:searchRegion><t:id>rep:example:cabinet</t:id><t:depth>0</t:depth></t:searchRegion>"
                + "<t:textSearchMode>THESAURUS</t:textSearchMode></t:option><t:limit>5</t:limit>";
        if (!expectedSearch.equals(search)) throw new AssertionError("Unexpected search request body: " + search);
    }

    static void attributeSchemaMetadataParsing() {
        String xml = "<attributeSchema xmlns=\"urn:synthetic\">"
                + "<ns>rep</ns><name>page_count</name><dataType>LONG_TYPE</dataType>"
                + "<nativeDataType>long</nativeDataType><multiValued>false</multiValued><required>true</required>"
                + "<enumerated>true</enumerated><modifiable>false</modifiable><searchable>true</searchable><sortable>true</sortable>"
                + "<minLength>1</minLength><maxLength>20</maxLength><minCount>1</minCount><maxCount>1</maxCount>"
                + "<minIntegralValue>0</minIntegralValue><maxIntegralValue>9223372036854775807</maxIntegralValue>"
                + "<minFloatingValue>0.5</minFloatingValue><maxFloatingValue>9.25</maxFloatingValue>"
                + "<minInclusive>true</minInclusive><maxInclusive>false</maxInclusive><pattern>^[0-9]+$</pattern>"
                + "<enumLabels><i18nString ns=\"rep\" name=\"ACTIVE\"><label lang=\"ja\">有効</label></i18nString>"
                + "<i18nString ns=\"rep\" name=\"RETIRED\"><label lang=\"en\">Retired</label></i18nString></enumLabels>"
                + "</attributeSchema>";
        Map<String, Object> parsed = ArcSuiteSoapClient.parseAttributeSchema(XmlUtil.parse(xml).getDocumentElement());
        for (Map.Entry<String, Object> expected : Map.<String, Object>ofEntries(
                Map.entry("ns", "rep"), Map.entry("name", "page_count"), Map.entry("dataType", "LONG_TYPE"),
                Map.entry("nativeDataType", "long"), Map.entry("multiValued", false), Map.entry("required", true),
                Map.entry("enumerated", true), Map.entry("modifiable", false), Map.entry("searchable", true), Map.entry("sortable", true),
                Map.entry("minLength", 1), Map.entry("maxLength", 20), Map.entry("minCount", 1), Map.entry("maxCount", 1),
                Map.entry("minIntegralValue", "0"), Map.entry("maxIntegralValue", "9223372036854775807"),
                Map.entry("minFloatingValue", 0.5d), Map.entry("maxFloatingValue", 9.25d),
                Map.entry("minInclusive", true), Map.entry("maxInclusive", false), Map.entry("pattern", "^[0-9]+$")
        ).entrySet()) {
            if (!expected.getValue().equals(parsed.get(expected.getKey()))) {
                throw new AssertionError(expected.getKey() + ": " + parsed.get(expected.getKey()));
            }
        }
        Object labels = parsed.get("enumLabels");
        if (!(labels instanceof List<?> list) || list.size() != 2) throw new AssertionError("enumLabels: " + labels);
        if (!Map.of("ns", "rep", "name", "ACTIVE", "label", "有効").equals(list.get(0))) throw new AssertionError(String.valueOf(list.get(0)));
        if (!Map.of("ns", "rep", "name", "RETIRED", "label", "Retired").equals(list.get(1))) throw new AssertionError(String.valueOf(list.get(1)));
    }

    static void responseIdParsing() {
        String searchXml = "<root xmlns=\"urn:test\"><searchRepositoryObjectIdsReturn><result><ids><id>rep:example:one</id><id>rep:example:two</id></ids></result></searchRepositoryObjectIdsReturn></root>";
        String listXml = "<root xmlns=\"urn:test\"><listRepositoryObjectIdsReturn><result><ids><id>rep:example:three</id><id>rep:example:four</id></ids></result></listRepositoryObjectIdsReturn></root>";
        var searchResult = XmlUtil.firstDesc(XmlUtil.parse(searchXml).getDocumentElement(), "result");
        var listResult = XmlUtil.firstDesc(XmlUtil.parse(listXml).getDocumentElement(), "result");
        if (!List.of("rep:example:one", "rep:example:two").equals(ArcSuiteSoapClient.parseStringArray(searchResult))) {
            throw new AssertionError("Unexpected search ID response parsing");
        }
        if (!List.of("rep:example:three", "rep:example:four").equals(ArcSuiteSoapClient.parseStringArray(listResult))) {
            throw new AssertionError("Unexpected list ID response parsing");
        }
    }

    static void xmlXxeBlocked() {
        try {
            XmlUtil.parse("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>");
            throw new AssertionError("DOCTYPE should be rejected");
        } catch (AdapterException expected) {}
    }

    static void boundedStreams() throws Exception {
        byte[] request = InternalServer.readBounded(new ByteArrayInputStream("1234".getBytes(StandardCharsets.UTF_8)), 4);
        if (!"1234".equals(new String(request, StandardCharsets.UTF_8))) throw new AssertionError();
        try {
            InternalServer.readBounded(new ByteArrayInputStream("12345".getBytes(StandardCharsets.UTF_8)), 4);
            throw new AssertionError("oversized internal request should be rejected");
        } catch (IllegalArgumentException expected) {}
        try {
            ArcSuiteSoapClient.readBounded(new ByteArrayInputStream("12345".getBytes(StandardCharsets.UTF_8)), 4);
            throw new AssertionError("oversized SOAP response should be rejected");
        } catch (AdapterException expected) {
            if (!"ARCSUITE_LIMIT_EXCEEDED".equals(expected.code)) throw expected;
        }
        CloseTrackingInputStream response = new CloseTrackingInputStream("response".getBytes(StandardCharsets.UTF_8));
        if (!"response".equals(new String(ArcSuiteSoapClient.readAndClose(response, 64), StandardCharsets.UTF_8)) || !response.closed) {
            throw new AssertionError("SOAP response stream was not closed after materialization");
        }
    }

    static byte[] unsigned(byte[] b) {
        if (b.length > 1 && b[0] == 0) return java.util.Arrays.copyOfRange(b,1,b.length);
        return b;
    }

    static final class CloseTrackingInputStream extends ByteArrayInputStream {
        boolean closed;
        CloseTrackingInputStream(byte[] data) { super(data); }
        @Override public void close() throws IOException { closed = true; super.close(); }
    }
}
