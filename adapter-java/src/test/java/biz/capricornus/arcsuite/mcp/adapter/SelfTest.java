package biz.capricornus.arcsuite.mcp.adapter;

import com.sun.net.httpserver.HttpServer;
import javax.crypto.Cipher;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class SelfTest {
    public static void main(String[] args) throws Exception {
        jsonRoundTrip();
        cryptoRoundTrip();
        mtomDecode();
        soapRequestShapes();
        effectiveObjectPathIdentity();
        sessionRetryAttemptBounds();
        hardReferenceContractShapes();
        documentIntegrityContractShapes();
        contentLabelWireShapes();
        objectClassContractShapes();
        contentRequestContract();
        typedAttributeValueShapes();
        attributeSchemaMetadataParsing();
        responseIdParsing();
        revisionContractParsing();
        xmlXxeBlocked();
        boundedStreams();
        System.out.println("Java adapter self-test: PASS");
    }

    static void jsonRoundTrip() {
        Object v = Json.parse("{\"a\":1,\"b\":[true,\"x\"]}");
        String out = Json.stringify(v);
        if (!out.contains("\"a\":1")) throw new AssertionError(out);

        if (!(Json.parse("10") instanceof Long) || !(Json.parse("-10") instanceof Long)) {
            throw new AssertionError("Integral JSON values must remain Long");
        }
        if (!(Json.parse("10.5") instanceof Double) || !(Json.parse("1e2") instanceof Double)) {
            throw new AssertionError("Floating JSON values must remain Double");
        }

        String intRequest = "{\"attributeConditions\":[{\"attrId\":{\"ns\":\"rep\",\"name\":\"user:count\"},\"operator\":\"EQUAL\",\"value\":{\"type\":\"int\",\"value\":10}}],\"limit\":5,\"mode\":\"AND\"}";
        Map<String, Object> parsedIntRequest = Json.object(Json.parse(intRequest));
        String intBody = ArcSuiteSoapClient.searchBody(parsedIntRequest, false);
        if (!intBody.contains("<t:attributeValue xsi:type=\"t:IntValue\"><t:int>10</t:int></t:attributeValue>")) {
            throw new AssertionError("INT search JSON did not reach the expected SOAP value: " + intBody);
        }

        String longRequest = "{\"attributeConditions\":[{\"attrId\":{\"ns\":\"rep\",\"name\":\"user:count\"},\"operator\":\"EQUAL\",\"value\":{\"type\":\"long\",\"value\":10}}],\"limit\":5,\"mode\":\"AND\"}";
        Map<String, Object> parsedLongRequest = Json.object(Json.parse(longRequest));
        String longBody = ArcSuiteSoapClient.searchBody(parsedLongRequest, false);
        if (!longBody.contains("<t:attributeValue xsi:type=\"t:LongValue\"><t:long>10</t:long></t:attributeValue>")) {
            throw new AssertionError("LONG search JSON did not reach the expected SOAP value: " + longBody);
        }

        Map<String, Object> doubleValue = Json.object(Json.parse("{\"type\":\"double\",\"value\":10.5}"));
        if (!ArcSuiteSoapClient.attributeValueBody(doubleValue).contains("<t:double>10.5</t:double>")) {
            throw new AssertionError("DOUBLE search value changed during JSON parsing");
        }
    }

    static void cryptoRoundTrip() throws Exception {
        var generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        var pair = generator.generateKeyPair();
        var pub = (RSAPublicKey) pair.getPublic();
        byte[] modulus = unsigned(pub.getModulus().toByteArray());
        byte[] exponent = unsigned(pub.getPublicExponent().toByteArray());
        if ((modulus[0] & 0x80) == 0) throw new AssertionError("synthetic modulus did not exercise a positive BigInteger boundary");

        String challenge = "challenge-日本語🚀";
        String credentialSuffix = "password-パスワード🔐";
        String modulusB64 = Base64.getEncoder().encodeToString(modulus);
        String exponentB64 = Base64.getEncoder().encodeToString(exponent);
        String encrypted = Crypto.encryptCredential(challenge, credentialSuffix, modulusB64, exponentB64);
        byte[] ciphertext = Base64.getDecoder().decode(encrypted);
        byte[] expected = (challenge + credentialSuffix).getBytes(StandardCharsets.UTF_8);

        var productionCipher = Crypto.credentialCipher(Cipher.DECRYPT_MODE, pair.getPrivate());
        if (!"RSA/ECB/PKCS1Padding".equals(productionCipher.getAlgorithm())) {
            throw new AssertionError("Unexpected credential transformation: " + productionCipher.getAlgorithm());
        }

        var independentCipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        independentCipher.init(Cipher.DECRYPT_MODE, pair.getPrivate());
        byte[] plain = independentCipher.doFinal(ciphertext);
        if (!java.util.Arrays.equals(expected, plain)) {
            throw new AssertionError("Credential plaintext did not preserve UTF-8 challenge/password concatenation");
        }
    }

    static void mtomDecode() {
        String boundary="test-boundary";
        byte[] root = ("--"+boundary+"\r\nContent-Type: application/xop+xml; charset=UTF-8; type=\"text/xml\"\r\nContent-ID: <root>\r\n\r\n<Envelope><data><xop:Include xmlns:xop=\"http://www.w3.org/2004/08/xop/include\" href=\"cid:bin\"/></data></Envelope>\r\n--"+boundary+"\r\nContent-Type: application/octet-stream\r\nContent-ID: <bin>\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1);
        byte[] suffix = ("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.ISO_8859_1);
        String contentType = "multipart/related; boundary=\""+boundary+"\"";
        for (byte[] payload : List.of(
                new byte[0], "ABC123".getBytes(StandardCharsets.ISO_8859_1),
                new byte[]{'A','B','C','\n'}, new byte[]{'A','B','C','\r'},
                new byte[]{'A','B','C','\r','\n'}, new byte[]{'A','\r','\n','\r','\n'},
                new byte[]{0, (byte) 0xff, 1, 2, '\r', '\n'},
                ("inside--"+boundary+"-not-a-delimiter").getBytes(StandardCharsets.ISO_8859_1))) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            bytes.writeBytes(root);
            bytes.writeBytes(payload);
            bytes.writeBytes(suffix);
            MtomMessage m=MtomParser.parse(contentType,bytes.toByteArray());
            if(!java.util.Arrays.equals(payload, m.attachments().get("bin"))) throw new AssertionError("MTOM payload changed: " + java.util.Arrays.toString(payload));
        }

        ByteArrayOutputStream leadingCrlf = new ByteArrayOutputStream();
        leadingCrlf.writeBytes("\r\n".getBytes(StandardCharsets.ISO_8859_1));
        leadingCrlf.writeBytes(root);
        leadingCrlf.writeBytes("leading-crlf".getBytes(StandardCharsets.ISO_8859_1));
        leadingCrlf.writeBytes(suffix);
        MtomMessage parsedLeadingCrlf = MtomParser.parse(contentType, leadingCrlf.toByteArray());
        if (!java.util.Arrays.equals("leading-crlf".getBytes(StandardCharsets.ISO_8859_1), parsedLeadingCrlf.attachments().get("bin"))) {
            throw new AssertionError("Exactly one leading CRLF was not accepted");
        }

        for (byte[] invalidPrefix : List.of(
                "\n".getBytes(StandardCharsets.ISO_8859_1),
                "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1),
                "synthetic-preamble\r\n".getBytes(StandardCharsets.ISO_8859_1))) {
            ByteArrayOutputStream invalid = new ByteArrayOutputStream();
            invalid.writeBytes(invalidPrefix);
            invalid.writeBytes(root);
            invalid.writeBytes("invalid-prefix".getBytes(StandardCharsets.ISO_8859_1));
            invalid.writeBytes(suffix);
            expectAdapterFailure(() -> MtomParser.parse(contentType, invalid.toByteArray()), "ARCSUITE_UPSTREAM_ERROR");
        }
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

    static void effectiveObjectPathIdentity() throws Exception {
        String sourceId = "rep:mock:EXAMPLE_CABINET:reference-001";
        String effectiveId = "rep:mock:EXAMPLE_CABINET:document-002";
        AtomicReference<String> returnedObjectId = new AtomicReference<>(effectiveId);
        AtomicReference<String> pathRequestId = new AtomicReference<>();
        AtomicReference<String> pathResponse = new AtomicReference<>("<t:getRepositoryObjectPathResponse><t:getRepositoryObjectPathReturn><t:objects/><t:fullPath>true</t:fullPath></t:getRepositoryObjectPathReturn></t:getRepositoryObjectPathResponse>");
        AtomicInteger pathCalls = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/soap", exchange -> {
            String request = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            boolean pathRequest = request.contains("<t:getRepositoryObjectPath>");
            String response;
            if (pathRequest) {
                pathCalls.incrementAndGet();
                var parsed = XmlUtil.parse(request);
                pathRequestId.set(XmlUtil.firstDesc(parsed.getDocumentElement(), ArcSuiteSoapClient.TYPES_NS, "id").getTextContent());
                response = soapEnvelope(pathResponse.get());
            } else {
                String id = returnedObjectId.get();
                String identity = id == null ? "" : "<t:id>" + XmlUtil.esc(id) + "</t:id>";
                response = soapEnvelope("<t:getRepositoryObjectResponse><t:getRepositoryObjectReturn>" + identity
                        + "<t:objectClass ns=\"rep\" name=\"system:document\"/><t:attributes/></t:getRepositoryObjectReturn></t:getRepositoryObjectResponse>");
            }
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        Path temp = Files.createTempDirectory("arcsuite-effective-id-");
        try {
            AdapterConfig config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/soap",
                    "synthetic-user", "synthetic-password", "synthetic-token", 0, "127.0.0.1",
                    Duration.ofSeconds(2), Duration.ofSeconds(2), 3600, 7200, 1, "ja", "4.0.0.0", temp, 1024 * 1024);
            ArcSuiteSoapClient client = new ArcSuiteSoapClient(config);
            Map<String, Object> request = Map.of(
                    "id", sourceId,
                    "resolveRef", true,
                    "includePath", true,
                    "attrIds", List.of(),
                    "options", List.of());

            Map<String, Object> resolved = client.get(request, "synthetic-session");
            if (!effectiveId.equals(resolved.get("id"))) throw new AssertionError("Resolved object identity was lost: " + resolved);
            if (!effectiveId.equals(pathRequestId.get())) throw new AssertionError("Path was requested for " + pathRequestId.get() + " instead of " + effectiveId);

            pathResponse.set("<t:getRepositoryObjectPathResponse><t:getRepositoryObjectPathReturn><t:objects/></t:getRepositoryObjectPathReturn></t:getRepositoryObjectPathResponse>");
            expectAdapterFailure(() -> client.get(request, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            pathResponse.set("<t:getRepositoryObjectPathResponse><t:result><t:objects/><t:fullPath>true</t:fullPath></t:result></t:getRepositoryObjectPathResponse>");
            expectAdapterFailure(() -> client.get(request, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            pathResponse.set("<t:getRepositoryObjectPathResponse><t:getRepositoryObjectPathReturn><t:objects/><t:fullPath>true</t:fullPath></t:getRepositoryObjectPathReturn></t:getRepositoryObjectPathResponse>");

            Map<String, Object> unresolvedRequest = Map.of(
                    "id", sourceId,
                    "resolveRef", false,
                    "includePath", true,
                    "attrIds", List.of(),
                    "options", List.of());
            pathCalls.set(0);
            pathRequestId.set(null);
            expectAdapterFailure(() -> client.get(unresolvedRequest, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            if (pathCalls.get() != 0) throw new AssertionError("Path lookup was dispatched for an unexpected unresolved identity");

            for (String invalidId : List.of("not-a-repository-id", "")) {
                returnedObjectId.set(invalidId.isEmpty() ? null : invalidId);
                pathCalls.set(0);
                pathRequestId.set(null);
                expectAdapterFailure(() -> client.get(request, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
                if (pathCalls.get() != 0) throw new AssertionError("Path lookup was dispatched without a valid effective identity");
            }
        } finally {
            server.stop(0);
            Files.deleteIfExists(temp);
        }
    }

    private static String soapEnvelope(String body) {
        return "<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><soap:Body>" + body + "</soap:Body></soap:Envelope>";
    }

    static void sessionRetryAttemptBounds() throws Exception {
        var generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        var publicKey = (RSAPublicKey) generator.generateKeyPair().getPublic();
        String modulus = Base64.getEncoder().encodeToString(unsigned(publicKey.getModulus().toByteArray()));
        String exponent = Base64.getEncoder().encodeToString(unsigned(publicKey.getPublicExponent().toByteArray()));

        if (runSessionRead(0, modulus, exponent) != 1) throw new AssertionError("A successful read must make one business SOAP call");
        if (runSessionRead(1, modulus, exponent) != 2) throw new AssertionError("One expired session must permit exactly one refreshed retry");
        if (runSessionRead(2, modulus, exponent) != 2) throw new AssertionError("A second expiry must stop after two business SOAP calls");
    }

    private static int runSessionRead(int expiredAttempts, String modulus, String exponent) throws Exception {
        AtomicInteger businessCalls = new AtomicInteger();
        AtomicInteger logins = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/soap", exchange -> {
            String request = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String response;
            int status = 200;
            if (request.contains("<t:getLoginInfo>")) {
                int sessionNumber = logins.incrementAndGet();
                response = soapEnvelope("<t:getLoginInfoResponse><t:result><t:sessionId>session-" + sessionNumber
                        + "</t:sessionId><t:challenge>synthetic-challenge</t:challenge><t:publicKeyModulus>" + modulus
                        + "</t:publicKeyModulus><t:publicKeyExponent>" + exponent
                        + "</t:publicKeyExponent><t:curVersion>4.0.0.0</t:curVersion></t:result></t:getLoginInfoResponse>");
            } else if (request.contains("<t:login>")) {
                response = soapEnvelope("<t:loginResponse><t:result>synthetic-user-dn</t:result></t:loginResponse>");
            } else if (request.contains("<t:getRepositoryObject>")) {
                int attempt = businessCalls.incrementAndGet();
                if (attempt <= expiredAttempts) {
                    status = 500;
                    response = attempt == 1
                            ? soapEnvelope("<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Processing failed</faultstring>"
                                    + "<detail><t:ProcessingException><t:code>ARCSUITE_WS-08302001</t:code></t:ProcessingException></detail></soap:Fault>")
                            : soapEnvelope("<soap:Fault><faultcode>soap:Server</faultcode><faultstring>ARCSUITE_WS-08302001</faultstring></soap:Fault>");
                } else {
                    response = soapEnvelope("<t:getRepositoryObjectResponse><t:getRepositoryObjectReturn><t:id>rep:mock:EXAMPLE_CABINET:1001</t:id><t:objectClass ns=\"rep\" name=\"system:document\"/><t:attributes/></t:getRepositoryObjectReturn></t:getRepositoryObjectResponse>");
                }
            } else {
                response = soapEnvelope("<t:logoutResponse/>");
            }
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        Path temp = Files.createTempDirectory("arcsuite-session-retry-");
        try {
            AdapterConfig config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/soap",
                    "synthetic-user", "synthetic-password", "synthetic-token", 0, "127.0.0.1",
                    Duration.ofSeconds(2), Duration.ofSeconds(2), 3600, 7200, 1, "ja", "4.0.0.0", temp, 1024 * 1024);
            ArcSuiteSoapClient client = new ArcSuiteSoapClient(config);
            try (SessionManager sessions = new SessionManager(config, client)) {
                Map<String, Object> request = Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "resolveRef", false,
                        "includePath", false, "attrIds", List.of(), "options", List.of());
                if (expiredAttempts < 2) {
                    Map<String, Object> result = sessions.read("synthetic-profile", session -> client.get(request, session));
                    if (!"rep:mock:EXAMPLE_CABINET:1001".equals(result.get("id"))) throw new AssertionError("Read returned the wrong identity");
                } else {
                    expectAdapterFailure(() -> sessions.read("synthetic-profile", session -> client.get(request, session)), "ARCSUITE_SESSION_EXPIRED");
                }
            }
            return businessCalls.get();
        } finally {
            server.stop(0);
            Files.deleteIfExists(temp);
        }
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
                        + "<t:results xsi:type=\"types:XAdESValidateResult\"><t:certId>17</t:certId><t:result>true</t:result><t:signer>synthetic signer</t:signer></t:results>"
                        + "<t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>18</t:certId><t:result>false</t:result><t:signer>synthetic signer</t:signer><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>"
                        + "<t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>19</t:certId><t:result>true</t:result>"
                        + "<t:exception><t:code>ARCSUITE_WS-08305101</t:code><t:message>synthetic private exception</t:message></t:exception><t:signer>synthetic signer</t:signer></t:results>"
                        + "<t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>20</t:certId><t:result>false</t:result>"
                        + "<t:exception><t:code>ARCSUITE_WS-08305102</t:code></t:exception><t:signer>synthetic signer</t:signer><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>"
                        + "<t:results xsi:type=\"t:PAdESValidateResult\"><t:certId>21</t:certId><t:result>true</t:result><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>"
                        + "<t:results xsi:type=\"t:PAdESValidateResult\"><t:certId>22</t:certId><t:result>false</t:result>"
                        + "<t:exception><t:code>ARCSUITE_WS-08305103</t:code></t:exception><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>"
                        + "<t:results xsi:type=\"t:DocumentTimestampValidateResult\"><t:certId>23</t:certId><t:result>true</t:result><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>"
                        + "<t:results xsi:type=\"t:DocumentTimestampValidateResult\"><t:certId>24</t:certId><t:result>false</t:result>"
                        + "<t:exception><t:code>ARCSUITE_WS-08305104</t:code></t:exception><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>"
                        + "</t:certValidElements></t:results>",
                "");
        Map<String, Object> parsed = ArcSuiteSoapClient.parseIntegrityValidation(XmlUtil.parse(success));
        Object rawCertificates = parsed.get("certificates");
        if (!(rawCertificates instanceof List<?> certificates) || certificates.size() != 8) {
            throw new AssertionError("Expected eight validation elements: " + parsed);
        }
        Map<?, ?> first = (Map<?, ?>) certificates.get(0);
        if (!Integer.valueOf(17).equals(first.get("certId")) || !Boolean.TRUE.equals(first.get("result"))
                || !Boolean.FALSE.equals(first.get("exceptionPresent"))) throw new AssertionError("Unexpected first certificate result: " + first);
        Map<?, ?> second = (Map<?, ?>) certificates.get(1);
        Map<?, ?> fourth = (Map<?, ?>) certificates.get(3);
        Map<?, ?> fifth = (Map<?, ?>) certificates.get(4);
        Map<?, ?> eighth = (Map<?, ?>) certificates.get(7);
        if (!Integer.valueOf(18).equals(second.get("certId")) || !Boolean.FALSE.equals(second.get("result"))
                || !Boolean.FALSE.equals(second.get("exceptionPresent"))) throw new AssertionError("Unexpected second certificate result: " + second);
        if (!Integer.valueOf(20).equals(fourth.get("certId")) || !Boolean.FALSE.equals(fourth.get("result"))
                || !Boolean.TRUE.equals(fourth.get("exceptionPresent"))) throw new AssertionError("Unexpected XAdES exception result: " + fourth);
        if (!Integer.valueOf(21).equals(fifth.get("certId")) || !Boolean.TRUE.equals(fifth.get("result"))
                || !Boolean.FALSE.equals(fifth.get("exceptionPresent"))) throw new AssertionError("Unexpected PAdES result: " + fifth);
        if (!Integer.valueOf(24).equals(eighth.get("certId")) || !Boolean.FALSE.equals(eighth.get("result"))
                || !Boolean.TRUE.equals(eighth.get("exceptionPresent"))) throw new AssertionError("Unexpected document timestamp result: " + eighth);
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
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:UnknownValidateResult\"><t:certId>17</t:certId><t:result>true</t:result><t:signer>unexpected</t:signer></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:exception/><t:result>true</t:result></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"wrong:XAdESValidateResult\" xmlns:wrong=\"urn:wrong\"><t:certId>17</t:certId><t:result>true</t:result><t:signer>x</t:signer></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:result>true</t:result></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:result>true</t:result><t:signer>x</t:signer><t:exception/></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results><t:certId>17</t:certId><t:result>true</t:result><t:signer>x</t:signer></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:result>true</t:result><t:signer>x</t:signer><t:unexpected/></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:result>true</t:result><t:unexpected/><t:signer>x</t:signer></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure(validationResponse(
                "<t:results><t:certValidElements><t:results xsi:type=\"t:XAdESValidateResult\"><t:certId>17</t:certId><t:certId>18</t:certId><t:result>true</t:result><t:signer>x</t:signer></t:results></t:certValidElements></t:results>",
                ""), "ARCSUITE_UPSTREAM_ERROR");
        assertIntegrityResponseFailure("<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS
                + "\"><soap:Body><unexpectedResponse/></soap:Body></soap:Envelope>", "ARCSUITE_UPSTREAM_ERROR");

        StringBuilder tooMany = new StringBuilder("<t:results><t:certValidElements>");
        for (int i = 0; i < 65; i++) tooMany.append("<t:results xsi:type=\"t:PAdESValidateResult\"><t:certId>").append(i + 1)
                .append("</t:certId><t:result>true</t:result><t:timestampDate>2026-09-15T00:00:00Z</t:timestampDate></t:results>");
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
                + "\" xmlns:types=\"" + ArcSuiteSoapClient.TYPES_NS
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
        var responseBody = new AtomicReference<>(
                "<t:listRepositoryObjectHardReferencesResponse><t:listRepositoryObjectHardReferencesReturn/></t:listRepositoryObjectHardReferencesResponse>");
        server.createContext("/", exchange -> {
            requestEnvelope.append(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] response = ("<soap:Envelope xmlns:soap=\"" + ArcSuiteSoapClient.SOAP_NS + "\" xmlns:t=\""
                    + ArcSuiteSoapClient.TYPES_NS + "\"><soap:Body>" + responseBody.get()
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
            ArcSuiteSoapClient client = new ArcSuiteSoapClient(config);
            for (String invalidResponse : List.of(
                    "<bad:listRepositoryObjectHardReferencesResponse xmlns:bad=\"urn:wrong\"><bad:listRepositoryObjectHardReferencesReturn/></bad:listRepositoryObjectHardReferencesResponse>",
                    "<t:listRepositoryObjectHardReferencesResponse><t:result/></t:listRepositoryObjectHardReferencesResponse>",
                    "<t:listRepositoryObjectHardReferencesResponse><t:listRepositoryObjectHardReferencesReturn/><t:extra/></t:listRepositoryObjectHardReferencesResponse>",
                    "<t:listRepositoryObjectHardReferencesResponse><t:listRepositoryObjectHardReferencesReturn><bad:repositoryObject xmlns:bad=\"urn:wrong\"/></t:listRepositoryObjectHardReferencesReturn></t:listRepositoryObjectHardReferencesResponse>",
                    "<t:listRepositoryObjectHardReferencesResponse><t:listRepositoryObjectHardReferencesReturn>unexpected</t:listRepositoryObjectHardReferencesReturn></t:listRepositoryObjectHardReferencesResponse>")) {
                responseBody.set(invalidResponse);
                expectAdapterFailure(() -> client.hardReferences(request, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            }
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
        String responseXml = "<listRepositoryObjectHardReferencesResponse xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\">"
                + "<listRepositoryObjectHardReferencesReturn>"
                + "<repositoryObject><id>rep:example:hardref-001</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id><editionKey><attribute ns=\"rep\" name=\"edition\"/></editionKey></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-002</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "</listRepositoryObjectHardReferencesReturn></listRepositoryObjectHardReferencesResponse>";
        var document = XmlUtil.parse(responseXml);
        var returned = XmlUtil.firstDesc(document.getDocumentElement(), ArcSuiteSoapClient.TYPES_NS, "listRepositoryObjectHardReferencesReturn");
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

        String duplicateXml = "<return xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><repositoryObject><id>rep:example:hardref-001</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-001</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject></return>";
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseHardReferenceIds(
                XmlUtil.parse(duplicateXml).getDocumentElement(),
                "rep:example:target", 2), "ARCSUITE_UPSTREAM_ERROR");
    }

    static void hardReferenceOverflowFailsClosed() {
        String overflowXml = "<return xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><repositoryObject><id>rep:example:hardref-001</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-002</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject>"
                + "<repositoryObject><id>rep:example:hardref-003</id><objectClass ns=\"rep\" name=\"system:reference\"/><attributes/>"
                + "<referenceId><id>rep:example:target</id></referenceId></repositoryObject></return>";
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseHardReferenceIds(
                XmlUtil.parse(overflowXml).getDocumentElement(),
                "rep:example:target", 2), "ARCSUITE_LIMIT_EXCEEDED");
    }

    static void assertHardReferenceParseFailure(String xml, int maxResults, String expectedCode) {
        String responseXml = xml.replace("<return>", "<return xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\">");
        expectAdapterFailure(() -> ArcSuiteSoapClient.parseHardReferenceIds(
                XmlUtil.parse(responseXml).getDocumentElement(), "rep:example:target", maxResults), expectedCode);
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
                "options", List.of("errorOnOfflineContent")
        );
        String body = ArcSuiteSoapClient.contentRequestBody(request, "rep:example:document");
        String expected = "<t:id>rep:example:document</t:id>"
                + "<t:contentLabels><t:i18nString ns=\"rep\" name=\"user:EXAMPLE_PREVIEW\"/></t:contentLabels>"
                + "<t:options>errorOnOfflineContent</t:options>";
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

        var content = XmlUtil.parse("<content xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><label ns=\"rep\" name=\"user:EXAMPLE_PREVIEW\"/></content>").getDocumentElement();
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

        String objectXml = "<repositoryObject xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\">"
                + "<id>rep:example:document</id><objectClass ns=\"rep\" name=\"system:document\"/>"
                + "<attributes><attribute ns=\"rep\" name=\"system:contentlabellist\">"
                + "<attributeValue xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"t:I18nStringValues\" xmlns:t=\"" + ArcSuiteSoapClient.TYPES_NS + "\">"
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

    static void objectClassContractShapes() {
        String valid = "<repositoryObject xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><id>rep:example:document-001</id>"
                + "<objectClass ns=\"rep\" name=\"system:document\"/><attributes/></repositoryObject>";
        Map<String, Object> parsed = ArcSuiteSoapClient.parseRepositoryObject(XmlUtil.parse(valid).getDocumentElement());
        if (!"document".equals(parsed.get("objectClass"))
                || !Map.of("ns", "rep", "name", "system:document").equals(parsed.get("nativeObjectClass"))) {
            throw new AssertionError("Native object class identity was not preserved: " + parsed);
        }
        for (String invalidClass : List.of(
                "<objectClass ns=\"wrong\" name=\"system:document\"/>",
                "<objectClass name=\"system:document\"/>")) {
            String xml = "<repositoryObject xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><id>rep:example:document-001</id>"
                    + invalidClass + "<attributes/></repositoryObject>";
            expectAdapterFailure(() -> ArcSuiteSoapClient.parseRepositoryObject(XmlUtil.parse(xml).getDocumentElement()), "ARCSUITE_UPSTREAM_ERROR");
        }
        String unknown = "<repositoryObject xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\"><id>rep:example:document-001</id>"
                + "<objectClass ns=\"rep\" name=\"system:futureDocument\"/><attributes/></repositoryObject>";
        Map<String, Object> unknownParsed = ArcSuiteSoapClient.parseRepositoryObject(XmlUtil.parse(unknown).getDocumentElement());
        if (!"unknown".equals(unknownParsed.get("objectClass"))
                || !Map.of("ns", "rep", "name", "system:futureDocument").equals(unknownParsed.get("nativeObjectClass"))) {
            throw new AssertionError("Unknown native object class was not isolated as unknown: " + unknownParsed);
        }
    }

    static void contentRequestContract() throws Exception {
        String requestedId = "rep:example:reference-001";
        String effectiveId = "rep:example:document-001";
        Map<String, Object> request = new LinkedHashMap<>(Map.of(
                "clientProfileId", "synthetic-client",
                "requestedId", requestedId,
                "effectiveId", effectiveId,
                "revisionNumber", 3,
                "contentWireId", effectiveId + ":3",
                "contentLabel", Map.of("ns", "rep", "name", "system:primary"),
                "options", List.of("errorOnOfflineContent"),
                "traceId", "synthetic-trace"));
        Map<String, Object> prepared = AdapterService.prepareContentRequest(request);
        if (!requestedId.equals(prepared.get("requestedId"))
                || !effectiveId.equals(prepared.get("effectiveId"))
                || !Integer.valueOf(3).equals(prepared.get("revisionNumber"))
                || !(effectiveId + ":3").equals(prepared.get("contentWireId"))) {
            throw new AssertionError("Content request identities were not preserved: " + prepared);
        }

        Map<String, Object> wrongWire = new LinkedHashMap<>(request);
        wrongWire.put("contentWireId", effectiveId + ":4");
        expectIllegalArgument(() -> AdapterService.prepareContentRequest(wrongWire));
        Map<String, Object> forbiddenOption = new LinkedHashMap<>(request);
        forbiddenOption.put("options", List.of("resolveRef"));
        expectIllegalArgument(() -> AdapterService.prepareContentRequest(forbiddenOption));
        Map<String, Object> extraField = new LinkedHashMap<>(request);
        extraField.put("id", requestedId);
        expectIllegalArgument(() -> AdapterService.prepareContentRequest(extraField));

        AtomicInteger dispatches = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/soap", exchange -> {
            dispatches.incrementAndGet();
            exchange.sendResponseHeaders(500, -1);
            exchange.close();
        });
        server.start();
        try {
            AdapterConfig config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/soap",
                    "synthetic-user", "synthetic-password", "synthetic-token", 0, "127.0.0.1",
                    Duration.ofSeconds(2), Duration.ofSeconds(2), 3600, 7200, 1, "ja", "4.0.0.0",
                    Path.of(System.getProperty("java.io.tmpdir")), 1024 * 1024);
            ArcSuiteSoapClient client = new ArcSuiteSoapClient(config);
            try (SessionManager sessions = new SessionManager(config, client)) {
                AdapterService service = new AdapterService(client, sessions);
                Map<String, Object> invalid = new LinkedHashMap<>(request);
                invalid.put("contentWireId", effectiveId + ":4");
                expectIllegalArgument(() -> service.content(invalid));
            }
            if (dispatches.get() != 0) throw new AssertionError("Invalid content identity reached SOAP dispatch");
        } finally {
            server.stop(0);
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
        String xml = "<attributeSchema xmlns=\"" + ArcSuiteSoapClient.TYPES_NS + "\">"
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

    static void responseIdParsing() throws Exception {
        AtomicReference<String> response = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/soap", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] bytes = soapEnvelope(response.get()).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        Path temp = Files.createTempDirectory("arcsuite-id-response-");
        try {
            AdapterConfig config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/soap",
                    "synthetic-user", "synthetic-password", "synthetic-token", 0, "127.0.0.1",
                    Duration.ofSeconds(2), Duration.ofSeconds(2), 3600, 7200, 1, "ja", "4.0.0.0", temp, 1024 * 1024);
            ArcSuiteSoapClient client = new ArcSuiteSoapClient(config);
            for (String operation : List.of("searchRepositoryObjectIds", "listRepositoryObjectIds")) {
                Map<String, Object> request = operation.startsWith("search")
                        ? Map.of("limit", 1)
                        : Map.of("locationId", "rep:mock:EXAMPLE_CABINET", "limit", 1);
                response.set(idResponse(operation, "<t:id>rep:example:one</t:id>"));
                if (!List.of("rep:example:one").equals(callIds(client, operation, request))) throw new AssertionError(operation + " one-ID response");
                response.set(idResponse(operation, "<t:id>rep:example:one</t:id><t:id>rep:example:two</t:id>"));
                if (!List.of("rep:example:one", "rep:example:two").equals(callIds(client, operation, request))) throw new AssertionError(operation + " multiple-ID response");
                response.set(idResponse(operation, ""));
                if (!List.<String>of().equals(callIds(client, operation, request))) throw new AssertionError(operation + " empty-ID response");

                List<String> malformed = List.of(
                        "<t:otherResponse><t:" + operation + "Return><t:result><t:ids><t:id>rep:example:one</t:id></t:ids></t:result></t:" + operation + "Return></t:otherResponse>",
                        "<t:" + operation + "Response><t:result><t:ids><t:id>rep:example:one</t:id></t:ids></t:result></t:" + operation + "Response>",
                        "<t:" + operation + "Response><t:" + operation + "Return><t:result><t:ids><t:string>rep:example:one</t:string></t:ids></t:result></t:" + operation + "Return></t:" + operation + "Response>",
                        idResponse(operation, "<t:id><t:value>rep:example:one</t:value></t:id>"),
                        idResponse(operation, "<t:id> </t:id>"),
                        idResponse(operation, "<t:id>not-a-repository-id</t:id>"),
                        idResponse(operation, "<t:id>rep:example:one</t:id><t:id>rep:example:one</t:id>"),
                        idResponse(operation, "<t:id>rep:example:one</t:id><t:id>not-a-repository-id</t:id>"),
                        idResponse(operation, "<t:id>rep:example:one</t:id><t:id>rep:example:one</t:id><t:id>rep:example:two</t:id>"));
                for (String invalid : malformed) {
                    response.set(invalid);
                    expectAdapterFailure(() -> callIds(client, operation, request), "ARCSUITE_UPSTREAM_ERROR");
                }
            }
        } finally {
            server.stop(0);
            Files.deleteIfExists(temp);
        }
    }

    private static String idResponse(String operation, String ids) {
        return "<t:" + operation + "Response><t:" + operation + "Return>" + ids
                + "</t:" + operation + "Return></t:" + operation + "Response>";
    }

    private static List<String> callIds(ArcSuiteSoapClient client, String operation, Map<String, Object> request) {
        return operation.startsWith("search") ? client.searchIds(request, "synthetic-session") : client.listIds(request, "synthetic-session");
    }

    static void revisionContractParsing() throws Exception {
        if (ArcSuiteSoapClient.revisionNumber(1) != 1
                || ArcSuiteSoapClient.revisionNumber(ArcSuiteSoapClient.MAX_REVISION_NUMBER) != ArcSuiteSoapClient.MAX_REVISION_NUMBER) {
            throw new AssertionError("revision range endpoints changed");
        }
        for (Object invalid : List.of(0, -1, 2147483648L, 4294967297L)) {
            expectIllegalArgument(() -> ArcSuiteSoapClient.revisionNumber(invalid));
        }

        AtomicReference<String> response = new AtomicReference<>();
        AtomicInteger calls = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/soap", exchange -> {
            calls.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            byte[] bytes = soapEnvelope(response.get()).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        Path temp = Files.createTempDirectory("arcsuite-revision-contract-");
        try {
            AdapterConfig config = new AdapterConfig(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/soap",
                    "synthetic-user", "synthetic-password", "synthetic-token", 0, "127.0.0.1",
                    Duration.ofSeconds(2), Duration.ofSeconds(2), 3600, 7200, 1, "ja", "4.0.0.0", temp, 1024 * 1024);
            ArcSuiteSoapClient client = new ArcSuiteSoapClient(config);
            String revisionObject = "<t:repositoryObject><t:id>rep:mock:EXAMPLE_CABINET:1001</t:id>"
                    + "<t:objectClass ns=\"rep\" name=\"system:document\"/><t:attributes/></t:repositoryObject>";

            response.set("<t:listRepositoryObjectRevisionsResponse><t:listRepositoryObjectRevisionsReturn/></t:listRepositoryObjectRevisionsResponse>");
            if (!List.of().equals(client.revisions(Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "attrIds", List.of(), "options", List.of()), "synthetic-session"))) {
                throw new AssertionError("valid empty revision history was not preserved");
            }
            response.set("<t:listRepositoryObjectRevisionsResponse><t:listRepositoryObjectRevisionsReturn>"
                    + revisionObject + "</t:listRepositoryObjectRevisionsReturn></t:listRepositoryObjectRevisionsResponse>");
            if (client.revisions(Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "attrIds", List.of(), "options", List.of()), "synthetic-session").size() != 1) {
                throw new AssertionError("valid revision object was not parsed");
            }
            response.set("<w:listRepositoryObjectRevisionsResponse xmlns:w=\"urn:wrong\"><w:listRepositoryObjectRevisionsReturn/></w:listRepositoryObjectRevisionsResponse>");
            expectAdapterFailure(() -> client.revisions(Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "attrIds", List.of(), "options", List.of()), "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            for (String invalid : List.of(
                    "<t:listRepositoryObjectRevisionsResponse/>",
                    "<t:listRepositoryObjectRevisionsResponse><t:listRepositoryObjectRevisionsReturn><t:result/></t:listRepositoryObjectRevisionsReturn></t:listRepositoryObjectRevisionsResponse>",
                    "<t:listRepositoryObjectRevisionsResponse><t:listRepositoryObjectRevisionsReturn><t:repositoryObject><t:id>rep:mock:EXAMPLE_CABINET:1001</t:id><t:objectClass ns=\"rep\" name=\"system:document\"/></t:repositoryObject></t:listRepositoryObjectRevisionsReturn></t:listRepositoryObjectRevisionsResponse>")) {
                response.set(invalid);
                expectAdapterFailure(() -> client.revisions(Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "attrIds", List.of(), "options", List.of()), "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            }

            Map<String, Object> maxRequest = Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "revisionNumber", ArcSuiteSoapClient.MAX_REVISION_NUMBER, "attrIds", List.of(), "options", List.of());
            response.set("<t:getRepositoryObjectByRevisionNumberResponse><t:getRepositoryDocumentByRevisionNubmerReturn>"
                    + "<t:id>rep:mock:EXAMPLE_CABINET:1001:2147483647</t:id><t:objectClass ns=\"rep\" name=\"system:document\"/><t:attributes/>"
                    + "</t:getRepositoryDocumentByRevisionNubmerReturn></t:getRepositoryObjectByRevisionNumberResponse>");
            Map<String, Object> returned = client.get(maxRequest, "synthetic-session");
            if (!"rep:mock:EXAMPLE_CABINET:1001:2147483647".equals(returned.get("id"))
                    || !"rep:mock:EXAMPLE_CABINET:1001".equals(returned.get("effectiveId"))) throw new AssertionError("WSDL revision Return was not accepted");

            String mismatchedRevisionObject = revisionObject.replace("1001", "9999");
            response.set("<t:getRepositoryObjectByRevisionNumberResponse><t:getRepositoryDocumentByRevisionNubmerReturn>"
                    + mismatchedRevisionObject
                    + "</t:getRepositoryDocumentByRevisionNubmerReturn></t:getRepositoryObjectByRevisionNumberResponse>");
            expectAdapterFailure(() -> client.get(Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "revisionNumber", 1,
                    "resolveRef", true, "attrIds", List.of(), "options", List.of()), "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");

            response.set("<t:getRepositoryObjectByRevisionNumberResponse><t:getRepositoryObjectByRevisionNumberReturn>"
                    + revisionObject + "</t:getRepositoryObjectByRevisionNumberReturn></t:getRepositoryObjectByRevisionNumberResponse>");
            expectAdapterFailure(() -> client.get(maxRequest, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");
            response.set("<t:getRepositoryObjectByRevisionNumberResponse><t:getRepositoryDocumentByRevisionNubmerReturn>"
                    + "<t:id>rep:mock:EXAMPLE_CABINET:1001</t:id><t:objectClass ns=\"rep\" name=\"system:document\"/>"
                    + "</t:getRepositoryDocumentByRevisionNubmerReturn></t:getRepositoryObjectByRevisionNumberResponse>");
            expectAdapterFailure(() -> client.get(maxRequest, "synthetic-session"), "ARCSUITE_UPSTREAM_ERROR");

            int callsBeforeOverflow = calls.get();
            expectIllegalArgument(() -> client.get(Map.of("id", "rep:mock:EXAMPLE_CABINET:1001", "revisionNumber", 2147483648L, "attrIds", List.of(), "options", List.of()), "synthetic-session"));
            if (calls.get() != callsBeforeOverflow) throw new AssertionError("out-of-range revision reached SOAP dispatch");

            response.set("<soap:Fault><faultcode>soap:Server</faultcode><faultstring>ARCSUITE_WS-08305028</faultstring></soap:Fault>");
            expectAdapterFailure(() -> client.get(maxRequest, "synthetic-session"), "ARCSUITE_NOT_AVAILABLE");
        } finally {
            server.stop(0);
            Files.deleteIfExists(temp);
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
