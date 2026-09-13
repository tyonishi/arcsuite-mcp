package biz.capricornus.arcsuite.mcp.adapter;

import javax.crypto.Cipher;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.util.Base64;
import java.util.List;
import java.util.Map;

public final class SelfTest {
    public static void main(String[] args) throws Exception {
        jsonRoundTrip();
        cryptoRoundTrip();
        mtomDecode();
        soapRequestShapes();
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
