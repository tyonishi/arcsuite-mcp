package biz.capricornus.arcsuite.mcp.adapter;

import javax.crypto.Cipher;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
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
    }

    static byte[] unsigned(byte[] b) {
        if (b.length > 1 && b[0] == 0) return java.util.Arrays.copyOfRange(b,1,b.length);
        return b;
    }
}
