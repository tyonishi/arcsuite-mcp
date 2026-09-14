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

        // codeql[java/rsa-without-oaep]
        var independentCipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
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
