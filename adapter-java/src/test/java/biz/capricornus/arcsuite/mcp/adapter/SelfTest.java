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

        var independentCipher = Cipher.getInstance("RSA/ECB/PKCS1Padding"); // lgtm[java/rsa-without-oaep]
        independentCipher.init(Cipher.DECRYPT_MODE, pair.getPrivate());
        byte[] plain = independentCipher.doFinal(ciphertext);
        if (!java.util.Arrays.equals(expected, plain)) {
            throw new AssertionError("Credential plaintext did not preserve UTF-8 challenge/password concatenation");
        }
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
